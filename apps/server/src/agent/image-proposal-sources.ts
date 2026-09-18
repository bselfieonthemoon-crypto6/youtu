import { createHash } from "node:crypto";
import { isUuid } from "@loomic/shared";
import { resolveAgentImageAttachment } from "./attachment-resolver.js";

export type ImageProposalSource = { assetId: string; referenceHash: string };
export const imageReferenceHash = (reference: string) => createHash("sha256").update(reference).digest("hex");

/** Only the server's authenticated original-attachment map may establish the
 * identity of a model reference. Never infer IDs from an arbitrary URL. */
export function captureImageProposalSources(references: readonly string[] | undefined, attachmentMap: Record<string, string> | undefined): ImageProposalSource[] | undefined {
  if (!references?.length || !attachmentMap) return;
  const sources: ImageProposalSource[] = [];
  for (const reference of references) {
    const direct: string | undefined = Object.prototype.hasOwnProperty.call(attachmentMap, reference) ? reference : undefined;
    const matches: string[] = direct ? [direct] : Object.keys(attachmentMap).filter(id => attachmentMap[id] === reference);
    const assetId: string | undefined = matches.length === 1 ? matches[0] : undefined;
    if (!assetId || !isUuid(assetId)) return;
    const resolved = attachmentMap[assetId];
    if (!resolved || !/^(?:data:image\/|https?:\/\/)/.test(resolved)) return;
    sources.push({ assetId, referenceHash: imageReferenceHash(resolved) });
  }
  return sources;
}

/** Resolve only explicitly requested asset IDs that are present on the current
 * authenticated canvas. This establishes source identity/bytes, not user
 * intent: the independent intent gate must already have bound each canvas
 * object to current user evidence before the image tool is reached. */
export async function resolveCanvasImageProposalSources(input: {
  client: any;
  canvasId: string;
  references: readonly string[];
}): Promise<Record<string, string>> {
  const requested = [...new Set(input.references.filter(isUuid))];
  if (!requested.length) return {};
  const { data, error } = await input.client.from("canvases").select("content").eq("id", input.canvasId).single();
  if (error || !data?.content || !Array.isArray(data.content.elements)) throw new Error("canvas_reference_unavailable");
  const content = data.content as { elements: Array<Record<string, any>>; files?: Record<string, Record<string, any>> };
  const liveAssetIds = new Set(content.elements.flatMap(element => {
    if (!element || element.isDeleted === true) return [];
    const fileAssetId = typeof element.fileId === "string" ? content.files?.[element.fileId]?.assetId : undefined;
    const assetId = element.customData?.assetId ?? element.assetId ?? fileAssetId;
    return isUuid(assetId) ? [assetId] : [];
  }));
  const result: Record<string, string> = {};
  for (const assetId of requested) {
    if (!liveAssetIds.has(assetId)) throw new Error("canvas_reference_not_found");
    const resolved = await resolveAgentImageAttachment({ client: input.client,
      attachment: { assetId, url: "", mimeType: "image/png" }, canvasContent: content });
    result[assetId] = `data:${resolved.mimeType};base64,${resolved.buffer.toString("base64")}`;
  }
  return result;
}

/** Recheck current asset access and exact original identity at confirmation.
 * No cached permission decision, no provider call, no reviewer-visible bytes. */
export async function verifyImageProposalSources(client: any, input: { inputImages?: string[]; inputImageSources?: ImageProposalSource[] }): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      verifySources(client, input, controller.signal),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("image_proposal_source_timeout")); }, 10_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function verifySources(client: any, input: { inputImages?: string[]; inputImageSources?: ImageProposalSource[] }, signal: AbortSignal): Promise<string[]> {
  const assertActive = () => { if (signal.aborted) throw new Error("image_proposal_source_timeout"); };
  // The SDK does not expose cancellation here. Prevent all subsequent reads
  // after the deadline, including a resolver query's late storage continuation.
  const boundedClient = { from: (table: string) => { assertActive(); return client.from(table); },
    storage: { from: (bucket: string) => { assertActive(); return client.storage.from(bucket); } } };
  const references = input.inputImages ?? [];
  if (!references.length) return [];
  const bindings = input.inputImageSources;
  if (!bindings || bindings.length !== references.length) throw new Error("image_proposal_source_binding_missing");
  const ids: string[] = [];
  for (const [index, reference] of references.entries()) {
    assertActive();
    const binding = bindings[index]!;
    if (!isUuid(binding.assetId) || binding.referenceHash !== imageReferenceHash(reference)) throw new Error("image_proposal_source_binding_changed");
    const { data: asset, error } = await client.from("asset_objects")
      .select("id,bucket,object_path,mime_type,deletion_pending_at").eq("id", binding.assetId).single();
    assertActive();
    if (error || !asset || asset.id !== binding.assetId || asset.deletion_pending_at || typeof asset.bucket !== "string" || typeof asset.object_path !== "string")
      throw new Error("image_proposal_source_unavailable");
    if (reference.startsWith("data:image/")) {
      // Reuse the bounded RLS + Storage original reader (20 MB and image MIME
      // checks). Runtime built this exact canonical URI from the original.
      const original = await resolveAgentImageAttachment({ client: boundedClient, attachment: {
        assetId: binding.assetId, url: reference, mimeType: asset.mime_type ?? "image/png",
      } });
      assertActive();
      if (imageReferenceHash(`data:${original.mimeType};base64,${original.buffer.toString("base64")}`) !== binding.referenceHash)
        throw new Error("image_proposal_source_changed");
    } else {
      // Verify an explicitly bound URL against this asset's canonical signed
      // storage path; URL text alone never establishes an asset identity.
      const { data, error: signError } = await client.storage.from(asset.bucket).createSignedUrl(asset.object_path, 60);
      assertActive();
      if (signError || !data?.signedUrl) throw new Error("image_proposal_source_unavailable");
      const expected = new URL(data.signedUrl);
      const actual = new URL(reference);
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password || actual.hash
        || [...actual.searchParams.keys()].some(key => key !== "token") || actual.searchParams.getAll("token").length > 1)
        throw new Error("image_proposal_source_changed");
    }
    ids.push(binding.assetId);
  }
  return ids;
}
