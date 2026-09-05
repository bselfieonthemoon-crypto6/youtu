import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");
const deletePublicCopies = process.argv.includes("--delete-public-copies");
const verify = process.argv.includes("--verify");

function readEnv(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const env = readEnv(new URL("../.env.local", import.meta.url));
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: assets, error: listError } = await client
  .from("asset_objects")
  .select("id, bucket, object_path, mime_type")
  .in("bucket", ["project-assets", "workspace-assets"])
  .order("created_at", { ascending: true });

if (listError) throw listError;

const pending = (assets ?? []).filter((asset) => asset.bucket === "project-assets");
const privateAssets = (assets ?? []).filter((asset) => asset.bucket === "workspace-assets");
console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  pending: pending.length,
  private: privateAssets.length,
  deletePublicCopies,
}));

if (verify && privateAssets.length > 0) {
  const sample = privateAssets[0];
  const signed = await client.storage
    .from("workspace-assets")
    .createSignedUrl(sample.object_path, 60);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`Unable to sign private asset ${sample.id}: ${signed.error?.message ?? "missing URL"}`);
  }
  const response = await fetch(signed.data.signedUrl, {
    headers: { Range: "bytes=0-0" },
  });
  if (!response.ok) {
    throw new Error(`Signed private asset verification failed with HTTP ${response.status}.`);
  }
  console.log(JSON.stringify({ signedPrivateAssetVerified: true, status: response.status }));
}

if (!apply) process.exit(0);

let migrated = 0;
let cleanedLegacyCopies = 0;

for (const asset of assets ?? []) {
  if (asset.bucket === "project-assets") {
    const source = await client.storage.from("project-assets").download(asset.object_path);
    if (source.error || !source.data) {
      throw new Error(`Unable to read legacy asset ${asset.id}: ${source.error?.message ?? "missing"}`);
    }

    const bytes = Buffer.from(await source.data.arrayBuffer());
    const uploaded = await client.storage.from("workspace-assets").upload(asset.object_path, bytes, {
      contentType: asset.mime_type ?? source.data.type ?? "application/octet-stream",
      upsert: true,
    });
    if (uploaded.error) {
      throw new Error(`Unable to copy legacy asset ${asset.id}: ${uploaded.error.message}`);
    }

    const updated = await client
      .from("asset_objects")
      .update({ bucket: "workspace-assets" })
      .eq("id", asset.id)
      .eq("bucket", "project-assets")
      .select("id")
      .single();
    if (updated.error || !updated.data) {
      throw new Error(`Unable to switch asset metadata ${asset.id}: ${updated.error?.message ?? "not updated"}`);
    }
    migrated += 1;
  }

  if (deletePublicCopies) {
    // Safe on retries: every workspace-assets row should have no public twin.
    const removed = await client.storage.from("project-assets").remove([asset.object_path]);
    if (removed.error) {
      throw new Error(`Unable to remove legacy copy ${asset.id}: ${removed.error.message}`);
    }
    cleanedLegacyCopies += 1;
  }
}

console.log(JSON.stringify({ migrated, cleanedLegacyCopies }));
