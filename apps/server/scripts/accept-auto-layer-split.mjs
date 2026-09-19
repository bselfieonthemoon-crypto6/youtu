// Real-image acceptance for the automatic full split (全部剥离).
//
// One paid vision call proposes the element names, then the split spends one paid
// image call per element plus one for the repaired background. Nothing here
// retries: if the job fails, the script reports it and stops, because the queue
// has its own retry policy and resubmitting would spend a second time.
//
//   node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx \
//     scripts/accept-auto-layer-split.mjs --elements=2
//   ... add --submit to spend the calls, or --audit-only=<jobId> to re-verify a
//   job that already spent them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(new URL("../package.json", import.meta.url));
const sharp = require("sharp");

assert.equal(process.env.SUPABASE_URL, "http://127.0.0.1:54421", "This acceptance only runs against the local replica");
const argument = (name) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const submit = process.argv.includes("--submit");
const auditOnly = argument("audit-only");
// The listing may propose up to four elements; the acceptance deliberately takes
// fewer so the paid run stays bounded, exactly like a user trimming the list.
const elementLimit = Math.max(1, Math.min(4, Number(argument("elements") ?? 2)));
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
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    assert.fail(`${method} ${route} failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
};

const health = await (await fetch("http://127.0.0.1:3002/api/health", { signal: AbortSignal.timeout(10_000) })).json();
assert.equal(health.ok, true);
const quote = await api("GET", `/api/images/semantic-layer-backend?layer_count=${elementLimit}`);
assert.equal(quote.available, true, "The published semantic layer model must be available");
assert.equal(quote.layerCount, elementLimit);
assert.equal(quote.calls, elementLimit + 1, "N elements plus one repaired background are N+1 paid image calls");
const active = await admin.from("background_jobs").select("id", { count: "exact" })
  .eq("workspace_id", workspaceId).eq("job_type", "image_generation").in("status", ["queued", "running"]);
assert.ifError(active.error);
const preflight = { kind: "auto_layer_split_preflight", createdAt: new Date().toISOString(),
  apiHealth: health.ok, quote, activeImageJobs: active.count ?? 0, elementLimit,
  paidCallsPlanned: { visionListing: 1, imageCalls: quote.calls, total: quote.calls + 1 },
  sourcePath, auditOnly: auditOnly ?? null, submitRequested: submit };
console.log(JSON.stringify(preflight, null, 2));

const download = async (layer) => {
  // Re-sign from the stored object path: a job audited later has an expired
  // signed URL, and re-verifying an old acceptance must not need a new call.
  assert.ok(layer.object_path ?? layer.signed_url, "Every delivered layer must be readable");
  let url = layer.signed_url;
  if (typeof layer.object_path === "string") {
    const signed = await admin.storage.from("workspace-assets").createSignedUrl(layer.object_path, 600);
    if (!signed.error && signed.data?.signedUrl) url = signed.data.signedUrl;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `Layer download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Verifies one finished job from the database, storage and pixels. Never spends. */
async function auditJob(jobRow, { sourcePng, listing }) {
  const canvasId = jobRow.payload?.target?.canvas_id ?? jobRow.canvas_id;
  assert(typeof canvasId === "string" && canvasId.length > 0, "The audited job must carry its canvas target");
  const layerNames = jobRow.payload?.layer_names ?? [];
  const report = { kind: "auto_layer_split_acceptance", createdAt: new Date().toISOString(), jobId: jobRow.id,
    canvasId, layerNames, listing: listing ?? null, model: jobRow.payload?.model,
    quotedCalls: quote.calls, quotedCredits: quote.credits, status: jobRow.status,
    errorCode: jobRow.error_code ?? null, errorMessage: jobRow.error_message ?? null, attempts: jobRow.attempt_count };
  if (jobRow.status !== "succeeded") {
    report.verified = false;
    await writeFile(`${outputDirectory}auto-split-acceptance-${stamp}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert.fail(`Auto layer split job ${jobRow.status}: ${jobRow.error_message ?? "no message"}`);
  }

  assert.equal(jobRow.payload.quality, "standard");
  assert.equal(jobRow.payload.resolution, "1k");
  assert.equal(jobRow.payload.layer_backend, "semantic");
  assert.equal(jobRow.payload.repair_background, true);
  assert.equal(jobRow.payload.model, quote.model, "The job must freeze the quoted published model");
  assert.equal(layerNames.length, elementLimit);
  assert.equal(new Set(layerNames.map(name => name.trim().toLocaleLowerCase())).size, layerNames.length,
    "The listed names must be distinct, or the split would duplicate a layer");

  // One paid image call per element plus the repaired background, and no more.
  const generated = await admin.storage.from("workspace-assets")
    .list(`${workspaceId}/generated`, { limit: 1000 });
  assert.ifError(generated.error);
  const stages = Array.from({ length: elementLimit + 2 }, (_, index) => {
    const name = `${jobRow.id}-semantic-layer-stage-${index}-source.png`;
    return { index, present: (generated.data ?? []).some(row => row.name === name) };
  });
  const presentStages = stages.filter(stage => stage.present);
  report.providerCalls = { callsExpected: quote.calls, callsEvidenced: presentStages.length,
    stages, extraStageAbsent: !stages[elementLimit + 1].present };
  assert.equal(presentStages.length, quote.calls, "Exactly N+1 paid image calls must be archived");
  assert.equal(stages[elementLimit + 1].present, false, "No paid stage beyond N+1 may exist");

  const layers = jobRow.result?.layers ?? [];
  const backgrounds = layers.filter(layer => layer.kind === "background");
  const elements = layers.filter(layer => layer.kind === "element");
  assert.equal(backgrounds.length, 1, "Exactly one repaired background is delivered");
  assert.equal(elements.length, elementLimit, "Every requested element must be delivered");
  assert.deepEqual(elements.map(layer => layer.name), layerNames, "Delivered elements keep the requested order");
  const sourceImage = await sharp(sourcePng).metadata();
  const background = backgrounds[0];
  assert.equal(background.width, sourceImage.width, "The repaired background keeps the source framing");
  assert.equal(background.height, sourceImage.height);
  assert.equal(jobRow.result.source_width, sourceImage.width);
  assert.equal(jobRow.result.source_height, sourceImage.height);

  const sourceRaw = await sharp(sourcePng).ensureAlpha().raw().toBuffer();
  const backgroundBuffer = await download(background);
  const backgroundRaw = await sharp(backgroundBuffer).ensureAlpha().raw().toBuffer();
  assert.equal(backgroundRaw.length, sourceRaw.length);
  const backgroundCopy = `${outputDirectory}auto-split-background-${stamp}.png`;
  await writeFile(backgroundCopy, backgroundBuffer);
  report.artifacts = { background: backgroundCopy, elements: [] };

  // Every element must be a genuine cutout inside the frame, on its own.
  const feather = 2;
  const rects = [];
  const masks = [];
  for (const element of elements) {
    const buffer = await download(element);
    const copy = `${outputDirectory}auto-split-element-${elements.indexOf(element) + 1}-${stamp}.png`;
    await writeFile(copy, buffer);
    report.artifacts.elements.push(copy);
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.hasAlpha, true, `Element 「${element.name}」 must carry alpha`);
    const alpha = await sharp(buffer).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const transparent = [...alpha].filter(value => value < 8).length;
    const opaque = [...alpha].filter(value => value >= 248).length;
    assert.ok(opaque > 0 && transparent > 0, `Element 「${element.name}」 needs both opaque and transparent pixels`);
    assert.ok(element.x >= 0 && element.y >= 0
      && element.x + element.width <= sourceImage.width
      && element.y + element.height <= sourceImage.height,
      `Element 「${element.name}」 must stay inside the source frame`);
    rects.push({ name: element.name, x: element.x, y: element.y, width: element.width, height: element.height,
      transparentPixels: transparent, opaquePixels: opaque,
      transparencyRatio: Number((transparent / (element.width * element.height)).toFixed(4)) });
    // Full-frame opaque mask, so two elements can be compared by the pixels they
    // actually claim rather than by how their rectangles happen to sit.
    const mask = new Uint8Array(sourceImage.width * sourceImage.height);
    for (let y = 0; y < element.height; y += 1) {
      for (let x = 0; x < element.width; x += 1) {
        if ((alpha[y * element.width + x] ?? 0) < 128) continue;
        const canvasX = element.x + x;
        const canvasY = element.y + y;
        if (canvasX >= sourceImage.width || canvasY >= sourceImage.height) continue;
        mask[canvasY * sourceImage.width + canvasX] = 1;
      }
    }
    masks.push(mask);
  }
  report.elements = rects;

  // Two names must not deliver the same pixels. Rectangle overlap alone is not
  // evidence: neighbouring objects legitimately share bounding boxes.
  const overlaps = [];
  for (let a = 0; a < masks.length; a += 1) {
    for (let b = a + 1; b < masks.length; b += 1) {
      let intersection = 0;
      let firstOnly = 0;
      let secondOnly = 0;
      for (let index = 0; index < masks[a].length; index += 1) {
        const inFirst = masks[a][index] === 1;
        const inSecond = masks[b][index] === 1;
        if (inFirst && inSecond) intersection += 1;
        else if (inFirst) firstOnly += 1;
        else if (inSecond) secondOnly += 1;
      }
      const overlapRatio = intersection / Math.max(1, Math.min(firstOnly + intersection, secondOnly + intersection));
      overlaps.push({ pair: [rects[a].name, rects[b].name], sharedPixels: intersection,
        overlapRatio: Number(overlapRatio.toFixed(4)), rectangleOverlap: rects[a].x < rects[b].x + rects[b].width
          && rects[b].x < rects[a].x + rects[a].width && rects[a].y < rects[b].y + rects[b].height
          && rects[b].y < rects[a].y + rects[a].height });
    }
  }
  report.elementOverlaps = overlaps;
  assert.ok(overlaps.every(entry => entry.overlapRatio <= 0.3),
    `Two delivered elements claim the same pixels: ${JSON.stringify(overlaps)}`);

  // The repair may only touch the elements' own pixels plus the faint tail of their
  // soft edges. The composite mask is each element's alpha, whose 1-7 feather can
  // reach well past the delivered crop (the crop is the alpha>=8 bounding box), so
  // outside the rectangles the rule is about magnitude: a blend of at most a few
  // levels per channel, never a content change and never an alpha change.
  const inAnyRect = (x, y) => rects.some(rect => x >= rect.x && x < rect.x + rect.width
    && y >= rect.y && y < rect.y + rect.height);
  const distanceToRects = (x, y) => Math.min(...rects.map(rect => Math.max(
    rect.x - x, x - (rect.x + rect.width - 1), rect.y - y, y - (rect.y + rect.height - 1), 0)));
  const TAIL_LIMIT_PX = 32;
  const TAIL_BLEND_MAX = 8;
  let insideChanged = 0;
  let tailChanged = 0;
  let tailMaxDelta = 0;
  let maxTailDistance = 0;
  let alphaChanged = 0;
  for (let y = 0; y < sourceImage.height; y += 1) {
    for (let x = 0; x < sourceImage.width; x += 1) {
      const offset = (y * sourceImage.width + x) * 4;
      if ((sourceRaw[offset + 3] ?? 0) !== (backgroundRaw[offset + 3] ?? 0)) alphaChanged += 1;
      const deltas = [0, 1, 2].map(channel =>
        Math.abs((sourceRaw[offset + channel] ?? 0) - (backgroundRaw[offset + channel] ?? 0)));
      if (deltas.every(value => value === 0)) continue;
      if (inAnyRect(x, y)) { insideChanged += 1; continue; }
      tailChanged += 1;
      tailMaxDelta = Math.max(tailMaxDelta, ...deltas);
      maxTailDistance = Math.max(maxTailDistance, distanceToRects(x, y));
    }
  }
  assert.equal(alphaChanged, 0, "The repair must not change any alpha channel");
  assert.ok(tailMaxDelta <= TAIL_BLEND_MAX,
    `Outside the delivered elements a change of ${tailMaxDelta}/255 is content, not soft-edge blending`);
  assert.ok(maxTailDistance <= TAIL_LIMIT_PX,
    `The repair reached ${maxTailDistance}px past the delivered elements, beyond the ${TAIL_LIMIT_PX}px soft-edge tail`);
  assert.ok(insideChanged > 0, "The repair must reconstruct the pixels the elements occupied");
  report.backgroundRepair = { tailLimitPx: TAIL_LIMIT_PX, tailBlendMaxPerChannel: TAIL_BLEND_MAX,
    insideElementsChangedPixels: insideChanged, softEdgeTailChangedPixels: tailChanged,
    softEdgeTailMaxDistancePx: maxTailDistance, softEdgeTailMaxDelta: tailMaxDelta,
    softEdgeTailShareOfImage: Number((tailChanged / (sourceImage.width * sourceImage.height)).toFixed(6)),
    alphaChannelChangedPixels: alphaChanged };

  const canvas = await admin.from("canvases").select("content").eq("id", canvasId).single();
  assert.ifError(canvas.error);
  const files = canvas.data.content?.files ?? {};
  const liveElements = (canvas.data.content?.elements ?? []).filter(candidate => !candidate.isDeleted);
  const assetIdOf = candidate => candidate.customData?.assetId ?? files[candidate.fileId]?.assetId;
  const deliveredAssetIds = layers.map(layer => layer.asset_id);
  const delivered = liveElements.filter(candidate => deliveredAssetIds.includes(assetIdOf(candidate)));
  report.canvas = { liveElements: liveElements.length, deliveredElements: delivered.length,
    expectedDelivered: quote.calls, finalizedAt: jobRow.result?.canvas_finalized_at ?? null };
  assert.equal(delivered.length, quote.calls, "Every layer must reach the canvas");

  const ledger = await admin.from("credit_transactions").select("transaction_type,amount")
    .eq("job_id", jobRow.id).eq("workspace_id", workspaceId);
  assert.ifError(ledger.error);
  const deductions = (ledger.data ?? []).filter(row => row.transaction_type === "generation_deduct");
  assert.ok(deductions.length <= 1, "No duplicate local deduction is permitted");
  report.billing = { creditsCost: jobRow.credits_cost ?? 0, quotedCredits: quote.credits,
    deductionRows: deductions.length,
    localCreditsDeducted: deductions.reduce((sum, row) => sum - row.amount, 0) };
  assert.equal(jobRow.credits_cost ?? 0, quote.credits, "The charged credits must equal the quote");

  report.verified = true;
  report.browserVisualVerified = false;
  report.note = "Paid call count is evidenced by the per-stage archives. Visual quality is judged from the copied layers; no browser render was performed.";
  const reportPath = `${outputDirectory}auto-split-acceptance-${stamp}.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Automatic full-split acceptance passed: ${reportPath}`);
  return report;
}

if (auditOnly) {
  const row = await admin.from("background_jobs").select("*").eq("id", auditOnly).single();
  assert.ifError(row.error);
  assert(row.data, `Job ${auditOnly} not found`);
  const dataUri = row.data.payload?.input_images?.[0] ?? "";
  assert(dataUri.startsWith("data:image/"), "The audited job must carry its source image in the payload");
  await auditJob(row.data, { sourcePng: Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"), listing: null });
  process.exit(0);
}

if (!submit) {
  const path = `${outputDirectory}auto-split-preflight-${stamp}.json`;
  await writeFile(path, JSON.stringify(preflight, null, 2));
  console.log(`Preflight only (no model call). Report: ${path}`);
  process.exit(0);
}
assert.equal(active.count ?? 0, 0, "No other image job may be running while the paid acceptance spends calls");

// ── Paid submission ─────────────────────────────────────────────────────────
const sourcePng = await sharp(sourcePath).rotate().png().toBuffer();
const { project } = await api("POST", "/api/projects", { name: `全部剥离真实验收 ${Date.now()}` });
const canvasId = project.primaryCanvas.id;
const sourceCopy = `${outputDirectory}auto-split-source-${stamp}.png`;
await writeFile(sourceCopy, sourcePng);

// The listing route authorizes the image against the canvas it belongs to, so the
// fixture needs the source as a real canvas element — exactly the state the user
// is in when they select an image and press 全部剥离.
const sourceDataUri = `data:image/png;base64,${sourcePng.toString("base64")}`;
// Excalidraw element ids are short opaque strings, and the resolver treats a UUID
// assetId as a database asset reference. Using a real element id keeps the fixture
// on the same authorization path as the toolbar: canvas element + inline data URL.
const sourceElementId = "fixture-source-element";
const sourceFileId = "fixture-source-file";
const seed = await admin.from("canvases").update({
  content: {
    elements: [{ id: sourceElementId, type: "image", fileId: sourceFileId, x: 40, y: 40,
      width: 450, height: 600, angle: 0, isDeleted: false }],
    appState: {},
    files: { [sourceFileId]: { id: sourceFileId, mimeType: "image/png", dataURL: sourceDataUri } },
  },
}).eq("id", canvasId);
assert.ifError(seed.error);

// 1) One paid vision call proposes the elements (the route the toolbar uses).
const listingStarted = Date.now();
const listing = await api("POST", "/api/images/layer-elements", {
  canvasId,
  image: { assetId: sourceElementId, url: sourceDataUri, mimeType: "image/png" },
});
const proposed = Array.isArray(listing.elements) ? listing.elements.filter(value => typeof value === "string") : [];
assert(proposed.length >= 2, `The listing must propose at least two elements, got ${JSON.stringify(listing)}`);
const chosen = proposed.slice(0, elementLimit);
console.log(`Listing proposed ${JSON.stringify(proposed)}; the run will split ${JSON.stringify(chosen)}`);

// 2) The split itself: one paid image call per element plus the repaired background.
const splitSummary = `将原图拆分为修补后的完整底图，以及以下独立透明元素：${chosen.join("、")}。保持原始构图和元素位置，分别生成每个元素。`;
const { job } = await api("POST", "/api/jobs/image-generation", {
  project_id: project.id,
  canvas_id: canvasId,
  prompt: splitSummary,
  operation: "split_layers",
  model: quote.model,
  layer_backend: "semantic",
  layer_names: chosen,
  repair_background: true,
  quality: "standard",
  resolution: "1k",
  input_images: [sourceDataUri],
});
console.log(`Submitted auto split job ${job.id} (${quote.calls} paid image calls, no retry)`);

let current = job;
for (let attempt = 0; attempt < 300; attempt += 1) {
  ({ job: current } = await api("GET", `/api/jobs/${job.id}`));
  if (["succeeded", "failed", "dead_letter", "canceled"].includes(current.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
await auditJob(current, { sourcePng,
  listing: { proposed, chosen, latencyMs: Date.now() - listingStarted, sourceCopy } });
