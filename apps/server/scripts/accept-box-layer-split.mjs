// Real-image acceptance for the box-selection layer split.
//
// Preflight (no model call) always runs. The paid submission requires an explicit
// --submit because it makes exactly two real image calls: the framed element and
// the repaired background. Nothing here retries, so a provider fault can never
// spend a second time by accident.
//
//   node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx \
//     scripts/accept-box-layer-split.mjs --region=0.30,0.43,0.31,0.25
//   ... add --submit to actually spend the two calls.
//   ... or --audit-only=<jobId> to re-verify a job that already spent them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(new URL("../package.json", import.meta.url));
const sharp = require("sharp");

assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421", "This acceptance only runs against the local replica");
const argument = (name) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const regionArgument = argument("region");
const submit = process.argv.includes("--submit");
// Re-audit a job that already spent its calls instead of submitting a new one.
const auditOnly = argument("audit-only");
if (!auditOnly) assert(regionArgument, "--region=x,y,width,height (normalized) is required");
const sourcePath = argument("source")
  ?? fileURLToPath(new URL("../../../apps/web/public/images/showcase/showcase-3.jpg", import.meta.url));
const ownerId = "541006fa-d2a1-4305-be55-b6263c27a1e3";
const workspaceId = "25eb32ef-ff55-4de7-8c10-9390a51ece06";
const outputDirectory = fileURLToPath(new URL("../../../artifacts/real-image-acceptance/", import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const account = await admin.auth.admin.getUserById(ownerId);
assert.ifError(account.error);
const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
assert.ifError(link.error);
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const login = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
assert.ifError(login.error);
const token = login.data.session.access_token;
const api = async (method, route, body) => {
  const response = await fetch(`http://127.0.0.1:3002${route}`, { method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  // Read the body only on failure: an eagerly built message would consume it.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    assert.fail(`${method} ${route} failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
};

// ── Preflight: no model call ────────────────────────────────────────────────
const health = await (await fetch("http://127.0.0.1:3002/api/health", { signal: AbortSignal.timeout(10_000) })).json();
assert.equal(health.ok, true);
const quote = await api("GET", "/api/images/semantic-layer-backend?layer_count=1");
assert.equal(quote.available, true, "The published semantic layer model must be available");
assert.equal(quote.calls, 2, "A framed element plus its repaired background is exactly two paid calls");
assert.equal(quote.layerCount, 1);
assert.equal(quote.quality, "standard");
assert.equal(quote.resolution, "1k");
const active = await admin.from("background_jobs").select("id", { count: "exact" })
  .eq("workspace_id", workspaceId).eq("job_type", "image_generation").in("status", ["queued", "running"]);
assert.ifError(active.error);
const preflight = { kind: "box_layer_split_preflight", createdAt: new Date().toISOString(),
  apiHealth: health.ok, quote, activeImageJobs: active.count ?? 0,
  region: regionArgument ?? "from audit target", sourcePath, auditOnly: auditOnly ?? null, submitRequested: submit };
console.log(JSON.stringify(preflight, null, 2));

/**
 * Verifies one completed job against the real database, storage and pixels. It
 * reads the frozen request from the row itself, so it can be re-run on any job
 * without spending another call.
 */
async function auditJob(jobRow, { sourcePng, elementsBefore }) {
  const region = jobRow.payload?.selection_region;
  const regionValues = [region?.x, region?.y, region?.width, region?.height];
  assert(regionValues.every(value => Number.isFinite(value) && value >= 0 && value <= 1),
    "The audited job must carry a normalized selection region");
  // The canvas lives in the normalized target; the legacy column stays null for
  // jobs submitted with an explicit canvas_id.
  const canvasId = jobRow.payload?.target?.canvas_id ?? jobRow.canvas_id;
  assert(typeof canvasId === "string" && canvasId.length > 0, "The audited job must carry its canvas target");
  const report = { kind: "box_layer_split_acceptance", createdAt: new Date().toISOString(), jobId: jobRow.id,
    canvasId, region, model: jobRow.payload?.model, quotedCalls: quote.calls, quotedCredits: quote.credits,
    status: jobRow.status, errorCode: jobRow.error_code ?? null, errorMessage: jobRow.error_message ?? null };

  if (jobRow.status !== "succeeded") {
    report.verified = false;
    await writeFile(`${outputDirectory}box-split-acceptance-${stamp}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert.fail(`Box split job ${jobRow.status}: ${jobRow.error_message ?? "no message"}`);
  }

  // The frozen request is what was actually paid for.
  assert.equal(jobRow.payload.quality, "standard");
  assert.equal(jobRow.payload.resolution, "1k");
  assert.equal(jobRow.payload.layer_backend, "semantic");
  assert.deepEqual(jobRow.payload.layer_names, ["框选元素"]);
  assert.equal(jobRow.payload.repair_background, true);
  assert.equal(jobRow.payload.model, quote.model);

  // Exactly two provider calls: one archived source per stage, and no third.
  const generated = await admin.storage.from("workspace-assets")
    .list(`${workspaceId}/generated`, { limit: 1000 });
  assert.ifError(generated.error);
  const stageArchives = [0, 1, 2].map(index => {
    const name = `${jobRow.id}-semantic-layer-stage-${index}-source.png`;
    return { name, present: (generated.data ?? []).some(row => row.name === name) };
  });
  report.providerCalls = { stageArchives,
    callsExpected: 2, callsEvidenced: stageArchives.filter(row => row.present).length,
    thirdStageAbsent: !stageArchives[2].present };
  assert.equal(stageArchives[0].present, true, "The element stage must be archived");
  assert.equal(stageArchives[1].present, true, "The repaired background stage must be archived");
  assert.equal(stageArchives[2].present, false, "No third paid stage may exist");

  const layers = jobRow.result?.layers ?? [];
  assert.equal(layers.length, 2, "A framed element split delivers exactly two layers");
  const background = layers.find(layer => layer.kind === "background");
  const element = layers.find(layer => layer.kind === "element");
  assert(background && element, "One repaired background and one element are required");
  assert.equal(element.name, "框选元素");
  const sourceImage = await sharp(sourcePng).metadata();
  assert(sourceImage.width && sourceImage.height);
  assert.equal(background.width, sourceImage.width, "The repaired background keeps the source framing");
  assert.equal(background.height, sourceImage.height);
  assert.equal(jobRow.result.source_width, sourceImage.width);
  assert.equal(jobRow.result.source_height, sourceImage.height);

  const download = async (layer) => {
    assert.ok(layer.signed_url, "Every delivered layer must be readable through its signed URL");
    const response = await fetch(layer.signed_url, { signal: AbortSignal.timeout(60_000) });
    assert.ok(response.ok, `Layer download failed with HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const backgroundBuffer = await download(background);
  const elementBuffer = await download(element);
  const elementCopy = `${outputDirectory}box-split-element-${stamp}.png`;
  const backgroundCopy = `${outputDirectory}box-split-background-${stamp}.png`;
  await writeFile(elementCopy, elementBuffer);
  await writeFile(backgroundCopy, backgroundBuffer);
  report.artifacts = { element: elementCopy, background: backgroundCopy };

  // The element must be a genuine cutout that stays inside the framed region.
  const elementMeta = await sharp(elementBuffer).metadata();
  assert.equal(elementMeta.hasAlpha, true, "The extracted element must carry alpha");
  const alpha = await sharp(elementBuffer).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const transparent = [...alpha].filter(value => value < 8).length;
  const opaque = [...alpha].filter(value => value >= 248).length;
  assert.ok(opaque > 0, "The element must contain opaque pixels");
  assert.ok(transparent > 0, "The element must contain genuine transparent pixels");
  const padX = Math.max(2, Math.round(region.width * sourceImage.width * 0.06));
  const padY = Math.max(2, Math.round(region.height * sourceImage.height * 0.06));
  const frame = { left: Math.max(0, Math.round(region.x * sourceImage.width) - padX),
    top: Math.max(0, Math.round(region.y * sourceImage.height) - padY),
    right: Math.min(sourceImage.width, Math.round((region.x + region.width) * sourceImage.width) + padX),
    bottom: Math.min(sourceImage.height, Math.round((region.y + region.height) * sourceImage.height) + padY) };
  assert.ok(element.x >= frame.left && element.y >= frame.top
    && element.x + element.width <= frame.right && element.y + element.height <= frame.bottom,
    `Extracted element ${JSON.stringify(element)} must stay inside the framed region ${JSON.stringify(frame)}`);
  report.element = { x: element.x, y: element.y, width: element.width, height: element.height,
    transparentPixels: transparent, opaquePixels: opaque, totalPixels: element.width * element.height,
    transparencyRatio: Number((transparent / (element.width * element.height)).toFixed(4)),
    insideFramedRegion: true, hasAlpha: true };

  // The repair may only touch the element's own pixels plus its soft edge. The
  // composite mask is the element's alpha, whose feather (alpha 1..7) sits a
  // pixel or two outside the delivered crop, so a hairline ring of rounding-level
  // differences is expected there and nowhere else.
  const sourceRaw = await sharp(sourcePng).ensureAlpha().raw().toBuffer();
  const backgroundRaw = await sharp(backgroundBuffer).ensureAlpha().raw().toBuffer();
  assert.equal(backgroundRaw.length, sourceRaw.length);
  const feather = 2;
  const ring = { left: element.x - feather, top: element.y - feather,
    right: element.x + element.width + feather, bottom: element.y + element.height + feather };
  let insideChanged = 0;
  let featherChanged = 0;
  let outsideChanged = 0;
  let maxOutsideDelta = 0;
  let alphaChanged = 0;
  for (let y = 0; y < sourceImage.height; y += 1) {
    for (let x = 0; x < sourceImage.width; x += 1) {
      const offset = (y * sourceImage.width + x) * 4;
      const channelDelta = [0, 1, 2].map(channel =>
        Math.abs((sourceRaw[offset + channel] ?? 0) - (backgroundRaw[offset + channel] ?? 0)));
      if ((sourceRaw[offset + 3] ?? 0) !== (backgroundRaw[offset + 3] ?? 0)) alphaChanged += 1;
      if (channelDelta.every(value => value === 0)) continue;
      const inElement = x >= element.x && x < element.x + element.width
        && y >= element.y && y < element.y + element.height;
      const inRing = x >= ring.left && x < ring.right && y >= ring.top && y < ring.bottom;
      if (inElement) insideChanged += 1;
      else if (inRing) { featherChanged += 1; maxOutsideDelta = Math.max(maxOutsideDelta, ...channelDelta); }
      else { outsideChanged += 1; maxOutsideDelta = Math.max(maxOutsideDelta, ...channelDelta); }
    }
  }
  assert.equal(alphaChanged, 0, "The repair must not change any alpha channel");
  assert.equal(outsideChanged, 0, `No pixel beyond the element's ${feather}px soft edge may change`);
  assert.ok(maxOutsideDelta <= 8, `Outside the element only feather rounding is allowed, saw ${maxOutsideDelta}/255`);
  assert.ok(insideChanged > 0, "The repair must actually reconstruct the pixels the element occupied");
  report.backgroundRepair = { elementFeatherPixels: feather,
    insideElementChangedPixels: insideChanged,
    insideElementChangedRatio: Number((insideChanged / (element.width * element.height)).toFixed(4)),
    featherRingChangedPixels: featherChanged, featherRingMaxDelta: maxOutsideDelta,
    beyondFeatherChangedPixels: outsideChanged, alphaChannelChangedPixels: alphaChanged };

  // Canvas delivery: both layers arrive as real image elements. The element's
  // customData (and its file entry) carry the asset id, not the Excalidraw file id.
  const canvas = await admin.from("canvases").select("content").eq("id", canvasId).single();
  assert.ifError(canvas.error);
  const files = canvas.data.content?.files ?? {};
  const elements = (canvas.data.content?.elements ?? []).filter(candidate => !candidate.isDeleted);
  const deliveredAssetIds = layers.map(layer => layer.asset_id);
  const assetIdOf = candidate => candidate.customData?.assetId ?? files[candidate.fileId]?.assetId;
  const delivered = elements.filter(candidate => deliveredAssetIds.includes(assetIdOf(candidate)));
  report.canvas = { elementsBefore, elementsAfter: elements.length, deliveredElements: delivered.length,
    deliveredAssetIds, deliveredElementAssetIds: delivered.map(assetIdOf),
    elementIds: delivered.map(candidate => candidate.id),
    finalizedAt: jobRow.result?.canvas_finalized_at ?? null };
  assert.equal(delivered.length, 2, "The canvas must reference both delivered assets");

  // Local billing: two calls, one deduction, no duplicate charge.
  const ledger = await admin.from("credit_transactions").select("transaction_type,amount")
    .eq("job_id", jobRow.id).eq("workspace_id", workspaceId);
  assert.ifError(ledger.error);
  const deductions = (ledger.data ?? []).filter(row => row.transaction_type === "generation_deduct");
  assert.ok(deductions.length <= 1, "No duplicate local deduction is permitted");
  const deducted = deductions.reduce((sum, row) => sum - row.amount, 0);
  report.billing = { creditsCost: jobRow.credits_cost ?? 0, quotedCredits: quote.credits,
    deductionRows: deductions.length, localCreditsDeducted: deducted };
  assert.equal(jobRow.credits_cost ?? 0, quote.credits, "The charged credits must equal the quote");
  assert.equal(deducted, jobRow.credits_cost ?? 0);

  report.verified = true;
  report.browserVisualVerified = false;
  report.note = "Provider call count is evidenced by the per-stage archives. Visual quality is judged from the copied element and background images; no browser render was performed.";
  const reportPath = `${outputDirectory}box-split-acceptance-${stamp}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Box-selection split acceptance passed: ${reportPath}`);
  return report;
}

if (auditOnly) {
  const row = await admin.from("background_jobs").select("*").eq("id", auditOnly).single();
  assert.ifError(row.error);
  assert(row.data, `Job ${auditOnly} not found`);
  const dataUri = row.data.payload?.input_images?.[0] ?? "";
  assert(dataUri.startsWith("data:image/"), "The audited job must carry its source image in the payload");
  const sourcePng = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  await auditJob(row.data, { sourcePng, elementsBefore: null });
  process.exit(0);
}

if (!submit) {
  const path = `${outputDirectory}box-split-preflight-${stamp}.json`;
  await writeFile(path, JSON.stringify(preflight, null, 2));
  console.log(`Preflight only (no model call). Report: ${path}`);
  process.exit(0);
}
assert.equal(active.count ?? 0, 0, "No other image job may be running while the paid acceptance spends calls");

// ── Paid submission: exactly one job, exactly two image calls ───────────────
const [regionX, regionY, regionWidth, regionHeight] = regionArgument.split(",").map(Number);
assert([regionX, regionY, regionWidth, regionHeight].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
  && regionWidth > 0 && regionHeight > 0, "Invalid --region");
const sourcePng = await sharp(sourcePath).rotate().png().toBuffer();
const { project } = await api("POST", "/api/projects", { name: `框选剥离真实验收 ${Date.now()}` });
const canvasId = project.primaryCanvas.id;
const canvasBefore = await admin.from("canvases").select("content").eq("id", canvasId).single();
assert.ifError(canvasBefore.error);
const elementsBefore = (canvasBefore.data.content?.elements ?? []).filter(element => !element.isDeleted).length;

const { job } = await api("POST", "/api/jobs/image-generation", {
  project_id: project.id,
  canvas_id: canvasId,
  prompt: "提取框选的这个元素，并把原图背景修补完整",
  operation: "split_layers",
  model: quote.model,
  layer_backend: "semantic",
  layer_names: ["框选元素"],
  repair_background: true,
  selection_region: { x: regionX, y: regionY, width: regionWidth, height: regionHeight },
  quality: "standard",
  resolution: "1k",
  input_images: [`data:image/png;base64,${sourcePng.toString("base64")}`],
});
console.log(`Submitted box split job ${job.id} (two paid calls, no retry)`);

let current = job;
for (let attempt = 0; attempt < 240; attempt += 1) {
  ({ job: current } = await api("GET", `/api/jobs/${job.id}`));
  if (["succeeded", "failed", "dead_letter", "canceled"].includes(current.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
await auditJob(current, { sourcePng, elementsBefore });
