import { z } from "zod";
import {
  CANVAS_IDENTITY_NOTE,
  CANVAS_ORDER_NOTE,
  buildCanvasSceneIndex,
  compactSceneEntry,
  queryCanvasScene,
  renderCanvasSceneContext,
  validatedImageSizeNotes,
  type CanvasSceneIndex,
  type CanvasSceneIndexEntry,
} from "../canvas-scene-index.js";
import { createAgentTool, runContextOf } from "./tool-run-context.js";

/** Checked once at import, like the scene renderer's own copy. */
const SIZE_NOTES = validatedImageSizeNotes("inspect_canvas");

const regionSchema = z.object({
  min_x: z.number().finite(), min_y: z.number().finite(),
  max_x: z.number().finite(), max_y: z.number().finite(),
}).strict().refine(region => region.min_x <= region.max_x && region.min_y <= region.max_y,
  "Region minima must not exceed maxima");

const inspectCanvasSchema = z.object({
  detail_level: z.enum(["summary", "full"]).default("summary")
    .describe("summary returns indexed spatial/relationship facts; full returns bounded raw element pages"),
  element_id: z.string().trim().min(1).max(200).optional()
    .describe("Find every live occurrence of one exact element ID; duplicate IDs are reported, never silently collapsed"),
  filter_text: z.string().trim().min(1).max(500).optional()
    .describe("Case-insensitive substring search over text, title, name, and role"),
  filter_group_id: z.string().trim().min(1).max(200).optional()
    .describe("Return elements belonging to one exact group ID"),
  filter_type: z.array(z.string().trim().min(1).max(80)).max(20).optional()
    .describe("Filter by logical type; video matches image/embeddable elements carrying isVideo metadata"),
  filter_region: regionSchema.optional()
    .describe("Return elements overlapping a finite canvas bounding box, including negative coordinates"),
  selected_element_ids: z.array(z.string().trim().min(1).max(200)).max(100).optional()
    .describe("Read-only priority hint. Pass only the actual selection supplied by server context; it grants no write authority"),
  limit: z.number().int().min(1).max(100).default(40)
    .describe("Maximum elements in this page. Full detail is additionally capped at five to bound context size"),
  cursor: z.string().min(1).max(2000).optional()
    .describe("Opaque cursor from a previous response. It is bound to the canvas revision and exact filters"),
}).strict();

type CanvasElement = Record<string, unknown>;

function boundedFull(entry: CanvasSceneIndexEntry): Record<string, unknown> {
  try {
    // Budget is UTF-8 bytes on the wire, not UTF-16 code units.
    if (Buffer.byteLength(JSON.stringify(entry.raw), "utf8") <= 20_000) return entry.raw;
  } catch { /* Canvas JSON should be serializable; fail closed to compact facts. */ }
  return { ...compactSceneEntry(entry), rawPropertiesTruncated: true };
}

export function buildCanvasSummaryForContext(
  elements: Array<Record<string, unknown>>,
  options: { selectedElementIds?: readonly string[]; maxCharacters?: number; omitImageRepresentativeDetails?: boolean; sceneIndex?: CanvasSceneIndex } = {},
): string | null {
  return renderCanvasSceneContext(options.sceneIndex ?? buildCanvasSceneIndex(elements), options.selectedElementIds ?? [], options.maxCharacters,
    ...(options.omitImageRepresentativeDetails === undefined
      ? []
      : [{ omitImageRepresentativeDetails: options.omitImageRepresentativeDetails }]));
}

export function createInspectCanvasTool(deps: { createUserClient: (accessToken: string) => any }) {
  return createAgentTool({
    id: "inspect_canvas",
    description: "Inspect a revision-bound global index of the current infinite canvas. Every response states source coverage, malformed/duplicate facts, global spatial regions and pagination truncation. Query all live elements safely by exact ID, text, type, group or finite region; follow nextCursor without changing filters. A cursor fails if the canvas revision changes, preventing mixed snapshots. Selected elements can be prioritized but selection is read-only evidence, not write permission. Elements are always returned in stable canvas order (canvas_index) and every element's durable identity is its id (with assetId when the canvas carries one) — canvas_index is presentation order only, never an image's identity. For images, image_canvas_frame/image_source_pixels/image_requested_frame/image_export_size state all four sizes and which of them this surface can answer; read dimensions.note for where the other three really live.",
    inputSchema: inspectCanvasSchema,
    execute: async (input, context) => {
    const runContext = runContextOf(context);
    const canvasId = runContext.canvas_id as string | undefined;
    const accessToken = runContext.access_token as string | undefined;
    if (!canvasId || !accessToken) return JSON.stringify({
      error: "no_canvas_context", message: "This tool requires an authenticated canvas context.",
    });

    const client = deps.createUserClient(accessToken);
    const { data, error } = await client.from("canvases").select("content,revision").eq("id", canvasId).single();
    if (error || !data) return JSON.stringify({
      error: "canvas_not_found", message: "Canvas not found or access denied.",
    });
    const content = data.content as { elements?: CanvasElement[]; appState?: Record<string, unknown> };
    const index = buildCanvasSceneIndex(content.elements ?? []);
    const effectiveLimit = input.detail_level === "full" ? Math.min(input.limit, 5) : input.limit;
    const result = queryCanvasScene(index, {
      ...(input.element_id ? { elementId: input.element_id } : {}),
      ...(input.filter_text ? { text: input.filter_text } : {}),
      ...(input.filter_group_id ? { groupId: input.filter_group_id } : {}),
      ...(input.filter_type ? { types: input.filter_type } : {}),
      ...(input.filter_region ? { region: {
        minX: input.filter_region.min_x, minY: input.filter_region.min_y,
        maxX: input.filter_region.max_x, maxY: input.filter_region.max_y,
      } } : {}),
      ...(input.selected_element_ids ? { selectedIds: input.selected_element_ids } : {}),
      limit: effectiveLimit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    if ("error" in result) return JSON.stringify({
      ...result, canvasId,
      message: result.error === "canvas_revision_changed"
        ? "Canvas changed between pages. Restart the query without the old cursor."
        : "The cursor does not belong to this exact canvas query.",
    });
    return JSON.stringify({
      canvasId, revision: result.revision,
      canvas_revision: Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : null,
      revisionUsage: "canvas_revision is the database integer for expected_canvas_revision in write tools; revision is only the scene pagination fingerprint.",
      coverage: index.coverage,
      // A status answer reported an element's canvas display frame (381x512) as
      // an 880x1184 PNG's "实际像素". The canvas document cannot answer that
      // question, so every response states what its numbers mean, where the real
      // pixels live, and that the element id — not canvas_index — is the durable
      // reference to this image.
      dimensions: { note: SIZE_NOTES.long, order: CANVAS_ORDER_NOTE, identity: CANVAS_IDENTITY_NOTE },
      duplicateIds: index.duplicateIds.slice(0, 50), danglingRelations: index.danglingRelations,
      globalMap: { bounds: index.bounds, regions: index.regions },
      query: { matchedCount: result.matchedCount, returnedCount: result.returnedCount,
        offset: result.offset, truncated: result.truncated, nextCursor: result.nextCursor, effectiveLimit },
      viewport: { backgroundColor: (content.appState as any)?.viewBackgroundColor ?? "#ffffff" },
      elements: result.entries.map(entry => input.detail_level === "full" ? boundedFull(entry) : compactSceneEntry(entry)),
    });
    },
  });
}
