import { createHash } from "node:crypto";

export type CanvasSceneElement = Record<string, unknown>;
export type CanvasSceneBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type CanvasSceneRelation = { kind: string; targetId: string };
export type CanvasSceneIndexEntry = {
  ordinal: number;
  id: string;
  type: string;
  logicalType: string;
  x: number;
  y: number;
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
  matches = matches.sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.ordinal - b.ordinal);
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
  const { raw: _raw, ordinal: _ordinal, ...rest } = entry;
  return { ...rest,
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
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.ordinal - b.ordinal);
  const coverageLine = `Coverage: globalMapComplete=${index.coverage.complete}; detailTruncated=${representatives.length < index.coverage.indexedCount}; use inspect_canvas with filters and revision-bound cursor to page every matching element.`;
  const bodyLimit = Math.max(0, maxCharacters - coverageLine.length - 1);
  const lines = [
    `Canvas scene index revision=${index.revision.slice(0, 16)} raw=${index.coverage.rawCount} live=${index.coverage.liveCount} indexed=${index.coverage.indexedCount} deleted=${index.coverage.deletedCount} malformed=${index.coverage.malformedCount} duplicateIds=${index.coverage.duplicateIdCount}`,
    `Global bounds (${Math.round(index.bounds.minX)},${Math.round(index.bounds.minY)})→(${Math.round(index.bounds.maxX)},${Math.round(index.bounds.maxY)}); regions=${index.regions.length}; relationEdges=${index.coverage.relationCount}; dangling=${index.coverage.danglingRelationCount}`,
    ...index.regions.map(region => `Region ${region.id}: count=${region.count} bounds=(${Math.round(region.bounds.minX)},${Math.round(region.bounds.minY)})→(${Math.round(region.bounds.maxX)},${Math.round(region.bounds.maxY)}) types=${JSON.stringify(region.types)} samples=${region.sampleElementIds.join(",")}${region.textSamples.length ? ` text=${JSON.stringify(region.textSamples)}` : ""}`),
    `Representative details (selected first; ${representatives.length}/${index.coverage.indexedCount}; region aggregates above cover every indexed element):`,
  ];
  for (const entry of representatives) {
    const relation = [entry.frameId ? `frame=${entry.frameId}` : "", entry.containerId ? `container=${entry.containerId}` : "",
      entry.groupIds.length ? `groups=${entry.groupIds.join(",")}` : "", entry.bindings.length ? `links=${entry.bindings.map(link => `${link.kind}:${link.targetId}`).join(",")}` : ""].filter(Boolean).join(" ");
    lines.push(`${selected.has(entry.id) ? "SELECTED " : ""}${entry.logicalType}#${entry.id} @(${Math.round(entry.x)},${Math.round(entry.y)}) ${Math.round(entry.width)}x${Math.round(entry.height)}${entry.assetId ? ` assetId=${entry.assetId}` : ""}${entry.text ? ` text=${JSON.stringify(entry.text.slice(0, 160))}` : ""}${relation ? ` ${relation}` : ""}`);
    if (lines.join("\n").length > bodyLimit) { lines.pop(); break; }
  }
  const body = lines.join("\n").slice(0, bodyLimit);
  return body ? `${body}\n${coverageLine}` : coverageLine.slice(0, maxCharacters);
}
