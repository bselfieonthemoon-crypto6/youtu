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
   * CANVAS DISPLAY FRAME — never the source image's pixel size.
   *
   * Both come from the Excalidraw element, so a generated 880x1184 PNG is
   * carried by a 381x512 frame. A status answer once reported that frame as
   * "实际像素". The real pixels exist only on the job receipt
   * (`background_jobs.result.width/height`); `public.asset_objects` has no
   * width/height columns and the canvas document never stores them.
   */
  width: number;
  height: number;
  text?: string;
  name?: string;
  role?: string;
  title?: string;
  assetId?: string;
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
 * The one order every canvas listing uses, and the label that says so.
 *
 * These two notes travel with every rendered/JSON canvas observation because
 * both defects they prevent were silent: a status answer reported an element's
 * 381x512 display frame as the 880x1184 PNG's "实际像素", and reversed two
 * same-size square images because nothing stated which order it was listing.
 */
export const CANVAS_FRAME_DIMENSION_NOTE = "Dimension note: canvas_frame_width/height (canvasFrame=) is the element's CANVAS DISPLAY FRAME on the canvas, not the image's 原始像素 (source pixel size); source pixels are only on the generation job receipt (background_jobs.result.width/height, surfaced as recentJobs[].sourcePixelWidth/Height) or the chat card image artifact.";
export const CANVAS_ORDER_NOTE = "Order note: entries are in canvas order, ascending canvas_index (the element's position in the canvas document), deterministic and identical across repeated reads.";

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
    x, y, width, height,
    ...(text ? { text } : {}), ...(name ? { name } : {}),
    ...(role ? { role } : {}), ...(title ? { title } : {}),
    ...(assetId ? { assetId } : {}),
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
    maxX: Math.max(result.maxX, entry.x + entry.width), maxY: Math.max(result.maxY, entry.y + entry.height),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function buildRegions(entries: readonly CanvasSceneIndexEntry[], sceneBounds: CanvasSceneBounds): CanvasSceneRegion[] {
  const width = Math.max(1, sceneBounds.maxX - sceneBounds.minX);
  const height = Math.max(1, sceneBounds.maxY - sceneBounds.minY);
  const regions = new Map<string, CanvasSceneRegion>();
  for (const entry of entries) {
    const centerX = entry.x + entry.width / 2;
    const centerY = entry.y + entry.height / 2;
    const column = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((centerX - sceneBounds.minX) / width * GRID_SIZE)));
    const row = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((centerY - sceneBounds.minY) / height * GRID_SIZE)));
    const id = `r${row}c${column}`;
    const region = regions.get(id) ?? {
      id, bounds: { minX: entry.x, minY: entry.y, maxX: entry.x + entry.width, maxY: entry.y + entry.height },
      count: 0, types: {}, sampleElementIds: [], textSamples: [],
    };
    region.count += 1;
    region.bounds = {
      minX: Math.min(region.bounds.minX, entry.x), minY: Math.min(region.bounds.minY, entry.y),
      maxX: Math.max(region.bounds.maxX, entry.x + entry.width), maxY: Math.max(region.bounds.maxY, entry.y + entry.height),
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
  return !(entry.x + entry.width < region.minX || entry.x > region.maxX
    || entry.y + entry.height < region.minY || entry.y > region.maxY);
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

export function compactSceneEntry(entry: CanvasSceneIndexEntry) {
  const { raw: _raw, ordinal, width, height, ...rest } = entry;
  return { ...rest,
    // Both fields are renamed rather than merely documented: the model reads
    // this JSON, and a bare `width`/`height` beside an image id is exactly what
    // got reported as the source PNG's pixel size. `canvas_index` is the stable
    // ordinal a later observation can be joined and re-ordered against.
    canvas_index: ordinal,
    canvas_frame_width: width,
    canvas_frame_height: height,
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
  // The two semantic notes ride the always-present tail, like `coverageLine`:
  // they are the fact a status answer got wrong, so a tight budget must drop
  // regions or representatives rather than the sentence that says what a
  // width/height is and which order the entries are in.
  const notes = `${CANVAS_FRAME_DIMENSION_NOTE}\n${CANVAS_ORDER_NOTE}\n${coverageLine}`;
  const bodyLimit = Math.max(0, maxCharacters - notes.length - 1);
  const lines = [
    `Canvas scene index revision=${index.revision.slice(0, 16)} raw=${index.coverage.rawCount} live=${index.coverage.liveCount} indexed=${index.coverage.indexedCount} deleted=${index.coverage.deletedCount} malformed=${index.coverage.malformedCount} duplicateIds=${index.coverage.duplicateIdCount}`,
    `Global bounds (${Math.round(index.bounds.minX)},${Math.round(index.bounds.minY)})→(${Math.round(index.bounds.maxX)},${Math.round(index.bounds.maxY)}); regions=${index.regions.length}; relationEdges=${index.coverage.relationCount}; dangling=${index.coverage.danglingRelationCount}`,
    ...index.regions.map(region => `Region ${region.id}: count=${region.count} bounds=(${Math.round(region.bounds.minX)},${Math.round(region.bounds.minY)})→(${Math.round(region.bounds.maxX)},${Math.round(region.bounds.maxY)}) types=${JSON.stringify(region.types)} samples=${region.sampleElementIds.join(",")}${region.textSamples.length ? ` text=${JSON.stringify(region.textSamples)}` : ""}`),
    `Representative details (selected first; ${representatives.length}/${index.coverage.indexedCount}; region aggregates above cover every indexed element):`,
  ];
  for (const entry of representatives) {
    const relation = [entry.frameId ? `frame=${entry.frameId}` : "", entry.containerId ? `container=${entry.containerId}` : "",
      entry.groupIds.length ? `groups=${entry.groupIds.join(",")}` : "", entry.bindings.length ? `links=${entry.bindings.map(link => `${link.kind}:${link.targetId}`).join(",")}` : ""].filter(Boolean).join(" ");
    lines.push(`${selected.has(entry.id) ? "SELECTED " : ""}${entry.logicalType}#${entry.id} canvasIndex=${entry.ordinal} @(${Math.round(entry.x)},${Math.round(entry.y)}) canvasFrame=${Math.round(entry.width)}x${Math.round(entry.height)}${entry.assetId ? ` assetId=${entry.assetId}` : ""}${entry.generationStatus ? ` generationStatus=${entry.generationStatus}${entry.generationJobId ? ` jobId=${entry.generationJobId}` : ""}` : ""}${entry.text ? ` text=${JSON.stringify(entry.text.slice(0, 160))}` : ""}${relation ? ` ${relation}` : ""}`);
    if (lines.join("\n").length > bodyLimit) { lines.pop(); break; }
  }
  const body = lines.join("\n").slice(0, bodyLimit);
  return body ? `${body}\n${notes}` : notes.slice(0, maxCharacters);
}
