import {
  buildCanvasSceneIndex,
  type CanvasSceneIndex,
  type CanvasSceneIndexEntry,
} from "./canvas-scene-index.js";

/**
 * Passive canvas-image context is deliberately small. This limit does not
 * apply to images that the user explicitly attached or later places in an
 * image-generation proposal.
 */
export const MAX_RELATED_IMAGE_CANDIDATES = 10;
export const DEFAULT_PASSIVE_IMAGE_INPUT_LIMIT = 3;
const MAX_CANDIDATE_NAME_LENGTH = 120;
const MAX_CANDIDATE_TITLE_LENGTH = 160;
const MAX_CANDIDATE_ROLE_LENGTH = 80;

export type RelatedImageCandidate = {
  /** Stable canvas element identity. Use this to resolve a canvas image. */
  elementId: string;
  /** Authenticated backing asset identity when the canvas provides one. */
  assetId?: string;
  name?: string;
  title?: string;
  role?: string;
  /** "selected" is an explicit current-canvas choice, not relevance guesswork. */
  priority: "selected" | "recent";
};

export type RelatedImageContext = {
  /**
   * Bounded, passive metadata only. It is safe to put this in model context;
   * it neither authorizes nor implicitly adds a generation source.
   */
  candidates: RelatedImageCandidate[];
  /**
   * A small subset of passive candidates suitable for optional vision input.
   * Explicit attachment references are intentionally absent: their complete
   * source list remains owned by the current request/proposal path.
   */
  passiveImageElementIds: string[];
  /**
   * Kept separately and without a passive-context cap. Consumers must retain
   * them verbatim, including references from history that are fetched on
   * demand, rather than replacing them with a "recent" candidate.
   */
  explicitSourceIds: string[];
};

function uniqueIds(ids: readonly string[] | undefined): string[] {
  if (!ids) return [];
  const seen = new Set<string>();
  return ids.flatMap(id => {
    const normalized = typeof id === "string" ? id.trim() : "";
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function isImage(entry: CanvasSceneIndexEntry): boolean {
  // "logicalType" already excludes image-backed videos. Passive image context
  // must not accidentally turn a video node into an image reference.
  return entry.logicalType === "image";
}

function candidateFrom(entry: CanvasSceneIndexEntry, priority: RelatedImageCandidate["priority"]): RelatedImageCandidate {
  return {
    elementId: entry.id,
    ...(entry.assetId ? { assetId: entry.assetId } : {}),
    ...(entry.name ? { name: truncateMetadata(entry.name, MAX_CANDIDATE_NAME_LENGTH) } : {}),
    ...(entry.title ? { title: truncateMetadata(entry.title, MAX_CANDIDATE_TITLE_LENGTH) } : {}),
    ...(entry.role ? { role: truncateMetadata(entry.role, MAX_CANDIDATE_ROLE_LENGTH) } : {}),
    priority,
  };
}

function truncateMetadata(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * Select passive image context from a complete scene without mutating or
 * truncating the scene used by authorization/read tools. The canvas array's
 * stable ordinal is the only available recency signal, so later live images
 * are preferred after currently selected images.
 */
export function selectRelatedImageContext(input: {
  elements: unknown;
  selectedElementIds?: readonly string[];
  explicitSourceIds?: readonly string[];
  maxCandidates?: number;
  maxPassiveImageInputs?: number;
  /** Reuse an already-built index for the same scene instead of rebuilding. */
  sceneIndex?: CanvasSceneIndex;
}): RelatedImageContext {
  const explicitSourceIds = uniqueIds(input.explicitSourceIds);
  const selected = new Set(uniqueIds(input.selectedElementIds));
  const maxCandidates = Math.min(
    MAX_RELATED_IMAGE_CANDIDATES,
    Math.max(0, Math.floor(input.maxCandidates ?? MAX_RELATED_IMAGE_CANDIDATES)),
  );
  const maxPassiveImageInputs = Math.min(
    DEFAULT_PASSIVE_IMAGE_INPUT_LIMIT,
    Math.max(0, Math.floor(input.maxPassiveImageInputs ?? DEFAULT_PASSIVE_IMAGE_INPUT_LIMIT)),
  );
  const imageEntries = (input.sceneIndex ?? buildCanvasSceneIndex(input.elements)).entries.filter(isImage);

  // Deduplicate canvas representations of one backing asset, keeping the
  // selected representation first. Element IDs remain the references passed
  // to the canvas attachment resolver, and are never rewritten to asset IDs.
  const seen = new Set<string>();
  const unique = (entries: readonly CanvasSceneIndexEntry[]) => entries.filter(entry => {
    const key = entry.assetId ? `asset:${entry.assetId}` : `element:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selectedEntries = unique(imageEntries.filter(entry => selected.has(entry.id)));
  const recentEntries = unique([...imageEntries]
    .filter(entry => !selected.has(entry.id))
    .sort((a, b) => b.ordinal - a.ordinal));
  const candidates = [
    ...selectedEntries.map(entry => candidateFrom(entry, "selected")),
    ...recentEntries.map(entry => candidateFrom(entry, "recent")),
  ].slice(0, maxCandidates);

  return {
    candidates,
    passiveImageElementIds: candidates.slice(0, maxPassiveImageInputs).map(candidate => candidate.elementId),
    explicitSourceIds,
  };
}

/** Render only passive metadata; this does not authorize any inputImages. */
export function renderRelatedImageContext(context: RelatedImageContext): string | null {
  if (!context.candidates.length) return null;
  const lines = context.candidates.map((candidate, index) => [
    `<image index="${index + 1}" element_id="${escapeXml(candidate.elementId)}"`,
    candidate.assetId ? ` asset_id="${escapeXml(candidate.assetId)}"` : "",
    candidate.name ? ` name="${escapeXml(candidate.name)}"` : "",
    candidate.title ? ` title="${escapeXml(candidate.title)}"` : "",
    candidate.role ? ` role="${escapeXml(candidate.role)}"` : "",
    ` priority="${candidate.priority}" />`,
  ].join(""));
  return [
    `<related_image_candidates count="${context.candidates.length}" passive_input_eligible_count="${context.passiveImageElementIds.length}">`,
    "These are bounded passive canvas metadata, not authorized generation sources. Keep every explicit current attachment/source unchanged; inspect or request a source before using it.",
    ...lines.map(line => `  ${line}`),
    "</related_image_candidates>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&\"']/g, character => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;",
  })[character]!);
}
