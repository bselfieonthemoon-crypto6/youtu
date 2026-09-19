import { z } from "zod";
import { createAgentTool, runContextOf } from "./tool-run-context.js";
import type { CanvasContent } from "@loomic/shared";
import { mergeCanvasContent } from "../../features/canvas/canvas-content-merge.js";
import {
  garbageCollectOrphanAssets,
  reconcileCanvasAssetReferences,
} from "../../features/canvas/canvas-asset-references.js";
import {
  assertDestructiveTargetsUnchanged,
  type DestructiveConfirmationService,
  type DestructiveProposal,
  type DestructiveTarget,
  type FrozenCanvasOperation,
} from "../../features/agent-actions/destructive-confirmation-service.js";
import {
  type CanvasElement,
  type HandlerResult,
  generateId,
  measureTextWidth,
  coerceColor,
  createElementBase,
  bumpVersion,
  findElement,
  shortLabel,
  ensureBoundElements,
  validateBindings,
  BINDING_GAP,
  getElementCenter,
  computeEdgePoint,
  computeFixedPoint,
} from "./canvas-element-helpers.js";

// Re-export for consumers that import measureTextWidth from this module
// (e.g. the test suite). New code should import directly from canvas-element-helpers.
export { measureTextWidth } from "./canvas-element-helpers.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Note: color coercion (number → hex string) moved to runtime handler.
// Gemini cannot represent z.preprocess/z.transform in JSON Schema.

const labelSchema = z
  .object({
    text: z.string().min(1).describe("Label text centered inside the shape"),
    fontSize: z.number().default(20).describe("Label font size"),
    strokeColor: z.string().default("#000000").describe("Label text color hex"),
  })
  .optional()
  .describe("Optional centered text label inside the shape");

// Flat object schema — Gemini doesn't support union/oneOf/anyOf in tool params.
// All fields are optional; which ones are required depends on `action`.
const operationSchema = z.object({
  action: z
    .enum([
      "move", "resize", "delete", "update_style",
      "add_text", "add_shape", "add_line",
      "reorder", "align", "distribute", "update_text",
    ])
    .describe("The operation to perform"),

  // Common: target element ID (move, resize, delete, update_style, reorder)
  element_id: z.string().optional().describe("ID of element to operate on"),

  // Position / size
  x: z.number().optional().describe("X coordinate"),
  y: z.number().optional().describe("Y coordinate"),
  width: z.number().optional().describe("Width"),
  height: z.number().optional().describe("Height"),

  // Style (update_style, add_shape, add_line, add_text)
  strokeColor: z.string().optional().describe("Stroke/text color hex, e.g. #FF0000"),
  backgroundColor: z.string().optional().describe("Fill color hex"),
  opacity: z.number().optional().describe("Opacity 0-100"),
  fontSize: z.number().optional().describe("Font size"),
  strokeWidth: z.number().optional().describe("Stroke width"),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional().describe("Fill style"),

  // add_text / update_text
  text: z.string().optional().describe("Text content (add_text / update_text)"),

  // add_shape
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional().describe("Shape type (add_shape)"),
  label: labelSchema,

  // add_line
  line_type: z.enum(["line", "arrow"]).optional().describe("Line or arrow (add_line)"),
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe("Array of {x,y} points (add_line, optional when using bindings)"),
  start_element_id: z.string().optional().describe("Bind arrow start to this element ID"),
  end_element_id: z.string().optional().describe("Bind arrow end to this element ID"),

  // reorder
  position: z.enum(["front", "back"]).optional().describe("Bring to front or send to back (reorder)"),

  // align / distribute
  element_ids: z.array(z.string()).optional().describe("IDs of elements (align/distribute)"),
  alignment: z
    .enum(["left", "right", "center", "top", "bottom", "middle"])
    .optional()
    .describe("Alignment direction (align)"),
  direction: z.enum(["horizontal", "vertical"]).optional().describe("Distribution direction (distribute)"),
}).superRefine((value, context) => {
  // Fields are flat/optional for provider compatibility, so require the exact
  // subset each action needs. Without this an omitted x/width/text is written
  // as `undefined` and corrupts the persisted element.
  const need = (field: keyof typeof value, label: string) => {
    if (value[field] === undefined || value[field] === null)
      context.addIssue({ code: "custom", message: `${value.action} requires ${label}.` });
  };
  switch (value.action) {
    case "move":
      need("element_id", "element_id"); need("x", "x"); need("y", "y"); break;
    case "resize":
      need("element_id", "element_id"); need("width", "width"); need("height", "height"); break;
    case "delete":
      need("element_id", "element_id"); break;
    case "update_style": {
      need("element_id", "element_id");
      const hasStyle = (["strokeColor", "backgroundColor", "opacity", "fontSize", "strokeWidth"] as const)
        .some(key => value[key] !== undefined);
      if (!hasStyle) context.addIssue({ code: "custom", message: "update_style requires at least one style field." });
      break;
    }
    case "update_text":
      need("element_id", "element_id"); need("text", "text"); break;
    case "add_text":
      need("text", "text"); need("x", "x"); need("y", "y"); break;
    case "add_shape":
      need("shape", "shape"); need("x", "x"); need("y", "y"); break;
    case "add_line": {
      const hasPoints = Array.isArray(value.points) && value.points.length > 0;
      const hasBinding = value.start_element_id !== undefined || value.end_element_id !== undefined;
      if (!hasPoints && !hasBinding)
        context.addIssue({ code: "custom", message: "add_line requires points or element bindings." });
      break;
    }
    case "reorder":
      need("element_id", "element_id"); need("position", "position"); break;
    case "align":
      need("element_ids", "element_ids"); need("alignment", "alignment"); break;
    case "distribute":
      need("element_ids", "element_ids"); need("direction", "direction"); break;
  }
});

const manipulateCanvasSchema = z.object({
  operations: z
    .array(operationSchema)
    .min(1)
    .max(100)
    .describe("List of operations to apply (at most 100)"),
});

// Flat operation type — all fields optional except `action`.
type Operation = z.infer<typeof operationSchema>;

/** Native multi-layer boards are manually edited user content. The Agent can
 * observe them through design read tools, but must not alter their canvas node
 * either directly or by creating/changing bindings to it. */
function isNativeDesignBoardNode(element: CanvasElement): boolean {
  const customData = element.customData;
  return !!customData && typeof customData === "object" && !Array.isArray(customData)
    && (customData as Record<string, unknown>).kind === "loomic-design"
    && typeof (customData as Record<string, unknown>).designId === "string";
}

function nativeDesignBoardSnapshot(elements: readonly CanvasElement[]): string {
  // Include the index and complete node: reordering, changing a boundElements
  // list, tombstoning, or any future handler mutation is a protected change.
  return JSON.stringify(elements.flatMap((element, index) =>
    isNativeDesignBoardNode(element) ? [{ index, element }] : []));
}

function targetsNativeDesignBoard(
  elements: readonly CanvasElement[],
  operations: readonly Operation[],
): boolean {
  const protectedIds = new Set(elements.filter(isNativeDesignBoardNode).map(element => element.id));
  return operations.some(operation => [
    operation.element_id,
    ...(operation.element_ids ?? []),
    operation.start_element_id,
    operation.end_element_id,
  ].some(id => typeof id === "string" && protectedIds.has(id)));
}

const MAX_CANVAS_WRITE_ATTEMPTS = 3;

/** Gap kept between an element nudged aside and the element it avoided. */
const OCCUPANCY_GAP = 24;

/**
 * Destructive canvas operations require an explicit instruction in the raw
 * user message for the current run. This deliberately does not inspect the
 * model's rewritten plan: generating or refining a design never implies that
 * previous results may be removed.
 */
export function hasExplicitCanvasDeleteIntent(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;

  const text = prompt.trim().toLowerCase();
  if (!text) return false;

  const deleteVerb =
    /(?:删除|删掉|删了|移除|清除|清空|去掉|丢弃|delete|remove|clear|discard)/i;
  if (!deleteVerb.test(text)) return false;

  // Prefer preservation whenever the instruction contains an explicit
  // prohibition. Ambiguous mixed instructions should be clarified by the
  // agent instead of risking data loss.
  const preservationInstruction =
    /(?:不要|不准|禁止|别|不可|不能|无需|不用)\s*(?:删除|删掉?|移除|清除|清空|去掉|丢弃)|(?:保留|保存)\s*(?:好|住|着|全部|所有|旧|原|已有)?|(?:do\s+not|don't|dont|never)\s+(?:delete|remove|clear|discard)|(?:keep|preserve)\s+(?:the\s+)?(?:old|existing|previous|all)/i;
  if (preservationInstruction.test(text)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

/** Overlap ratio of `rect` with any other visible element, and the widest one's id. */
function occupancyOf(
  elements: readonly CanvasElement[],
  self: CanvasElement,
  rect: { x: number; y: number; width: number; height: number },
): { ratio: number; withId: string | null } {
  const area = Math.max(1, rect.width * rect.height);
  let worst = 0;
  let withId: string | null = null;
  for (const other of elements) {
    if (other === self || other.id === self.id || other.isDeleted) continue;
    const width = Number(other.width ?? 0);
    const height = Number(other.height ?? 0);
    if (!(width > 0) || !(height > 0)) continue;
    const overlapX = Math.min(rect.x + rect.width, Number(other.x ?? 0) + width) - Math.max(rect.x, Number(other.x ?? 0));
    const overlapY = Math.min(rect.y + rect.height, Number(other.y ?? 0) + height) - Math.max(rect.y, Number(other.y ?? 0));
    if (overlapX <= 0 || overlapY <= 0) continue;
    const ratio = (overlapX * overlapY) / area;
    if (ratio > worst) { worst = ratio; withId = String(other.id); }
  }
  return { ratio: worst, withId };
}

/**
 * Move an element, refusing to drop it on top of another one.
 *
 * A simulated user asked to "put it to the right of the original" and the move
 * landed exactly on top of an existing element (byte-identical x/y/width/height),
 * while the reply claimed it had left "适当间距". When the requested position is
 * mostly occupied the element is nudged to the right — the direction such a request
 * almost always means — and the receipt reports the final coordinates either way.
 */
function applyMove(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  const width = Number(el.width ?? 0);
  const height = Number(el.height ?? 0);
  const requested = { x: Number(op.x), y: Number(op.y) };
  const requestedOccupancy = occupancyOf(elements, el, { ...requested, width, height });
  let placement = requested;
  let avoidedId: string | null = null;
  if (requestedOccupancy.ratio >= 0.5 && requestedOccupancy.withId && width > 0) {
    const occupant = findElement(elements, requestedOccupancy.withId);
    if (occupant) {
      // Land just past the occupied rectangle, keeping the requested top edge.
      const candidateX = Number(occupant.x ?? 0) + Number(occupant.width ?? 0) + OCCUPANCY_GAP;
      const candidate = { x: candidateX, y: requested.y };
      if (occupancyOf(elements, el, { ...candidate, width, height }).ratio < requestedOccupancy.ratio) {
        placement = candidate;
        avoidedId = requestedOccupancy.withId;
      }
    }
  }
  el.x = placement.x;
  el.y = placement.y;
  bumpVersion(el);
  return {
    description: avoidedId
      ? `moved ${shortLabel(el)} to (${placement.x}, ${placement.y}) avoiding the occupied position (${requested.x}, ${requested.y}) held by ${avoidedId}`
      : `moved ${shortLabel(el)} to (${placement.x}, ${placement.y})`,
  };
}

function applyResize(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  el.width = op.width;
  el.height = op.height;
  bumpVersion(el);
  return {
    description: `resized ${shortLabel(el)} to ${op.width}x${op.height}`,
  };
}

/**
 * Delete an element with full cascade:
 * - Marks the target as deleted
 * - Cascades deletion to bound text elements (label cleanup)
 * - Clears startBinding / endBinding on arrows pointing to deleted element
 */
function applyDelete(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };
  el.isDeleted = true;
  bumpVersion(el);

  const cascaded: string[] = [];

  // Cascade to bound text children (labels)
  if (Array.isArray(el.boundElements)) {
    for (const bound of el.boundElements as Array<{ type: string; id: string }>) {
      if (bound.type === "text") {
        const textEl = findElement(elements, bound.id);
        if (textEl) {
          textEl.isDeleted = true;
          bumpVersion(textEl);
          cascaded.push(`text(${bound.id})`);
        }
      }
    }
  }

  // Clean up arrow bindings pointing at the deleted element
  for (const other of elements) {
    if (other.isDeleted) continue;
    const startBinding = other.startBinding as { elementId: string } | null;
    const endBinding = other.endBinding as { elementId: string } | null;
    if (startBinding?.elementId === op.element_id) {
      other.startBinding = null;
      bumpVersion(other);
    }
    if (endBinding?.elementId === op.element_id) {
      other.endBinding = null;
      bumpVersion(other);
    }
  }

  const cascadeInfo = cascaded.length > 0 ? ` (cascaded: ${cascaded.join(", ")})` : "";
  return { description: `deleted ${shortLabel(el)}${cascadeInfo}` };
}

function applyUpdateStyle(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };

  const applied: string[] = [];
  const props = [
    "strokeColor",
    "backgroundColor",
    "opacity",
    "fontSize",
    "strokeWidth",
  ] as const;
  for (const key of props) {
    if (op[key] !== undefined) {
      el[key] = op[key];
      applied.push(key);
    }
  }
  bumpVersion(el);
  return {
    description: `updated ${shortLabel(el)} style: ${applied.join(", ")}`,
  };
}

function applyAddText(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const id = generateId();
  const el: CanvasElement = {
    ...createElementBase(),
    id,
    type: "text",
    text: op.text!,
    x: op.x,
    y: op.y,
    width: measureTextWidth(op.text!, op.fontSize ?? 20),
    height: (op.fontSize ?? 20) * 1.25,
    fontSize: op.fontSize ?? 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    strokeColor: op.strokeColor ?? "#000000",
    containerId: null,
    originalText: op.text!,
    autoResize: true,
    lineHeight: 1.25,
  };
  elements.push(el);
  const short =
    op.text!.length > 20 ? op.text!.slice(0, 17) + "..." : op.text!;
  return {
    description: `added text '${short}' at (${op.x}, ${op.y}) [id=${id}]`,
    createdId: id,
  };
}

/**
 * Update the text content of a standalone text element or a shape's label.
 * Resizes the text element and expands the container if needed.
 */
function applyUpdateText(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const el = findElement(elements, op.element_id!);
  if (!el) return { description: `[skip] element ${op.element_id} not found` };

  let textEl: CanvasElement | undefined;
  if (el.type === "text") {
    textEl = el;
  } else if (Array.isArray(el.boundElements)) {
    const boundText = (el.boundElements as Array<{ type: string; id: string }>).find(
      (b) => b.type === "text",
    );
    if (boundText) textEl = findElement(elements, boundText.id);
  }

  if (!textEl) return { description: `[skip] no text found for element ${op.element_id}` };

  const newText = op.text!;
  const fontSize = (op.fontSize ?? textEl.fontSize ?? 20) as number;
  textEl.text = newText;
  textEl.originalText = newText;

  const lines = newText.split("\n");
  const textWidth = Math.max(...lines.map((l) => measureTextWidth(l, fontSize)));
  const textHeight = lines.length * fontSize * 1.25;
  textEl.width = textWidth;
  textEl.height = textHeight;

  if (op.fontSize !== undefined) textEl.fontSize = fontSize;
  bumpVersion(textEl);

  // Expand container if text no longer fits
  const containerId = textEl.containerId as string | null;
  if (containerId) {
    const container = findElement(elements, containerId);
    if (container) {
      const paddingX = Math.max(fontSize * 1.5, 30);
      const paddingY = Math.max(fontSize * 1.2, 24);
      const minWidth = textWidth + paddingX * 2;
      const minHeight = textHeight + paddingY * 2;
      let resized = false;
      if ((Number(container.width) || 0) < minWidth) { container.width = minWidth; resized = true; }
      if ((Number(container.height) || 0) < minHeight) { container.height = minHeight; resized = true; }
      if (resized) {
        // Re-center text within the (possibly expanded) container
        textEl.x = Number(container.x) + (Number(container.width) - textWidth) / 2;
        textEl.y = Number(container.y) + (Number(container.height) - textHeight) / 2;
        bumpVersion(container);
      }
    }
  }

  const short = newText.length > 20 ? newText.slice(0, 17) + "..." : newText;
  return { description: `updated text to '${short}' on ${op.element_id}` };
}

/**
 * Add a shape with optional centered label.
 * Uses proportional padding based on fontSize to ensure text never overflows.
 * Enforces absolute minimum sizes per shape type.
 */
function applyAddShape(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const shapeId = generateId();
  const el: CanvasElement = {
    ...createElementBase(),
    id: shapeId,
    type: op.shape,
    x: op.x,
    y: op.y,
    width: op.width,
    height: op.height,
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    backgroundColor: coerceColor(op.backgroundColor, "transparent"),
    fillStyle: op.fillStyle ?? "solid",
  };

  if (op.label) {
    const textId = generateId();
    const fontSize = op.label.fontSize;

    // For multi-line labels, measure the longest line and compute total height
    const lines = op.label.text.split("\n");
    const textWidth = Math.max(...lines.map((l) => measureTextWidth(l, fontSize)));
    const textHeight = lines.length * fontSize * 1.25;

    // Proportional padding — scales with font size to avoid overflow at any size
    const paddingX = Math.max(fontSize * 1.5, 30);
    const paddingY = Math.max(fontSize * 1.2, 24);
    const minWidth = textWidth + paddingX * 2;
    const minHeight = textHeight + paddingY * 2;

    // Enforce minimum shape size so text never overflows, plus absolute floor
    el.width = Math.max(Number(el.width) || 0, minWidth, 120);
    el.height = Math.max(Number(el.height) || 0, minHeight, 60);

    // Bind text to shape
    ensureBoundElements(el).push({ type: "text", id: textId });

    const textEl: CanvasElement = {
      ...createElementBase(),
      id: textId,
      type: "text",
      text: op.label.text,
      originalText: op.label.text,
      x: Number(el.x) + (Number(el.width) - textWidth) / 2,
      y: Number(el.y) + (Number(el.height) - textHeight) / 2,
      width: textWidth,
      height: textHeight,
      fontSize,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: coerceColor(op.label.strokeColor, "#000000"),
      containerId: shapeId,
      autoResize: true,
      lineHeight: 1.25,
    };

    elements.push(el);
    elements.push(textEl);

    const short =
      op.label.text.length > 20
        ? op.label.text.slice(0, 17) + "..."
        : op.label.text;
    return {
      description: `added ${op.shape} ${el.width}x${el.height} with label '${short}' at (${op.x}, ${op.y}) [id=${shapeId}]`,
      createdId: shapeId,
    };
  }

  // No label — enforce minimum sizes per shape type
  const shapeType = op.shape as string;
  if (shapeType === "ellipse") {
    el.width = Math.max(Number(el.width) || 0, 140);
    el.height = Math.max(Number(el.height) || 0, 70);
  } else {
    el.width = Math.max(Number(el.width) || 0, 120);
    el.height = Math.max(Number(el.height) || 0, 60);
  }

  elements.push(el);
  return {
    description: `added ${op.shape} ${el.width}x${el.height} at (${op.x}, ${op.y}) [id=${shapeId}]`,
    createdId: shapeId,
  };
}

function applyAddLine(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const hasBinding = op.start_element_id || op.end_element_id;

  if (hasBinding) {
    return applyAddBoundLine(elements, op);
  }

  // Non-binding path: points are required
  if (!op.points || op.points.length < 2) {
    return {
      description:
        "[skip] add_line without bindings requires points (>= 2)",
    };
  }

  // Auto-derive origin from first point if x/y not provided.
  // Excalidraw stores points relative to the element's x/y origin.
  const originX = op.x ?? op.points[0]!.x;
  const originY = op.y ?? op.points[0]!.y;
  const excalidrawPoints = op.points.map((p) => [p.x - originX, p.y - originY]);

  const relXs = excalidrawPoints.map((p) => p[0]!);
  const relYs = excalidrawPoints.map((p) => p[1]!);
  const width = Math.abs(Math.max(...relXs) - Math.min(...relXs));
  const height = Math.abs(Math.max(...relYs) - Math.min(...relYs));

  const arrowId = generateId();
  const el: CanvasElement = {
    ...createElementBase(),
    id: arrowId,
    type: op.line_type ?? "arrow",
    x: originX,
    y: originY,
    width,
    height,
    points: excalidrawPoints,
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    strokeWidth: op.strokeWidth ?? 2,
    lastCommittedPoint: excalidrawPoints[excalidrawPoints.length - 1],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: op.line_type === "arrow" ? "arrow" : null,
  };
  elements.push(el);
  return {
    description: `added ${op.line_type} with ${op.points.length} points at (${originX}, ${originY}) [id=${arrowId}]`,
    createdId: arrowId,
  };
}

/**
 * Add an arrow/line with element bindings.
 * Uses computeFixedPoint to set stable fixedPoint values so Excalidraw does
 * not recompute endpoints when bound shapes are resized.
 */
function applyAddBoundLine(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const startEl = op.start_element_id
    ? findElement(elements, op.start_element_id)
    : null;
  const endEl = op.end_element_id
    ? findElement(elements, op.end_element_id)
    : null;

  if (op.start_element_id && !startEl) {
    return {
      description: `[skip] start element ${op.start_element_id} not found`,
    };
  }
  if (op.end_element_id && !endEl) {
    return {
      description: `[skip] end element ${op.end_element_id} not found`,
    };
  }

  const startCenter = startEl
    ? getElementCenter(startEl)
    : { cx: op.x ?? 0, cy: op.y ?? 0 };
  const endCenter = endEl
    ? getElementCenter(endEl)
    : { cx: (op.x ?? 0) + 100, cy: op.y ?? 0 };

  const startPoint = startEl
    ? computeEdgePoint(startEl, { x: endCenter.cx, y: endCenter.cy })
    : { x: startCenter.cx, y: startCenter.cy };

  const endPoint = endEl
    ? computeEdgePoint(endEl, { x: startCenter.cx, y: startCenter.cy })
    : { x: endCenter.cx, y: endCenter.cy };

  const arrowId = generateId();
  const relEnd = {
    x: endPoint.x - startPoint.x,
    y: endPoint.y - startPoint.y,
  };

  let startBinding: unknown = null;
  let endBinding: unknown = null;

  if (startEl) {
    const fixedPoint = endEl
      ? computeFixedPoint(startEl, endEl)
      : [1, 0.5] as [number, number];
    startBinding = {
      elementId: op.start_element_id,
      focus: 0,
      gap: BINDING_GAP,
      fixedPoint,
    };
    ensureBoundElements(startEl).push({ type: "arrow", id: arrowId });
    bumpVersion(startEl);
  }

  if (endEl) {
    const fixedPoint = startEl
      ? computeFixedPoint(endEl, startEl)
      : [0, 0.5] as [number, number];
    endBinding = {
      elementId: op.end_element_id,
      focus: 0,
      gap: BINDING_GAP,
      fixedPoint,
    };
    ensureBoundElements(endEl).push({ type: "arrow", id: arrowId });
    bumpVersion(endEl);
  }

  const el: CanvasElement = {
    ...createElementBase(),
    id: arrowId,
    type: op.line_type ?? "arrow",
    x: startPoint.x,
    y: startPoint.y,
    width: Math.abs(relEnd.x),
    height: Math.abs(relEnd.y),
    points: [
      [0, 0],
      [relEnd.x, relEnd.y],
    ],
    strokeColor: coerceColor(op.strokeColor, "#000000"),
    strokeWidth: op.strokeWidth ?? 2,
    lastCommittedPoint: [relEnd.x, relEnd.y],
    startBinding,
    endBinding,
    startArrowhead: null,
    endArrowhead: op.line_type === "arrow" || !op.line_type ? "arrow" : null,
  };
  elements.push(el);

  const fromLabel = op.start_element_id ?? "free";
  const toLabel = op.end_element_id ?? "free";
  return {
    description: `added bound ${op.line_type ?? "arrow"} ${fromLabel} → ${toLabel} [id=${arrowId}]`,
    createdId: arrowId,
  };
}

function applyReorder(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const idx = elements.findIndex(
    (el) => el.id === op.element_id && !el.isDeleted,
  );
  if (idx === -1)
    return { description: `[skip] element ${op.element_id} not found` };

  const removed = elements.splice(idx, 1);
  const el = removed[0]!;
  if (op.position === "front") {
    elements.push(el);
  } else {
    elements.unshift(el);
  }
  bumpVersion(el);
  return { description: `reordered ${shortLabel(el)} to ${op.position}` };
}

/**
 * Align/distribute normally legitimately stack their own targets, so they never
 * refuse. They can still drop a target on top of an element that is *not* part of
 * the operation (typically with a negative distribute gap) — report that instead
 * of claiming a clean success so the agent can offer a follow-up move.
 */
function foreignOverlapWarning(
  elements: readonly CanvasElement[],
  targets: readonly CanvasElement[],
): string {
  const targetIds = new Set(targets.map((el) => el.id));
  const others = elements.filter((el) => !targetIds.has(el.id));
  const collisions: string[] = [];
  for (const el of targets) {
    const width = Number(el.width ?? 0);
    const height = Number(el.height ?? 0);
    if (!(width > 0) || !(height > 0)) continue;
    const { ratio, withId } = occupancyOf(others, el, {
      x: Number(el.x) || 0,
      y: Number(el.y) || 0,
      width,
      height,
    });
    if (withId && ratio >= 0.25) {
      collisions.push(`${shortLabel(el)} overlaps ${withId} by ${Math.round(ratio * 100)}%`);
    }
  }
  return collisions.length ? ` warning: ${collisions.join("; ")}` : "";
}

function applyAlign(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const targets = (op.element_ids ?? [])
    .map((id) => findElement(elements, id))
    .filter((el): el is CanvasElement => el !== undefined);

  if (targets.length < 2) {
    return {
      description: `[skip] need >= 2 valid elements to align, found ${targets.length}`,
    };
  }

  switch (op.alignment) {
    case "left": {
      const minX = Math.min(...targets.map((el) => Number(el.x) || 0));
      for (const el of targets) { el.x = minX; bumpVersion(el); }
      break;
    }
    case "right": {
      const maxRight = Math.max(
        ...targets.map((el) => (Number(el.x) || 0) + (Number(el.width) || 0)),
      );
      for (const el of targets) { el.x = maxRight - (Number(el.width) || 0); bumpVersion(el); }
      break;
    }
    case "center": {
      const centers = targets.map(
        (el) => (Number(el.x) || 0) + (Number(el.width) || 0) / 2,
      );
      const avg = centers.reduce((a, b) => a + b, 0) / centers.length;
      for (const el of targets) { el.x = avg - (Number(el.width) || 0) / 2; bumpVersion(el); }
      break;
    }
    case "top": {
      const minY = Math.min(...targets.map((el) => Number(el.y) || 0));
      for (const el of targets) { el.y = minY; bumpVersion(el); }
      break;
    }
    case "bottom": {
      const maxBottom = Math.max(
        ...targets.map((el) => (Number(el.y) || 0) + (Number(el.height) || 0)),
      );
      for (const el of targets) { el.y = maxBottom - (Number(el.height) || 0); bumpVersion(el); }
      break;
    }
    case "middle": {
      const middles = targets.map(
        (el) => (Number(el.y) || 0) + (Number(el.height) || 0) / 2,
      );
      const avg = middles.reduce((a, b) => a + b, 0) / middles.length;
      for (const el of targets) { el.y = avg - (Number(el.height) || 0) / 2; bumpVersion(el); }
      break;
    }
  }

  return {
    description: `aligned ${targets.length} elements ${op.alignment}` +
      foreignOverlapWarning(elements, targets),
  };
}

function applyDistribute(
  elements: CanvasElement[],
  op: Operation,
): HandlerResult {
  const targets = (op.element_ids ?? [])
    .map((id) => findElement(elements, id))
    .filter((el): el is CanvasElement => el !== undefined);

  if (targets.length < 3) {
    return {
      description: `[skip] need >= 3 valid elements to distribute, found ${targets.length}`,
    };
  }

  if (op.direction === "horizontal") {
    targets.sort((a, b) => (Number(a.x) || 0) - (Number(b.x) || 0));
    const first = targets[0]!;
    const last = targets[targets.length - 1]!;
    const totalSpan =
      (Number(last.x) || 0) +
      (Number(last.width) || 0) -
      (Number(first.x) || 0);
    const totalWidths = targets.reduce((sum, el) => sum + (Number(el.width) || 0), 0);
    const gap = (totalSpan - totalWidths) / (targets.length - 1);

    let currentX = Number(first.x) || 0;
    for (const el of targets) {
      el.x = currentX;
      bumpVersion(el);
      currentX += (Number(el.width) || 0) + gap;
    }
  } else {
    targets.sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0));
    const first = targets[0]!;
    const last = targets[targets.length - 1]!;
    const totalSpan =
      (Number(last.y) || 0) +
      (Number(last.height) || 0) -
      (Number(first.y) || 0);
    const totalHeights = targets.reduce((sum, el) => sum + (Number(el.height) || 0), 0);
    const gap = (totalSpan - totalHeights) / (targets.length - 1);

    let currentY = Number(first.y) || 0;
    for (const el of targets) {
      el.y = currentY;
      bumpVersion(el);
      currentY += (Number(el.height) || 0) + gap;
    }
  }

  return {
    description: `distributed ${targets.length} elements ${op.direction}ly` +
      foreignOverlapWarning(elements, targets),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const handlers: Record<
  Operation["action"],
  (elements: CanvasElement[], op: any) => HandlerResult
> = {
  move: applyMove,
  resize: applyResize,
  delete: applyDelete,
  update_style: applyUpdateStyle,
  add_text: applyAddText,
  add_shape: applyAddShape,
  add_line: applyAddLine,
  reorder: applyReorder,
  align: applyAlign,
  distribute: applyDistribute,
  update_text: applyUpdateText,
};

type ManipulationResult = {
  success?: true;
  applied?: number;
  summary?: string;
  createdIds?: Record<string, string>;
  errors?: string[];
  error?:
    | "canvas_not_found"
    | "write_failed"
    | "write_conflict"
    | "native_design_board_protected"
    | "confirmation_required"
    | "confirmation_unavailable"
    | "delete_intent_not_explicit";
  message?: string;
  confirmation?: DestructiveProposal;
};

type ManipulationOptions = {
  confirmationService?: DestructiveConfirmationService;
  userId?: string;
  /** Only the confirmation service's frozen execute closure sets this. */
  destructiveDeletionAuthorized?: boolean;
  expectedDestructiveTargets?: DestructiveTarget[];
};

/**
 * Re-read and re-apply the requested operations after every CAS conflict.
 * This is important for positional operations and bindings: merging a mutation
 * calculated from a stale snapshot is not enough when another writer moved or
 * inserted elements in the meantime.
 */
export async function manipulateCanvasWithCas(
  client: { from: (table: string) => any },
  canvasId: string,
  operations: Operation[],
  _userPrompt: unknown,
  options?: ManipulationOptions,
): Promise<ManipulationResult> {
  for (let attempt = 0; attempt < MAX_CANVAS_WRITE_ATTEMPTS; attempt += 1) {
    const { data, error } = await client
      .from("canvases")
      .select("content, updated_at")
      .eq("id", canvasId)
      .single();

    if (error || !data) {
      return {
        error: "canvas_not_found",
        message: "Canvas not found or access denied.",
      };
    }

    const content = ((data.content as CanvasContent) ?? {
      elements: [],
      appState: {},
      files: {},
    }) as CanvasContent;

    const persistedElements = (content.elements as CanvasElement[] | undefined) ?? [];
    // Reject before creating a destructive-confirmation proposal as well: a
    // later confirmation must never authorize Agent edits to a native board.
    if (targetsNativeDesignBoard(persistedElements, operations)) {
      return {
        error: "native_design_board_protected",
        message: "原生设计画板仅供读取参考，Agent 不能修改、移动、删除、排序或绑定其画布节点。请由用户在手动编辑器中操作。",
      };
    }

    if (
      options?.destructiveDeletionAuthorized &&
      options.expectedDestructiveTargets
    ) {
      // Revalidate inside every CAS attempt. This closes the gap between the
      // confirmation service's check and the actual read-modify-write.
      assertDestructiveTargetsUnchanged(
        content,
        options.expectedDestructiveTargets,
      );
    }

    if (
      operations.some((operation) => operation.action === "delete") &&
      !options?.destructiveDeletionAuthorized
    ) {
      // The model's plan never authorizes deletion: the raw user message for
      // this run must itself request removal. Callers that pass no prompt keep
      // the confirmation-only behavior.
      if (typeof _userPrompt === "string" && _userPrompt.trim().length > 0
        && !hasExplicitCanvasDeleteIntent(_userPrompt)) {
        return {
          error: "delete_intent_not_explicit",
          message: "本轮用户原话未明确要求删除元素，未删除。请先与用户确认要删除的对象。",
        };
      }
      if (!options?.confirmationService || !options.userId) {
        return {
          error: "confirmation_unavailable",
          message: "Deletion requires an authenticated confirmation service.",
        };
      }

      const loadCanvas = async (): Promise<CanvasContent> => {
        const { data: latest, error: latestError } = await client
          .from("canvases")
          .select("content")
          .eq("id", canvasId)
          .single();
        if (latestError || !latest) throw new Error("Canvas not found or access denied.");
        return (latest.content as CanvasContent) ?? {
          elements: [],
          appState: {},
          files: {},
        };
      };
      const confirmation = options.confirmationService.propose({
        userId: options.userId,
        canvasId,
        content,
        operations: structuredClone(operations) as FrozenCanvasOperation[],
        loadCanvas,
        execute: async (frozenOperations, expectedTargets) =>
          manipulateCanvasWithCas(
            client,
            canvasId,
            frozenOperations as Operation[],
            undefined,
            {
              destructiveDeletionAuthorized: true,
              expectedDestructiveTargets: expectedTargets,
            },
          ),
      });
      return {
        error: "confirmation_required",
        message: "Deletion was not applied. User confirmation is required.",
        confirmation,
      };
    }
    // Operation handlers mutate elements, so clone the persisted snapshot.
    const elements = structuredClone(persistedElements);
    const protectedBoardSnapshot = nativeDesignBoardSnapshot(elements);
    const descriptions: string[] = [];
    const errors: string[] = [];
    const createdIds: Record<string, string> = {};

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      try {
        const handler = handlers[op.action];
        const result = handler(elements, op);
        if (result.description.startsWith("[skip]")) {
          errors.push(result.description);
        } else {
          descriptions.push(result.description);
          if (result.createdId) createdIds[`op_${i}`] = result.createdId;
        }
      } catch (operationError) {
        errors.push(
          `[error] ${op.action}: ${(operationError as Error).message}`,
        );
      }
    }

    validateBindings(elements);
    // This catches changes which do not present as an explicit target (for
    // example a binding side effect), and protects complete board identity and
    // position/order rather than just its design ID.
    if (nativeDesignBoardSnapshot(elements) !== protectedBoardSnapshot) {
      return {
        error: "native_design_board_protected",
        message: "原生设计画板仅供读取参考，Agent 不能修改、移动、删除、排序或绑定其画布节点。请由用户在手动编辑器中操作。",
      };
    }
    const incoming = { ...content, elements } as CanvasContent;
    const updatedContent = mergeCanvasContent(content, incoming);
    const { data: updated, error: writeError } = await client
      .from("canvases")
      .update({ content: updatedContent })
      .eq("id", canvasId)
      .eq("updated_at", data.updated_at)
      .select("id")
      .maybeSingle();

    if (writeError) {
      return {
        error: "write_failed",
        message: `Failed to save canvas: ${writeError.message}`,
      };
    }
    if (!updated) continue;

    try {
      const orphanIds = await reconcileCanvasAssetReferences(
        client as any,
        canvasId,
        updatedContent,
      );
      await garbageCollectOrphanAssets(client as any, orphanIds);
    } catch {
      errors.push("[error] asset cleanup will be retried on the next canvas save");
    }

    const result: ManipulationResult = {
      success: true,
      applied: descriptions.length,
      summary: descriptions.join("; "),
    };
    if (Object.keys(createdIds).length > 0) result.createdIds = createdIds;
    if (errors.length > 0) result.errors = errors;
    return result;
  }

  return {
    error: "write_conflict",
    message: "Canvas changed repeatedly while saving. Please retry.",
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createManipulateCanvasTool(deps: {
  createUserClient: (accessToken: string) => any;
  destructiveConfirmationService?: DestructiveConfirmationService;
}) {
  return createAgentTool({
    id: "manipulate_canvas",
    description:
      "TARGET GROUNDING REQUIRED: knowing element IDs is not permission to change them. Resolve each target from the user's requested scope, explicit selection or uniquely matching observed object. If a singular reference has multiple equally plausible matches, do NOT send an operation for every candidate or guess one: inspect if needed, then ask which object. Batch updates require an actual plural/all-objects request or an explicit multi-selection, not ambiguity. Consultation/analysis does not authorize edits. Manipulate ordinary Excalidraw elements on the infinite canvas only. Native multi-layer design board nodes and their objects are read-only reference material: never target, move, delete, reorder, style, text-edit, align, distribute, resize, or bind them; users edit those manually. Supports: move, resize, delete (ONLY when the current raw user message explicitly requests deletion; generating or refining never permits cleanup of old results), update_style, update_text (modify text content of any canvas element or its label), add_text, add_shape (with optional label for centered text), add_line (with optional element binding for auto-connected arrows), align, distribute, reorder. Use inspect_canvas first when target observations are missing. Returns created canvas element IDs for subsequent binding.",
    inputSchema: manipulateCanvasSchema,
    execute: async (input, context) => {
      const runContext = runContextOf(context);
      const canvasId = runContext.canvas_id as string | undefined;
      const accessToken = runContext.access_token as string | undefined;
      const userPrompt = runContext.user_prompt;
      const userId = runContext.user_id;

      if (!canvasId || !accessToken) {
        return JSON.stringify({
          error: "no_canvas_context",
          message:
            "This tool requires a canvas context. Ensure the conversation is linked to a canvas.",
        });
      }

      const client = deps.createUserClient(accessToken);
      return JSON.stringify(
        await manipulateCanvasWithCas(
          client,
          canvasId,
          input.operations,
          userPrompt,
          {
            ...(deps.destructiveConfirmationService
              ? { confirmationService: deps.destructiveConfirmationService }
              : {}),
            ...(typeof userId === "string" ? { userId } : {}),
          },
        ),
      );
    },
  });
}
