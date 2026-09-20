import { createHash } from "node:crypto";

export type CanvasSceneElement = Record<string, unknown>;
export type CanvasSceneBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type CanvasSceneRelation = { kind: string; targetId: string };
export type CanvasSceneIndexEntry = {
  /**
   * Stable canvas order: the element's zero-based position in the canvas
   * document's own element array. Every model-facing surface lists and refers
   * to elements by this value, so the same scene always produces the same
   * order. Two same-size square images were once reported in reversed order
   * because one surface listed the canvas array and another listed recency
   * with no shared ordinal to join them on.
   */
  ordinal: number;
  id: string;
  type: string;
  logicalType: string;
  x: number;
  y: number;
  /**
   * CANVAS DISPLAY FRAME (③) — never the source image's pixel size (②).
   *
   * Both come from the Excalidraw element, so a generated 880x1184 PNG is
   * carried by a 381x512 frame. A status answer once reported that frame as
   * "实际像素". The real pixels exist only on the job receipt
   * (`background_jobs.result.width/height`); `public.asset_objects` has no
   * width/height columns and the canvas document never stores them.
   *
   * The names say `canvasFrame` rather than `width`/`height` on purpose: the
   * interface is read by humans too, and a bare pair beside an image is what was
   * mistaken for pixels in the first place.
   */
  canvasFrameWidth: number;
  canvasFrameHeight: number;
  text?: string;
  name?: string;
  role?: string;
  title?: string;
  assetId?: string;
  /** True only when the canvas element actually carries an authenticated asset id. */
  hasAssetId: boolean;
  /** Where that identity came from, or `unbacked` when the image has none. */
  assetIdentitySource: CanvasAssetIdentitySource;
  groupIds: string[];
  frameId?: string;
  containerId?: string;
  bindings: CanvasSceneRelation[];
  designId?: string;
  designObjectId?: string;
  /**
   * The image pipeline's own placeholder node (`customData.type=image-generator`,
   * status `generating`/`error`). Without this the agent cannot tell a failed
   * generation box from an ordinary rectangle, so it could neither remove one on
   * request nor say which request left it there.
   */
  generationStatus?: string;
  generationJobId?: string;
  raw: CanvasSceneElement;
};

export type CanvasSceneRegion = {
  id: string;
  bounds: CanvasSceneBounds;
  count: number;
  types: Record<string, number>;
  sampleElementIds: string[];
  textSamples: string[];
};

export type CanvasSceneIndex = {
  revision: string;
  revisionNumber: number;
  bounds: CanvasSceneBounds;
  coverage: {
    rawCount: number;
    liveCount: number;
    indexedCount: number;
    deletedCount: number;
    malformedCount: number;
    duplicateIdCount: number;
    relationCount: number;
    danglingRelationCount: number;
    complete: boolean;
  };
  duplicateIds: string[];
  danglingRelations: CanvasSceneRelation[];
  regions: CanvasSceneRegion[];
  entries: CanvasSceneIndexEntry[];
};

export type CanvasSceneQuery = {
  elementId?: string;
  text?: string;
  groupId?: string;
  types?: string[];
  region?: { minX: number; minY: number; maxX: number; maxY: number };
  selectedIds?: string[];
  limit?: number;
  cursor?: string;
};

const MAX_ID = 200;
const MAX_RELATIONS_PER_ELEMENT = 100;
const MAX_REGION_SAMPLES = 4;
const GRID_SIZE = 4;

/**
 * The one four-size vocabulary every surface uses, and the label that says so.
 *
 * Four different numbers describe "the size of an image", and every one of them
 * has been reported as another at least once: the frame the user asked for, the
 * pixels the model actually produced, the frame the canvas element displays, and
 * the exported artifact. Because each layer legitimately holds exactly one of
 * them, no single observation can state all four — so the honest contract is
 * that every observation NAMES the one it carries and says where the others come
 * from. That is what these notes do.
 */
export const IMAGE_REQUESTED_SIZE_KEY = "image_requested_frame";
export const IMAGE_SOURCE_PIXELS_KEY = "image_source_pixels";
export const IMAGE_CANVAS_FRAME_KEY = "image_canvas_frame";
export const IMAGE_EXPORT_SIZE_KEY = "image_export_size";
/**
 * The four names as one frozen list.
 *
 * Exported so a test (or a future surface) asserts this vocabulary by name
 * instead of by copied prose: a listing that emits only three of the four names,
 * or that drops back to a bare width/height for an image, has republished the
 * ambiguity this contract removed.
 */
export const IMAGE_SIZE_KEYS = Object.freeze([
  IMAGE_REQUESTED_SIZE_KEY, IMAGE_SOURCE_PIXELS_KEY, IMAGE_CANVAS_FRAME_KEY, IMAGE_EXPORT_SIZE_KEY,
] as const);
/** Keys that never carry a size; a listing that emitted one was a defect. */
export const IMAGE_SIZE_NOTE = "Size note: image_requested_frame = the size/ratio the USER asked for (from the authenticated submission: requested aspect ratio + requested resolution tier; the natural-language wording is the user's own, not re-parsed here). image_source_pixels = the AI's SOURCE pixel size of the generated image, the only real pixels; it exists ONLY on the generation job receipt (background_jobs.result.width/height; other surfaces may mirror it as sourcePixelWidth/sourcePixelHeight). image_canvas_frame = the CANVAS DISPLAY FRAME of this canvas element; it is a display frame and NOT the image's pixels, and one PNG can be shown in many differently sized frames. image_export_size = the FINAL EXPORT size of an exported artifact; it is never derivable from any of the three above or from this receipt — read it from the succeeded design_export job's result (background_jobs.result.width/height), and report it as unknown here rather than substituting another size.";
/** Mirrored where a caller wants the same sentence under its historical key name. */
export const CANVAS_FRAME_DIMENSION_NOTE = IMAGE_SIZE_NOTE;

/**
 * The same four-size contract, short enough for per-listing blocks.
 *
 * A related-image listing repeats its rules on every read, so the full note would
 * be most of the block. This keeps the distinction and the two authoritative
 * sources without re-explaining the Excalidraw frame history.
 */
export const IMAGE_SIZE_NOTE_SHORT = "Sizes: image_requested_frame=① what the user asked for (submission ratio+resolution tier, not pixels); image_source_pixels=② the AI image's real pixels (ONLY on its generation job receipt as sourcePixelWidth/Height); image_canvas_frame=③ the canvas display frame (may differ per placement, never ②); image_export_size=④ the exported artifact's size (only on that export job's own result; unknown otherwise). Never state one as another.";

/**
 * The four-size vocabulary is itself load-bearing, so assert it.
 *
 * Kept in code rather than only in tests because several surfaces emit the same
 * notes and a future edit could quietly drop a name back out. A malformed note is
 * dropped and logged rather than published half-stated: a listing with no size
 * note is visibly incomplete, while a listing whose note lost a name reads as if
 * that size were not a separate thing.
 */
export function assertImageSizeVocabulary(note: string, source: string): string {
  const missing = IMAGE_SIZE_KEYS.filter(key => !note.includes(key));
  if (!missing.length) return note;
  console.warn("[canvas-dimension-vocabulary]", { source, missing, noteBytes: Buffer.byteLength(note, "utf8") });
  return "";
}

/** Both long size notes, checked once for the surfaces that emit them. */
export function validatedImageSizeNotes(source: string): { long: string; short: string } {
  return { long: assertImageSizeVocabulary(IMAGE_SIZE_NOTE, source),
    short: assertImageSizeVocabulary(IMAGE_SIZE_NOTE_SHORT, source) };
}

// Checked once at import: every emitter below uses these two, so a note that
// stopped naming one of the four sizes can never reach a model surface.
const CHECKED_SIZE_NOTES = validatedImageSizeNotes("canvas-scene-index");

/**
 * Stable identity, stated once for every listing.
 *
 * Two same-size square images were once reported in reversed order because one
 * surface listed the canvas array and another listed recency with no shared
 * ordinal to join them on. The shared ordinal fixed the presentation, but an
 * ordinal is still only a position: insert an image above and every later index
 * shifts. So every listing carries the element id and, when the canvas provides
 * one, the authenticated asset id, and says here that THOSE are the durable
 * references.
 */
export const CANVAS_IDENTITY_NOTE = "Identity note: element_id (and asset_id when the canvas carries one) is the STABLE identity of a canvas image across turns, edits and reordering; canvas_index (index=/ordinal) is presentation order only and must never be used as an image's identity or as a request reference. An image with no asset_id is an unbacked/unnamed canvas file: say so and reference it by element_id, never imply an authenticated asset identity it does not have.";
/** The same rule, short enough for per-listing blocks that repeat it for every read. */
export const CANVAS_IDENTITY_NOTE_SHORT = "Identity: asset_id/element_id are the durable reference; canvas_index is order only, never identity or a request reference.";
export const CANVAS_ORDER_NOTE = "Order note: entries are in canvas order, ascending canvas_index (the element's position in the canvas document), deterministic and identical across repeated reads. The order is presentation only; identity is element_id/asset_id (see the identity note).";
/** The order rule alone, for the notes-only fallback. */
export const CANVAS_ORDER_NOTE_SHORT = "Order: ascending canvas_index (canvas document position); presentation only.";

/** Where an image's backing asset identity came from, or that it has none. */
export type CanvasAssetIdentitySource = "customData.assetId" | "element.assetId" | "unbacked";

/**
 * Stable reference facts for one image entry.
 *
 * `assetIdentitySource: "unbacked"` is deliberately a positive statement rather
 * than an absent field: an absent `assetId` beside an image reads as "I could not
 * find it", which invites the model to guess a neighbouring asset or fall back to
 * the ordinal. Naming the state says the canvas genuinely has no authenticated
 * asset behind this image.
 */
export function canvasAssetIdentity(entry: Pick<CanvasSceneIndexEntry, "assetId">): {
  assetIdentitySource: CanvasAssetIdentitySource;
  hasAssetId: boolean;
} {
  return entry.assetId
    ? { assetIdentitySource: "customData.assetId", hasAssetId: true }
    : { assetIdentitySource: "unbacked", hasAssetId: false };
}

/** The rendered form of the identity facts, for the text-listings. */
export function canvasIdentityLabel(entry: Pick<CanvasSceneIndexEntry, "assetId">): string {
  return entry.assetId
    ? `assetId=${entry.assetId} identity=assetId+element_id(durable; canvasIndex is order only)`
    : "assetIdentity=unbacked(no authenticated asset id; durable reference is element_id only; canvasIndex is order only)";
}

/**
 * Explicit, documented canvas order. Exported so every listing surface (scene
 * context, queries, related-image candidates) shares one comparator instead of
 * inventing a second order that could disagree with this one.
 */
export function compareCanvasOrder(left: { ordinal: number }, right: { ordinal: number }) {
  return left.ordinal - right.ordinal;
}

function record(value: unknown): CanvasSceneElement | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CanvasSceneElement
    : null;
}

function boundedString(value: unknown, max = MAX_ID): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(value: unknown, max = MAX_RELATIONS_PER_ELEMENT): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => {
    const text = boundedString(item);
    return text ? [text] : [];
  }))].slice(0, max);
}

function relationTarget(value: unknown): string | undefined {
  const item = record(value);
  return boundedString(item?.elementId ?? item?.id);
}

function extractRelations(element: CanvasSceneElement): CanvasSceneRelation[] {
  const relations: CanvasSceneRelation[] = [];
  for (const [kind, value] of [["bound", element.boundElements], ["bound", element.boundElementIds]] as const) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const targetId = typeof item === "string" ? boundedString(item) : relationTarget(item);
      if (targetId) relations.push({ kind, targetId });
    }
  }
  for (const [kind, value] of [
    ["start", element.startBinding], ["end", element.endBinding],
  ] as const) {
    const targetId = relationTarget(value);
    if (targetId) relations.push({ kind, targetId });
  }
  const containerId = boundedString(element.containerId);
  if (containerId) relations.push({ kind: "container", targetId: containerId });
  const frameId = boundedString(element.frameId);
  if (frameId) relations.push({ kind: "frame", targetId: frameId });
  return relations.slice(0, MAX_RELATIONS_PER_ELEMENT);
}

function normalizeElement(raw: unknown, ordinal: number): CanvasSceneIndexEntry | null {
  const element = record(raw);
  if (!element || element.isDeleted === true) return null;
  const id = boundedString(element.id);
  const type = boundedString(element.type, 80);
  const x = finite(element.x);
  const y = finite(element.y);
  const width = finite(element.width);
  const height = finite(element.height);
  if (!id || !type || x === undefined || y === undefined || width === undefined || height === undefined
    || width < 0 || height < 0) return null;
  const customData = record(element.customData) ?? {};
  const isVideo = (type === "image" || type === "embeddable") && customData.isVideo === true;
  const string = (value: unknown, max: number) => boundedString(value, max);
  const text = string(element.text, 16_000);
  const name = string(customData.name ?? element.name, 2_000);
  const role = string(customData.role ?? element.role, 80);
  const title = string(customData.title ?? element.title, 2_000);
  const frameId = string(element.frameId, 200);
  const containerId = string(element.containerId, 200);
  const assetId = string(customData.assetId, 2000) ?? string(element.assetId, 2000);
  const assetIdentitySource: CanvasAssetIdentitySource = assetId
    ? (string(customData.assetId, 2000) ? "customData.assetId" : "element.assetId")
    : "unbacked";
  const designId = string(customData.designId ?? customData.design_id, 200);
  const designObjectId = string(customData.designObjectId ?? customData.design_object_id, 200);
  // Only the image pipeline's placeholder nodes carry a generation status; an
  // ordinary element with a stray `status` key must not be reported as one.
  const generationStatus = ["image-generator", "image-replacement"].includes(String(customData.type ?? ""))
    ? string(customData.status, 40) : undefined;
  const generationJobId = generationStatus
    ? string(customData.jobId ?? customData.sourceJobId, 200) : undefined;
  return {
    ordinal, id, type, logicalType: isVideo ? "video" : type,
    x, y, canvasFrameWidth: width, canvasFrameHeight: height,
    ...(text ? { text } : {}), ...(name ? { name } : {}),
    ...(role ? { role } : {}), ...(title ? { title } : {}),
    ...(assetId ? { assetId } : {}),
    hasAssetId: assetIdentitySource !== "unbacked",
    assetIdentitySource,
    groupIds: uniqueStrings(element.groupIds),
    ...(frameId ? { frameId } : {}), ...(containerId ? { containerId } : {}),
    bindings: extractRelations(element),
    ...(designId ? { designId } : {}),
    ...(designObjectId ? { designObjectId } : {}),
    ...(generationStatus ? { generationStatus } : {}),
    ...(generationJobId ? { generationJobId } : {}),
    raw: element,
  };
}

function bounds(entries: readonly CanvasSceneIndexEntry[]): CanvasSceneBounds {
  if (!entries.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return entries.reduce((result, entry) => ({
    minX: Math.min(result.minX, entry.x), minY: Math.min(result.minY, entry.y),
    maxX: Math.max(result.maxX, entry.x + entry.canvasFrameWidth), maxY: Math.max(result.maxY, entry.y + entry.canvasFrameHeight),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function buildRegions(entries: readonly CanvasSceneIndexEntry[], sceneBounds: CanvasSceneBounds): CanvasSceneRegion[] {
  const width = Math.max(1, sceneBounds.maxX - sceneBounds.minX);
  const height = Math.max(1, sceneBounds.maxY - sceneBounds.minY);
  const regions = new Map<string, CanvasSceneRegion>();
  for (const entry of entries) {
    const centerX = entry.x + entry.canvasFrameWidth / 2;
    const centerY = entry.y + entry.canvasFrameHeight / 2;
    const column = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((centerX - sceneBounds.minX) / width * GRID_SIZE)));
    const row = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((centerY - sceneBounds.minY) / height * GRID_SIZE)));
    const id = `r${row}c${column}`;
    const region = regions.get(id) ?? {
      id, bounds: { minX: entry.x, minY: entry.y, maxX: entry.x + entry.canvasFrameWidth, maxY: entry.y + entry.canvasFrameHeight },
      count: 0, types: {}, sampleElementIds: [], textSamples: [],
    };
    region.count += 1;
    region.bounds = {
      minX: Math.min(region.bounds.minX, entry.x), minY: Math.min(region.bounds.minY, entry.y),
      maxX: Math.max(region.bounds.maxX, entry.x + entry.canvasFrameWidth), maxY: Math.max(region.bounds.maxY, entry.y + entry.canvasFrameHeight),
    };
    region.types[entry.logicalType] = (region.types[entry.logicalType] ?? 0) + 1;
    if (region.sampleElementIds.length < MAX_REGION_SAMPLES) region.sampleElementIds.push(entry.id);
    const sample = entry.text ?? entry.title ?? entry.name;
    if (sample && region.textSamples.length < 2) region.textSamples.push(sample.slice(0, 80));
    regions.set(id, region);
  }
  return [...regions.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Build one immutable, bounded-metadata index over every raw canvas entry. */
export function buildCanvasSceneIndex(rawElements: unknown): CanvasSceneIndex {
  const input = Array.isArray(rawElements) ? rawElements : [];
  const revision = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const entries: CanvasSceneIndexEntry[] = [];
  let deletedCount = 0;
  let malformedCount = 0;
  input.forEach((raw, ordinal) => {
    const value = record(raw);
    if (value?.isDeleted === true) { deletedCount += 1; return; }
    const normalized = normalizeElement(raw, ordinal);
    if (normalized) entries.push(normalized); else malformedCount += 1;
  });
  const idCounts = new Map<string, number>();
  for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  const duplicateIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id).sort();
  const knownIds = new Set(entries.map(entry => entry.id));
  const relations = entries.flatMap(entry => entry.bindings);
  const danglingRelations = relations.filter(relation => !knownIds.has(relation.targetId));
  const sceneBounds = bounds(entries);
  return {
    revision, revisionNumber: Number.parseInt(revision.slice(0, 12), 16), bounds: sceneBounds,
    coverage: {
      rawCount: input.length, liveCount: input.length - deletedCount,
      indexedCount: entries.length, deletedCount, malformedCount,
      duplicateIdCount: duplicateIds.length, relationCount: relations.length,
      danglingRelationCount: danglingRelations.length,
      complete: malformedCount === 0 && duplicateIds.length === 0,
    },
    duplicateIds, danglingRelations: danglingRelations.slice(0, 50),
    regions: buildRegions(entries, sceneBounds), entries,
  };
}

function overlaps(entry: CanvasSceneIndexEntry, region: NonNullable<CanvasSceneQuery["region"]>) {
  return !(entry.x + entry.canvasFrameWidth < region.minX || entry.x > region.maxX
    || entry.y + entry.canvasFrameHeight < region.minY || entry.y > region.maxY);
}

function queryFingerprint(query: CanvasSceneQuery): string {
  return createHash("sha256").update(JSON.stringify({
    elementId: query.elementId ?? null, text: query.text?.toLocaleLowerCase() ?? null,
    groupId: query.groupId ?? null, types: [...(query.types ?? [])].sort(), region: query.region ?? null,
    selectedIds: [...(query.selectedIds ?? [])],
  })).digest("hex").slice(0, 24);
}

function decodeCursor(cursor: string): { revision: string; fingerprint: string; offset: number } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return value?.v === 1 && typeof value.revision === "string" && typeof value.fingerprint === "string"
      && Number.isSafeInteger(value.offset) && value.offset >= 0 ? value : null;
  } catch { return null; }
}

function encodeCursor(revision: string, fingerprint: string, offset: number) {
  return Buffer.from(JSON.stringify({ v: 1, revision, fingerprint, offset }), "utf8").toString("base64url");
}

export function queryCanvasScene(index: CanvasSceneIndex, query: CanvasSceneQuery) {
  const fingerprint = queryFingerprint(query);
  const decoded = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !decoded) return { error: "invalid_canvas_cursor" as const };
  if (decoded && decoded.revision !== index.revision) return { error: "canvas_revision_changed" as const, revision: index.revision };
  if (decoded && decoded.fingerprint !== fingerprint) return { error: "canvas_cursor_query_mismatch" as const, revision: index.revision };
  const selected = new Set(query.selectedIds ?? []);
  const text = query.text?.trim().toLocaleLowerCase();
  let matches = index.entries.filter(entry =>
    (!query.elementId || entry.id === query.elementId)
    && (!query.groupId || entry.groupIds.includes(query.groupId))
    && (!query.types?.length || query.types.includes(entry.logicalType))
    && (!query.region || overlaps(entry, query.region))
    && (!text || [entry.text, entry.title, entry.name, entry.role].some(value => value?.toLocaleLowerCase().includes(text))));
  matches = matches.sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || compareCanvasOrder(a, b));
  const offset = decoded?.offset ?? 0;
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 40)));
  const page = matches.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    revision: index.revision, matchedCount: matches.length, returnedCount: page.length,
    offset, truncated: nextOffset < matches.length,
    nextCursor: nextOffset < matches.length ? encodeCursor(index.revision, fingerprint, nextOffset) : null,
    entries: page,
  };
}

/**
 * The model-facing projection of one canvas entry.
 *
 * Two things are stated here structurally rather than left to the reader:
 *
 * - The display frame is a nested `image_canvas_frame` object, not a bare
 *   `width`/`height` beside an image id. A bare pair is exactly what a status
 *   answer reported as the 880x1184 PNG's "实际像素" when it was really the
 *   381x512 Excalidraw frame. The two sizes this layer cannot know are named as
 *   explicit unknowns instead of being omitted, because an absent key reads as
 *   "not applicable" and silently invites a substitute.
 * - `id` (the element id) and `assetId` are carried next to `canvas_index`
 *   (never instead of it), and `assetIdentitySource: "unbacked"` names the
 *   no-asset case positively instead of leaving `assetId` merely absent.
 */
export function compactSceneEntry(entry: CanvasSceneIndexEntry) {
  const { raw: _raw, ordinal, canvasFrameWidth, canvasFrameHeight, ...rest } = entry;
  return { ...rest,
    // `canvas_index` is presentation order only; `id` (element_id) and `assetId`
    // are the durable references, and the notes say so in prose as well.
    canvas_index: ordinal,
    canvas_frame_width: canvasFrameWidth,
    canvas_frame_height: canvasFrameHeight,
    ...(rest.logicalType === "image" ? {
      // The same frame once more, but nested under a name that cannot be read as
      // "the image's pixels", with the other three sizes of this image named as
      // explicit unknowns. An absent key reads as "not applicable"; `null` plus
      // image_size_authority reads as "not answerable from this surface".
      image_canvas_frame: { width: canvasFrameWidth, height: canvasFrameHeight, source_of_truth: "canvas element display frame" },
      image_source_pixels: null,
      image_requested_frame: null,
      image_export_size: null,
      image_size_authority: CHECKED_SIZE_NOTES.long,
    } : {}),
    ...(rest.text && rest.text.length > 240 ? { text: rest.text.slice(0, 237) + "..." } : {}),
    bindings: rest.bindings.slice(0, 20),
  };
}

export function renderCanvasSceneContext(
  index: CanvasSceneIndex,
  selectedIds: readonly string[] = [],
  maxCharacters = 12_000,
  options: { omitImageRepresentativeDetails?: boolean } = {},
): string | null {
  if (!index.coverage.liveCount) return null;
  const selected = new Set(selectedIds);
  const representatives = index.entries
    .filter(entry => (selected.has(entry.id) || index.regions.some(region => region.sampleElementIds.includes(entry.id)))
      && (!options.omitImageRepresentativeDetails || entry.logicalType !== "image"))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || compareCanvasOrder(a, b));
  const coverageLine = `Coverage: globalMapComplete=${index.coverage.complete}; detailTruncated=${representatives.length < index.coverage.indexedCount}; use inspect_canvas with filters and revision-bound cursor to page every matching element.`;
  // The semantic notes and the coverage line ride the always-present tail: they
  // are the facts a status answer got wrong (what a width/height is, which order
  // the entries are in, which id is the durable reference) plus the statement of
  // what this read did not cover. They are therefore budgeted FIRST and never
  // dropped; only regions and representatives are trimmed to fit.
  const fullTail = `${CHECKED_SIZE_NOTES.long}\n${CANVAS_IDENTITY_NOTE}\n${CANVAS_ORDER_NOTE}\n${coverageLine}`;
  // Below this the whole contract cannot coexist with any detail, so the answer
  // is notes-only rather than a body that pushed the note off the end. The note
  // set then falls back to its short forms, which still name all four sizes and
  // both identity fields — the alternative was a listing that states the rule
  // only for the sizes that happened to fit.
  const shortTail = `${CHECKED_SIZE_NOTES.short}\n${CANVAS_IDENTITY_NOTE_SHORT}\n${CANVAS_ORDER_NOTE_SHORT}\n${coverageLine}`;
  if (fullTail.length > maxCharacters) {
    return (shortTail.length <= maxCharacters ? shortTail : CHECKED_SIZE_NOTES.short).slice(0, maxCharacters);
  }
  const tail = fullTail;
  const bodyLimit = Math.max(0, maxCharacters - tail.length - 1);
  const lines = [
    `Canvas scene index revision=${index.revision.slice(0, 16)} raw=${index.coverage.rawCount} live=${index.coverage.liveCount} indexed=${index.coverage.indexedCount} deleted=${index.coverage.deletedCount} malformed=${index.coverage.malformedCount} duplicateIds=${index.coverage.duplicateIdCount}`,
    `Global bounds (${Math.round(index.bounds.minX)},${Math.round(index.bounds.minY)})→(${Math.round(index.bounds.maxX)},${Math.round(index.bounds.maxY)}); regions=${index.regions.length}; relationEdges=${index.coverage.relationCount}; dangling=${index.coverage.danglingRelationCount}`,
    ...index.regions.map(region => `Region ${region.id}: count=${region.count} bounds=(${Math.round(region.bounds.minX)},${Math.round(region.bounds.minY)})→(${Math.round(region.bounds.maxX)},${Math.round(region.bounds.maxY)}) types=${JSON.stringify(region.types)} samples=${region.sampleElementIds.join(",")}${region.textSamples.length ? ` text=${JSON.stringify(region.textSamples)}` : ""}`),
    `Representative details (selected first; ${representatives.length}/${index.coverage.indexedCount}; region aggregates above cover every indexed element):`,
  ];
  let bodyLength = lines.reduce((total, line) => total + line.length + 1, 0);
  for (const entry of representatives) {
    const relation = [entry.frameId ? `frame=${entry.frameId}` : "", entry.containerId ? `container=${entry.containerId}` : "",
      entry.groupIds.length ? `groups=${entry.groupIds.join(",")}` : "", entry.bindings.length ? `links=${entry.bindings.map(link => `${link.kind}:${link.targetId}`).join(",")}` : ""].filter(Boolean).join(" ");
    // `canvasFrame=` keeps its historical label (existing answers and tests read
    // it) but is now always accompanied by the identity label that says which id
    // is durable, so the ordinal can no longer be read as the reference.
    const line = `${selected.has(entry.id) ? "SELECTED " : ""}${entry.logicalType}#${entry.id} canvasIndex=${entry.ordinal} @(${Math.round(entry.x)},${Math.round(entry.y)}) canvasFrame=${Math.round(entry.canvasFrameWidth)}x${Math.round(entry.canvasFrameHeight)}${entry.assetId ? ` assetId=${entry.assetId}` : ""} ${canvasIdentityLabel(entry)}${entry.generationStatus ? ` generationStatus=${entry.generationStatus}${entry.generationJobId ? ` jobId=${entry.generationJobId}` : ""}` : ""}${entry.text ? ` text=${JSON.stringify(entry.text.slice(0, 160))}` : ""}${relation ? ` ${relation}` : ""}`;
    if (bodyLength + line.length > bodyLimit) break;
    lines.push(line);
    bodyLength += line.length + 1;
  }
  const body = lines.join("\n").slice(0, bodyLimit);
  return body ? `${body}\n${tail}` : tail;
}
