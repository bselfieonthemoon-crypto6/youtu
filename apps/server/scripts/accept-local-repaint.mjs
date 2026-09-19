// Real-image acceptance for the canvas local repaint (局部重绘).
//
// Preflight (no model call) always runs. The paid submission requires an explicit
// --submit because it makes exactly one real image edit call with a mask. Nothing
// here retries, so a provider fault can never spend a second time by accident.
//
//   node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx \
//     scripts/accept-local-repaint.mjs --region=0.34,0.08,0.32,0.22
//   ... add --submit to actually spend the call.
//   ... or --audit-only=<jobId> to re-verify a job that already spent it.
//
// The canvas is prepared the way the browser does it: a source image element, a
// job-owned placeholder rectangle at the placement, then the repaint job with the
// same normalized-white mask `renderEraseMask` produces (black = preserve).
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
const auditOnly = argument("audit-only");
const modelArgument = argument("model");
if (!auditOnly) assert(regionArgument, "--region=x,y,width,height (normalized) is required");
const sourcePath = argument("source")
  ?? fileURLToPath(new URL("../../../apps/web/public/images/showcase/showcase-3.jpg", import.meta.url));
const prompt = argument("prompt") ?? "在涂抹区域内画一个鲜红色的实心圆形贴纸，其余内容保持不变";
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
const downloadObject = async (objectPath) => {
  const signed = await admin.storage.from("workspace-assets").createSignedUrl(objectPath, 600);
  assert.ifError(signed.error);
  const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `Download of ${objectPath} failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
/** The browser's renderEraseMask: opaque black canvas with an opaque white brush. */
const renderMask = async (region, width, height, brush = 0.055) => {
  const cx = Math.round((region.x + region.width / 2) * width);
  const cy = Math.round((region.y + region.height / 2) * height);
  const rx = Math.max(2, Math.round((region.width * width) / 2));
  const ry = Math.max(2, Math.round((region.height * height) / 2));
  const brushRadius = Math.round(brush * Math.min(width, height));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#ffffff"/>`
    + `<path d="M ${cx + brushRadius + 8} ${cy} L ${cx + brushRadius + 8} ${cy + 1}" stroke="#ffffff" stroke-width="${brushRadius * 2}" stroke-linecap="round"/></svg>`;
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
};

// ── Preflight: no model call ────────────────────────────────────────────────
const health = await (await fetch("http://127.0.0.1:3002/api/health", { signal: AbortSignal.timeout(10_000) })).json();
assert.equal(health.ok, true);
const modelList = await api("GET", "/api/image-models");
const accessible = (modelList.models ?? []).filter(model => model.accessible !== false);
// The canvas repaint uses the user's preferred model, or the first available one
// when no preference is stored. The preference lives in browser localStorage, so
// the default here is exactly that fallback unless --model pins another one.
const model = modelArgument ?? accessible[0]?.id;
assert(typeof model === "string" && model.length > 0, "No workspace image model is available");
const active = await admin.from("background_jobs").select("id", { count: "exact" })
  .eq("workspace_id", workspaceId).eq("job_type", "image_generation").in("status", ["queued", "running"]);
assert.ifError(active.error);
const preflight = { kind: "local_repaint_preflight", createdAt: new Date().toISOString(),
  apiHealth: health.ok, model, modelSource: modelArgument ? "argument" : "first accessible /api/image-models entry",
  availableModels: accessible.map(entry => ({ id: entry.id, displayName: entry.displayName, creditCost: entry.creditCost ?? null })),
  activeImageJobs: active.count ?? 0, region: regionArgument ?? "from audit target", prompt,
  sourcePath, auditOnly: auditOnly ?? null, submitRequested: submit };
console.log(JSON.stringify(preflight, null, 2));

/**
 * Verifies one completed repaint against the real database, storage and pixels.
 * It reads the frozen request from the row itself, so it can be re-run on any job
 * without spending another call.
 */
async function auditJob(jobRow) {
  // The canvas lives in the normalized target; the legacy column stays null for
  // jobs submitted with an explicit canvas_id.
  const canvasId = jobRow.payload?.target?.canvas_id ?? jobRow.canvas_id;
  assert(typeof canvasId === "string" && canvasId.length > 0, "The audited job must carry its canvas target");
  const target = jobRow.payload?.target ?? {};
  const placement = target.placement ?? {};
  const report = { kind: "local_repaint_acceptance", createdAt: new Date().toISOString(), jobId: jobRow.id,
    canvasId, model: jobRow.payload?.model, status: jobRow.status,
    errorCode: jobRow.error_code ?? null, errorMessage: jobRow.error_message ?? null,
    provider: jobRow.result?.provider ?? null, upstreamModel: jobRow.result?.upstream_model ?? null,
    providerAttemptCount: jobRow.result?.provider_attempt_count ?? null,
    providerFallbackUsed: jobRow.result?.provider_fallback_used ?? null };
  const finish = async (verified) => {
    report.verified = verified;
    const reportPath = `${outputDirectory}local-repaint-acceptance-${stamp}.json`;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`Local repaint acceptance report: ${reportPath}`);
  };

  if (jobRow.status !== "succeeded") {
    // A refusal is a result too: report the provider frame shape that caused it
    // instead of hiding it behind a generic failure.
    const failedSource = jobRow.payload?.input_images?.[0];
    let failedSourceSize;
    if (typeof failedSource === "string" && failedSource.startsWith("data:image/")) {
      const meta = await sharp(Buffer.from(failedSource.split(",")[1], "base64")).metadata();
      if (meta.width && meta.height) failedSourceSize = { width: meta.width, height: meta.height };
    }
    const frame = await readProviderFrame(jobRow.id, failedSourceSize);
    if (frame) report.providerFrame = frame;
    await finish(false);
    assert.fail(`Local repaint job ${jobRow.status}: ${jobRow.error_message ?? "no message"}`);
  }

  // The frozen request is what was actually paid for.
  const payload = jobRow.payload ?? {};
  assert.equal(payload.operation, "local_repaint");
  assert.equal(payload.model, model, "The paid job must use the model this acceptance chose");
  assert.equal(payload.quality, "standard");
  assert.equal(payload.resolution, undefined, "The canvas repaint must not pin a resolution");
  assert.ok(typeof payload.prompt === "string" && payload.prompt.trim().length > 0);
  assert.equal(payload.input_images?.length, 1, "A local repaint sends exactly one source image");
  assert.ok(typeof payload.mask_image === "string" && payload.mask_image.startsWith("data:image/png"),
    "A local repaint requires a PNG mask");
  assert.ok(Number.isFinite(placement.x) && Number.isFinite(placement.y)
    && Number.isFinite(placement.width) && Number.isFinite(placement.height),
    "The job must carry its canvas placement");
  report.request = { prompt: payload.prompt, aspectRatio: payload.aspect_ratio, placement,
    placeholderElementId: target.element_id ?? payload.placeholder_element_id ?? null };

  const sourceBuffer = Buffer.from(payload.input_images[0].split(",")[1], "base64");
  const maskBuffer = Buffer.from(payload.mask_image.split(",")[1], "base64");
  const sourceMeta = await sharp(sourceBuffer).metadata();
  assert(sourceMeta.width && sourceMeta.height, "The source image must be readable");
  const maskMeta = await sharp(maskBuffer).metadata();
  assert.equal(maskMeta.width, sourceMeta.width, "The submitted mask must match the source width");
  assert.equal(maskMeta.height, sourceMeta.height, "The submitted mask must match the source height");
  report.source = { width: sourceMeta.width, height: sourceMeta.height,
    ratio: Number((sourceMeta.width / sourceMeta.height).toFixed(6)),
    aspectRatioInRequest: payload.aspect_ratio };

  // Exactly one paid provider attempt: one claim/return checkpoint for attempt 0
  // and one archived provider frame, with no fallback attempt and no extra stage.
  const listed = await admin.storage.from("workspace-assets").list(`${workspaceId}/generated`, { limit: 1000 });
  assert.ifError(listed.error);
  const names = new Set((listed.data ?? []).map(row => row.name));
  const frameName = `${jobRow.id}-source-before-matting.png`;
  const callEvidence = {
    attemptCheckpoint: names.has(`${jobRow.id}-image-generation-checkpoint.json`),
    archivedProviderFrame: names.has(frameName),
    fallbackAttemptCheckpoint: names.has(`${jobRow.id}-image-generation-attempt-1-checkpoint.json`),
    backgroundRemovalCheckpoint: names.has(`${jobRow.id}-background-removal-checkpoint.json`),
    semanticStageArchives: [0, 1, 2].some(index => names.has(`${jobRow.id}-semantic-layer-stage-${index}-source.png`)),
  };
  report.providerCalls = { ...callEvidence, callsEvidenced: callEvidence.archivedProviderFrame ? 1 : 0 };
  assert.equal(callEvidence.attemptCheckpoint, true, "The single paid attempt must be archived");
  assert.equal(callEvidence.archivedProviderFrame, true, "The provider frame must be archived");
  assert.equal(callEvidence.fallbackAttemptCheckpoint, false, "No fallback provider attempt may exist");
  assert.equal(callEvidence.backgroundRemovalCheckpoint, false, "A local repaint must not run background removal");
  assert.equal(callEvidence.semanticStageArchives, false, "A local repaint must not run semantic layer stages");
  assert.equal(jobRow.result?.provider_attempt_count ?? 1, 1, "Exactly one provider attempt must be recorded");

  // The provider frame is the evidence behind the shape rule: the splice keeps the
  // model's proportional mapping only when the returned frame has the source shape.
  const frameReport = await readProviderFrame(jobRow.id, { width: sourceMeta.width, height: sourceMeta.height });
  assert(frameReport, "The archived provider frame must be downloadable");
  report.providerFrame = frameReport;
  assert.ok(frameReport.ratioRelativeError <= 0.01,
    `The provider returned ${frameReport.width}x${frameReport.height} (${frameReport.ratioRelativeError} relative error) `
    + `for a ${sourceMeta.width}x${sourceMeta.height} source; the compose would refuse this frame`);

  // The delivered image must be the source frame, byte-identical where the mask is
  // black and edited only where it is white.
  const objectPath = jobRow.result?.object_path;
  assert(typeof objectPath === "string", "The result must carry its object path");
  const delivered = await downloadObject(objectPath);
  const deliveredMeta = await sharp(delivered).metadata();
  assert.equal(deliveredMeta.width, sourceMeta.width, "The delivered image must keep the source width");
  assert.equal(deliveredMeta.height, sourceMeta.height, "The delivered image must keep the source height");
  assert.equal(jobRow.result?.width, sourceMeta.width);
  assert.equal(jobRow.result?.height, sourceMeta.height);

  const sourceRaw = await sharp(sourceBuffer).ensureAlpha().raw().toBuffer();
  const deliveredRaw = await sharp(delivered).ensureAlpha().raw().toBuffer();
  const maskRaw = await sharp(maskBuffer).removeAlpha().greyscale().raw().toBuffer();
  assert.equal(sourceRaw.length, deliveredRaw.length);
  assert.equal(maskRaw.length, sourceMeta.width * sourceMeta.height);
  let preservePixels = 0;
  let preserveViolations = 0;
  let editablePixels = 0;
  let editableChanged = 0;
  let alphaChanged = 0;
  let changedOutsideMask = 0;
  let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
  for (let index = 0; index < maskRaw.length; index += 1) {
    const offset = index * 4;
    const weight = maskRaw[index];
    const identical = sourceRaw[offset] === deliveredRaw[offset]
      && sourceRaw[offset + 1] === deliveredRaw[offset + 1]
      && sourceRaw[offset + 2] === deliveredRaw[offset + 2]
      && sourceRaw[offset + 3] === deliveredRaw[offset + 3];
    if (sourceRaw[offset + 3] !== deliveredRaw[offset + 3]) alphaChanged += 1;
    if (weight === 0) {
      preservePixels += 1;
      if (!identical) { preserveViolations += 1; changedOutsideMask += 1; }
      continue;
    }
    editablePixels += 1;
    if (identical) continue;
    editableChanged += 1;
    const x = index % sourceMeta.width;
    const y = Math.floor(index / sourceMeta.width);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  assert.equal(preserveViolations, 0, "Every mask=0 pixel must stay byte-identical to the source");
  assert.ok(editablePixels > 0, "The mask must cover pixels");
  assert.ok(editableChanged > 0, "The repaint must actually change the painted region");
  assert.equal(alphaChanged, 0, "An opaque source must stay opaque");
  report.pixels = { maskPreservePixels: preservePixels, maskPreserveViolations: preserveViolations,
    maskEditablePixels: editablePixels, maskEditableChangedPixels: editableChanged,
    maskEditableChangedRatio: Number((editableChanged / editablePixels).toFixed(4)),
    changedOutsideMask, alphaChanged,
    changedBoundingBox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };

  // Where the painted change landed: the visible edit must sit inside the painted
  // region, which is what "no stretch, no offset" means for the user.
  let maskMinX = Infinity; let maskMinY = Infinity; let maskMaxX = -1; let maskMaxY = -1;
  for (let index = 0; index < maskRaw.length; index += 1) {
    if (maskRaw[index] < 8) continue;
    const x = index % sourceMeta.width;
    const y = Math.floor(index / sourceMeta.width);
    if (x < maskMinX) maskMinX = x; if (x > maskMaxX) maskMaxX = x;
    if (y < maskMinY) maskMinY = y; if (y > maskMaxY) maskMaxY = y;
  }
  report.maskBounds = { x: maskMinX, y: maskMinY, width: maskMaxX - maskMinX + 1, height: maskMaxY - maskMinY + 1,
    pixels: editablePixels };
  // A strongly red area in the delivered image is the requested sticker. Report it
  // whenever the model followed the instruction; the placement check stays honest.
  let redPixels = 0; let redMinX = Infinity; let redMinY = Infinity; let redMaxX = -1; let redMaxY = -1;
  for (let index = 0; index < maskRaw.length; index += 1) {
    const offset = index * 4;
    const r = deliveredRaw[offset] ?? 0; const g = deliveredRaw[offset + 1] ?? 0; const b = deliveredRaw[offset + 2] ?? 0;
    if (!(r >= 150 && r - g >= 60 && r - b >= 60)) continue;
    redPixels += 1;
    const x = index % sourceMeta.width;
    const y = Math.floor(index / sourceMeta.width);
    if (x < redMinX) redMinX = x; if (x > redMaxX) redMaxX = x;
    if (y < redMinY) redMinY = y; if (y > redMaxY) redMaxY = y;
  }
  report.redSticker = redPixels === 0 ? { detected: false }
    : { detected: true, pixels: redPixels,
        boundingBox: { x: redMinX, y: redMinY, width: redMaxX - redMinX + 1, height: redMaxY - redMinY + 1 },
        insideMaskBounds: redMinX >= maskMinX && redMaxX <= maskMaxX && redMinY >= maskMinY && redMaxY <= maskMaxY };
  if (report.redSticker.detected) {
    assert.ok(report.redSticker.insideMaskBounds,
      `The repainted sticker landed at ${JSON.stringify(report.redSticker.boundingBox)}, outside the painted region ${JSON.stringify(report.maskBounds)}`);
  }

  // Canvas delivery: the original element survives and exactly one new image
  // element references the delivered asset at the requested placement.
  const canvas = await admin.from("canvases").select("content").eq("id", canvasId).single();
  assert.ifError(canvas.error);
  const content = canvas.data.content ?? {};
  const files = content.files ?? {};
  const elements = (content.elements ?? []).filter(candidate => !candidate.isDeleted);
  const assetIdOf = candidate => candidate.customData?.assetId ?? files[candidate.fileId]?.assetId;
  const deliveredElements = elements.filter(candidate => candidate.type === "image"
    && assetIdOf(candidate) === jobRow.result?.asset_id);
  const sourceElements = elements.filter(candidate => candidate.type === "image"
    && assetIdOf(candidate) !== jobRow.result?.asset_id);
  const placeholderId = target.element_id ?? payload.placeholder_element_id ?? null;
  const placeholder = elements.find(candidate => candidate.id === placeholderId);
  const deliveredElement = deliveredElements[0];
  report.canvas = { elementsAfter: elements.length, sourceImageElements: sourceElements.length,
    deliveredImageElements: deliveredElements.length,
    deliveredElementId: deliveredElement?.id ?? null,
    replacedPlaceholderInPlace: Boolean(deliveredElement && placeholderId && deliveredElement.id === placeholderId),
    placeholderStillVisible: Boolean(placeholder && placeholder.type !== "image"),
    deliveredPlacement: deliveredElement
      ? { x: deliveredElement.x, y: deliveredElement.y, width: deliveredElement.width, height: deliveredElement.height }
      : null,
    requestedPlacement: placement,
    finalizedAt: jobRow.result?.canvas_finalized_at ?? null };
  assert.equal(deliveredElements.length, 1, "The canvas must reference the delivered asset exactly once");
  assert.equal(sourceElements.length, 1, "The original image element must be preserved");
  assert.equal(report.canvas.placeholderStillVisible, false, "The job placeholder must not be left behind");
  const placed = deliveredElement;
  assert.ok(Math.abs(placed.x - placement.x) < 1 && Math.abs(placed.y - placement.y) < 1,
    `The new image must land at the requested placement (${JSON.stringify(placement)}), not ${JSON.stringify(report.canvas.deliveredPlacement)}`);
  assert.ok(Math.abs(placed.width - placement.width) < 2 && Math.abs(placed.height - placement.height) < 2,
    "The delivered element must keep the requested box");

  // Local billing: one call, at most one deduction, no duplicate charge.
  const ledger = await admin.from("credit_transactions").select("transaction_type,amount")
    .eq("job_id", jobRow.id).eq("workspace_id", workspaceId);
  assert.ifError(ledger.error);
  const deductions = (ledger.data ?? []).filter(row => row.transaction_type === "generation_deduct");
  const deducted = deductions.reduce((sum, row) => sum - row.amount, 0);
  report.billing = { creditsCost: jobRow.credits_cost ?? 0, deductionRows: deductions.length,
    localCreditsDeducted: deducted,
    refundRows: (ledger.data ?? []).filter(row => row.transaction_type === "generation_refund").length };
  assert.ok(deductions.length <= 1, "No duplicate local deduction is permitted");
  assert.equal(deducted, jobRow.credits_cost ?? 0);

  // Artifacts: source, mask, delivered image, provider frame and one montage so a
  // human can judge the splice without opening the canvas.
  const sourceCopy = `${outputDirectory}local-repaint-source-${stamp}.png`;
  const maskCopy = `${outputDirectory}local-repaint-mask-${stamp}.png`;
  const deliveredCopy = `${outputDirectory}local-repaint-delivered-${stamp}.png`;
  const frameCopy = `${outputDirectory}local-repaint-provider-frame-${stamp}.png`;
  const montageCopy = `${outputDirectory}local-repaint-montage-${stamp}.png`;
  await writeFile(sourceCopy, await sharp(sourceBuffer).png().toBuffer());
  await writeFile(maskCopy, maskBuffer);
  await writeFile(deliveredCopy, delivered);
  const frameBuffer = await downloadObject(`${workspaceId}/generated/${frameName}`);
  await writeFile(frameCopy, frameBuffer);
  await writeFile(montageCopy, await buildMontage([
    await overlayMask(sourceBuffer, maskBuffer, sourceMeta),
    delivered,
    frameBuffer,
  ]));
  report.artifacts = { source: sourceCopy, mask: maskCopy, delivered: deliveredCopy,
    providerFrame: frameCopy, montage: montageCopy,
    montageOrder: ["source with painted mask in red", "delivered splice", "raw provider frame"] };
  report.browserVisualVerified = false;
  report.note = "Provider call count is evidenced by the attempt-0 checkpoint and the archived provider frame. "
    + "Pixel identity is measured, visual quality is judged from the copied images; no browser render was performed.";
  await finish(true);
  return report;
}

async function readProviderFrame(jobId, source) {
  const signed = await admin.storage.from("workspace-assets")
    .createSignedUrl(`${workspaceId}/generated/${jobId}-source-before-matting.png`, 600);
  if (signed.error || !signed.data?.signedUrl) return null;
  const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const sourceRatio = source ? source.width / source.height : null;
  const ratio = meta.width / meta.height;
  return { width: meta.width, height: meta.height, bytes: buffer.length,
    ratio: Number(ratio.toFixed(6)),
    ratioRelativeError: sourceRatio === null ? null : Number(Math.abs(ratio / sourceRatio - 1).toFixed(6)) };
}

/** Red mask outline over the source, so the montage shows where the user painted. */
async function overlayMask(sourceBuffer, maskBuffer, meta) {
  const maskRaw = await sharp(maskBuffer).removeAlpha().greyscale().raw().toBuffer();
  const overlay = Buffer.alloc(meta.width * meta.height * 4);
  for (let index = 0; index < maskRaw.length; index += 1) {
    const weight = maskRaw[index] ?? 0;
    if (weight < 8) continue;
    const offset = index * 4;
    overlay[offset] = 255; overlay[offset + 1] = 32; overlay[offset + 2] = 32;
    overlay[offset + 3] = Math.round(weight * 0.55);
  }
  return sharp(sourceBuffer).ensureAlpha()
    .composite([{ input: overlay, raw: { width: meta.width, height: meta.height, channels: 4 }, left: 0, top: 0 }])
    .png().toBuffer();
}

async function buildMontage(buffers) {
  const height = 720;
  const gap = 12;
  const tiles = await Promise.all(buffers.map(buffer => sharp(buffer).resize({ height }).png().toBuffer()));
  const widths = await Promise.all(tiles.map(async tile => (await sharp(tile).metadata()).width ?? height));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (tiles.length - 1);
  let left = 0;
  const composite = tiles.map((input, index) => {
    const item = { input, left, top: 0 };
    left += (widths[index] ?? 0) + gap;
    return item;
  });
  return sharp({ create: { width: totalWidth, height, channels: 4, background: { r: 24, g: 24, b: 27, alpha: 1 } } })
    .composite(composite).png().toBuffer();
}

if (auditOnly) {
  const row = await admin.from("background_jobs").select("*").eq("id", auditOnly).single();
  assert.ifError(row.error);
  assert(row.data, `Job ${auditOnly} not found`);
  await auditJob(row.data);
  process.exit(0);
}

if (!submit) {
  const path = `${outputDirectory}local-repaint-preflight-${stamp}.json`;
  await writeFile(path, JSON.stringify(preflight, null, 2));
  console.log(`Preflight only (no model call). Report: ${path}`);
  process.exit(0);
}
assert.equal(active.count ?? 0, 0, "No other image job may be running while the paid acceptance spends a call");

// ── Paid submission: exactly one job, exactly one image edit call ────────────
const [regionX, regionY, regionWidth, regionHeight] = regionArgument.split(",").map(Number);
const paintedRegion = { x: regionX, y: regionY, width: regionWidth, height: regionHeight };
assert([regionX, regionY, regionWidth, regionHeight].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
  && regionWidth > 0 && regionHeight > 0, "Invalid --region");
const sourcePng = await sharp(sourcePath).rotate().png().toBuffer();
const sourceMeta = await sharp(sourcePng).metadata();
assert(sourceMeta.width && sourceMeta.height);
const maskPng = await renderMask(paintedRegion, sourceMeta.width, sourceMeta.height);
const maskVariant = await sharp(maskPng).removeAlpha().greyscale().raw().toBuffer();
const paintedPixels = [...maskVariant].filter(value => value >= 8).length;
assert(paintedPixels > 0, "The painted region must not be empty");
const sourceDataUrl = `data:image/png;base64,${sourcePng.toString("base64")}`;

const { project } = await api("POST", "/api/projects", { name: `局部重绘真实验收 ${Date.now()}` });
const canvasId = project.primaryCanvas.id;
const placement = { x: sourceMeta.width + 40, y: 0, width: sourceMeta.width, height: sourceMeta.height };
const placeholderId = `repaint-placeholder-${Date.now()}`;
// The browser writes the source element and a job-owned placeholder rectangle, then
// stamps the job id onto that rectangle. The finalizer replaces it in place.
const canvasElements = [
  { type: "image", id: `repaint-source-${Date.now()}`, x: 0, y: 0, width: sourceMeta.width, height: sourceMeta.height,
    angle: 0, fileId: "repaint-source-file", status: "saved", scale: [1, 1], crop: null, groupIds: [],
    boundElements: null, frameId: null, index: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    updated: Date.now(), link: null, locked: false, opacity: 100, roundness: null, strokeColor: "transparent",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0,
    customData: {} },
  { type: "rectangle", id: placeholderId, ...placement, angle: 0, strokeColor: "#D1D5DB", backgroundColor: "#F3F4F6",
    fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [],
    roundness: { type: 3 }, boundElements: null, frameId: null, index: null, seed: 2, version: 1, versionNonce: 2,
    isDeleted: false, updated: Date.now(), link: null, locked: false,
    customData: { type: "image-replacement", status: "generating", operation: "local-repaint" } },
];
const saveCanvas = (elements) => api("PUT", `/api/canvases/${canvasId}`, { content: {
  elements, appState: {}, files: { "repaint-source-file": { id: "repaint-source-file",
    dataURL: sourceDataUrl, mimeType: "image/png", created: Date.now() } } } });
await saveCanvas(canvasElements);

const { job } = await api("POST", "/api/jobs/image-generation", {
  project_id: project.id,
  canvas_id: canvasId,
  operation: "local_repaint",
  model,
  prompt,
  quality: "standard",
  input_images: [sourceDataUrl],
  mask_image: `data:image/png;base64,${maskPng.toString("base64")}`,
  aspect_ratio: `${sourceMeta.width}:${sourceMeta.height}`,
  placement_x: placement.x, placement_y: placement.y,
  placement_width: placement.width, placement_height: placement.height,
  placeholder_element_id: placeholderId,
});
// Stamp the job id the way updateImageReplacementElement does. The provider call
// takes far longer than this write, so the finalizer always sees it.
await saveCanvas(canvasElements.map(element => element.id === placeholderId
  ? { ...element, version: element.version + 1, customData: { ...element.customData, jobId: job.id } }
  : element));
console.log(`Submitted local repaint job ${job.id} (one paid edit call, no retry)`);

let current = job;
for (let attempt = 0; attempt < 240; attempt += 1) {
  ({ job: current } = await api("GET", `/api/jobs/${job.id}`));
  if (["succeeded", "failed", "dead_letter", "canceled"].includes(current.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
await auditJob(current);
