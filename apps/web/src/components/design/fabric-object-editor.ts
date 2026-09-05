import {
  type DesignCommand,
  type DesignImageCrop,
  type DesignImageFilters,
  type DesignImageMask,
  type DesignObject,
  type DesignObjectPatch,
  type DesignPaint,
  type DesignShadow,
  type LoomicSceneV1,
  applyDesignCanvasUpdate,
  designObjectPatchSchema,
  loomicSceneV1Schema,
} from "@loomic/shared";
import {
  util,
  ActiveSelection,
  type Canvas,
  Circle,
  Ellipse,
  FabricImage,
  type FabricObject,
  Gradient,
  Group,
  IText,
  Line,
  Rect,
  Shadow,
  Textbox,
  Triangle,
  filters as fabricFilters,
  loadSVGFromString,
} from "fabric";

import { DESIGN_BROWSER_EXPORT_MAX_PIXELS } from "../../lib/design-browser-export";
import { calculateDesignImageLayout } from "../../lib/design-image-layout";

export const FABRIC_EDITOR_MAX_BACKING_PIXELS = 16_000_000;

type RuntimeMetadata = {
  objectId: string;
  objectVersion: number;
  designType: DesignObject["type"];
  source: DesignObject;
};

type RuntimeImagePresentation = {
  baseScaleX: number;
  baseScaleY: number;
  frameWidth: number;
  frameHeight: number;
};

const imagePresentationByRuntime = new WeakMap<
  FabricObject,
  RuntimeImagePresentation
>();

export type FabricAssetInput = {
  assetObjectId: string;
  resourceId?: string | null;
  source: string | Blob;
};

export type FabricObjectCommandEvent = {
  commands: readonly DesignCommand[];
  /** Commands that restore the exact scene before this event. */
  inverseCommands: readonly DesignCommand[];
  /** Stable key used by history to coalesce repeated transforms. */
  mergeKey?: string;
  edits: readonly FabricObjectHistoryEdit[];
  source: "user" | "api";
};

export type FabricObjectHistoryEdit = {
  command: DesignCommand;
  inverse: DesignCommand;
  mergeKey?: string;
};

export type FabricObjectEditorOptions = {
  readOnly?: boolean;
  logicalWidth?: number;
  logicalHeight?: number;
  maxBackingPixels?: number;
  snapThreshold?: number;
  onAlignmentGuidesChange?: (guides: readonly FabricAlignmentGuide[]) => void;
  createId?: () => string;
  onCommand?: (event: FabricObjectCommandEvent) => void;
  onResourceMissing?: (input: {
    objectId: string;
    assetObjectId: string;
    type: "image" | "svg";
    error: unknown;
  }) => void;
};

export type FabricAlignmentGuide = {
  axis: "x" | "y";
  position: number;
  source: "canvas" | "object";
};

export type AddFabricObjectInput =
  | { type: "rect"; x?: number; y?: number; width?: number; height?: number }
  | { type: "circle"; x?: number; y?: number; width?: number; height?: number }
  | { type: "ellipse"; x?: number; y?: number; width?: number; height?: number }
  | {
      type: "triangle";
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }
  | { type: "line"; x1?: number; y1?: number; x2?: number; y2?: number }
  | {
      type: "arrow";
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      arrowStart?: "none" | "arrow";
      arrowEnd?: "none" | "arrow";
    }
  | { type: "text"; text?: string; x?: number; y?: number }
  | {
      type: "textbox";
      text?: string;
      x?: number;
      y?: number;
      width?: number;
    };

export type UpdateFabricObjectPatch = Partial<{
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  text: string;
  fontFamily: string;
  fontFaceId: string | null;
  fontSize: number;
  fontWeight: string | number;
  fontStyle: "normal" | "italic" | "oblique";
  textAlign: "left" | "center" | "right" | "justify";
  lineHeight: number;
  charSpacing: number;
  fill: DesignPaint | null;
  stroke: DesignPaint | null;
  strokeWidth: number;
  shadow: DesignShadow | null;
  fit: "fill" | "contain" | "cover" | "original";
  crop: DesignImageCrop | null;
  mask: DesignImageMask | null;
  filters: DesignImageFilters | null;
}>;

export type FabricObjectEditorApi = {
  loadScene(
    scene: LoomicSceneV1,
    resolveAsset?: (
      object: Extract<DesignObject, { type: "image" | "svg" }>,
    ) => Promise<string | Blob> | string | Blob,
  ): Promise<void>;
  serializeScene(): LoomicSceneV1;
  applyCommands(
    commands: readonly DesignCommand[],
    source: "undo" | "redo" | "sync",
  ): Promise<void>;
  addObject(input: AddFabricObjectInput): string;
  cloneSelection(): Promise<string[]>;
  replaceSelectedAsset(input: FabricAssetInput): Promise<string>;
  updateObject(objectId: string, patch: UpdateFabricObjectPatch): void;
  addImage(input: FabricAssetInput): Promise<string>;
  addSvg(input: FabricAssetInput): Promise<string>;
  getSelectionIds(): string[];
  getObjectViewportBounds(objectId: string): {
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
  } | null;
  subscribeSelection(
    listener: (objectIds: readonly string[]) => void,
  ): () => void;
  select(objectIds: readonly string[]): void;
  removeSelection(): void;
  setLocked(objectIds: readonly string[], locked: boolean): void;
  setVisible(objectIds: readonly string[], visible: boolean): void;
  flip(objectIds: readonly string[], axis: "horizontal" | "vertical"): void;
  reorder(
    objectId: string,
    action: "front" | "back" | "forward" | "backward" | number,
  ): void;
  align(
    objectIds: readonly string[],
    alignment:
      | "left"
      | "horizontal_center"
      | "right"
      | "top"
      | "vertical_center"
      | "bottom",
  ): void;
  distribute(
    objectIds: readonly string[],
    direction: "horizontal" | "vertical",
  ): void;
  group(objectIds: readonly string[]): string | null;
  ungroup(groupObjectId: string): void;
  waitForImages(): Promise<{ missingAssetObjectIds: string[] }>;
  refreshTextMetrics(): void;
  renderToBlob(options?: {
    format?: "png" | "jpeg";
    mimeType?: "image/png" | "image/jpeg";
    logicalWidth?: number;
    logicalHeight?: number;
    multiplier?: 1 | 2;
    transparent?: boolean;
    quality?: number;
  }): Promise<Blob>;
  dispose(): void;
};

const solid = (color: string): DesignPaint => ({ kind: "solid", color });

export class FabricObjectEditor implements FabricObjectEditorApi {
  private readonly canvas: Canvas;
  private readonly options: FabricObjectEditorOptions;
  private readonly objects = new Map<string, FabricObject>();
  private suppressEvents = 0;
  private disposed = false;
  private previousScene: LoomicSceneV1;
  private assetResolver?: Parameters<FabricObjectEditorApi["loadScene"]>[1];
  private logicalWidth: number;
  private logicalHeight: number;
  private renderScale = 1;
  private readonly selectionListeners = new Set<
    (objectIds: readonly string[]) => void
  >();
  private readonly missingAssetObjectIds = new Set<string>();

  constructor(canvas: Canvas, options: FabricObjectEditorOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.logicalWidth = options.logicalWidth ?? canvas.getWidth();
    this.logicalHeight = options.logicalHeight ?? canvas.getHeight();
    this.resizeBackingStore(this.logicalWidth, this.logicalHeight);
    this.canvas.on("object:modified", this.handleModified);
    this.canvas.on("object:moving", this.handleMoving);
    this.canvas.on("text:editing:exited", this.handleTextEditingExited);
    this.canvas.on("selection:created", this.handleSelectionChanged);
    this.canvas.on("selection:updated", this.handleSelectionChanged);
    this.canvas.on("selection:cleared", this.handleSelectionChanged);
    this.previousScene = this.serializeScene();
  }

  getObjectViewportBounds(objectId: string) {
    this.assertAlive();
    const object = this.serializeScene().objects.find(
      (candidate) => candidate.objectId === objectId,
    );
    if (!object) return null;
    const canvasBounds = this.canvas.lowerCanvasEl.getBoundingClientRect();
    const scaleX = canvasBounds.width / this.logicalWidth;
    const scaleY = canvasBounds.height / this.logicalHeight;
    return {
      x: canvasBounds.left + object.x * scaleX,
      y: canvasBounds.top + object.y * scaleY,
      width: object.width * scaleX,
      height: object.height * scaleY,
      angle: (object.rotation * Math.PI) / 180,
    };
  }

  async loadScene(
    rawScene: LoomicSceneV1,
    resolveAsset?: (
      object: Extract<DesignObject, { type: "image" | "svg" }>,
    ) => Promise<string | Blob> | string | Blob,
  ) {
    this.assertAlive();
    const scene = loomicSceneV1Schema.parse(rawScene);
    this.assetResolver = resolveAsset ?? this.assetResolver;
    await this.suppressed(async () => {
      this.canvas.discardActiveObject();
      this.canvas.clear();
      this.objects.clear();
      this.missingAssetObjectIds.clear();
      this.resizeBackingStore(scene.canvas.width, scene.canvas.height);
      this.canvas.backgroundColor = scene.canvas.background ?? "rgba(0,0,0,0)";

      const byId = new Map(
        scene.objects.map((object) => [object.objectId, object]),
      );
      const groupedChildIds = new Set(
        scene.objects.flatMap((object) =>
          object.type === "group" ? object.childObjectIds : [],
        ),
      );
      const build = async (
        object: DesignObject,
      ): Promise<FabricObject | null> => {
        if (object.type !== "group")
          return this.fromDesignObject(object, resolveAsset);
        const children: FabricObject[] = [];
        for (const childId of object.childObjectIds) {
          const child = byId.get(childId);
          if (!child) continue;
          const runtime = await build(child);
          if (!runtime) continue;
          this.tag(runtime, child);
          this.objects.set(child.objectId, runtime);
          children.push(runtime);
        }
        return new Group(children, fabricOptions(object));
      };
      for (const object of scene.objects) {
        if (groupedChildIds.has(object.objectId)) continue;
        const runtime = await build(object);
        if (runtime) this.addRuntime(runtime, object);
      }
      this.canvas.requestRenderAll();
    });
    this.previousScene = this.serializeScene();
    this.notifySelection();
  }

  serializeScene(): LoomicSceneV1 {
    this.assertAlive();
    const ordered: DesignObject[] = [];
    const append = (runtime: FabricObject) => {
      const metadata = readMetadata(runtime);
      if (!metadata) return;
      ordered.push(this.toDesignObject(runtime, metadata, ordered.length));
      if (metadata.designType === "group" && runtime instanceof Group) {
        for (const child of runtime.getObjects()) append(child);
      }
    };
    for (const runtime of this.canvas.getObjects()) append(runtime);
    const background =
      typeof this.canvas.backgroundColor === "string" &&
      this.canvas.backgroundColor !== "rgba(0,0,0,0)"
        ? this.canvas.backgroundColor
        : null;
    return loomicSceneV1Schema.parse({
      schemaVersion: 1,
      engine: "fabric",
      canvas: {
        width: this.logicalWidth,
        height: this.logicalHeight,
        background,
      },
      objects: ordered,
    });
  }

  async applyCommands(
    commands: readonly DesignCommand[],
    _source: "undo" | "redo" | "sync",
  ) {
    this.assertAlive();
    const scene = applyCommandsToScene(this.serializeScene(), commands);
    await this.loadScene(scene, this.assetResolver);
  }

  refreshTextMetrics() {
    this.assertAlive();
    for (const runtime of this.objects.values()) {
      if (runtime instanceof IText || runtime instanceof Textbox) {
        runtime.initDimensions();
        runtime.setCoords();
      }
    }
    this.canvas.requestRenderAll();
  }

  addObject(input: AddFabricObjectInput): string {
    this.assertWritable();
    const object = createNewDesignObject(
      input,
      this.createId(),
      this.canvas.getObjects().length,
    );
    const runtime = this.fromSynchronousDesignObject(object);
    this.addRuntime(runtime, object);
    this.canvas.setActiveObject(runtime);
    this.canvas.requestRenderAll();
    this.emit([{ action: "object.add", object }], "api");
    this.notifySelection();
    return object.objectId;
  }

  async cloneSelection() {
    this.assertWritable();
    const selected = [...this.canvas.getActiveObjects()];
    if (!selected.length) return [];
    if (
      selected.some((object) => requireMetadata(object).designType === "group")
    )
      throw new Error("Group cloning is not supported by this editor version.");
    const clones: FabricObject[] = [];
    const commands: DesignCommand[] = [];
    for (const sourceRuntime of selected) {
      const sourceMetadata = requireMetadata(sourceRuntime);
      const clone = await sourceRuntime.clone();
      clone.set({ left: sourceRuntime.left + 16, top: sourceRuntime.top + 16 });
      const durable = this.toDesignObject(
        sourceRuntime,
        sourceMetadata,
        this.canvas.getObjects().length + clones.length,
      );
      durable.objectId = this.createId();
      durable.objectVersion = 1;
      durable.x += 16;
      durable.y += 16;
      if (durable.type === "line" || durable.type === "arrow") {
        durable.x1 += 16;
        durable.y1 += 16;
        durable.x2 += 16;
        durable.y2 += 16;
      }
      this.addRuntime(clone, durable);
      if (clone instanceof FabricImage && durable.type === "image")
        applyImagePresentation(clone, durable);
      clones.push(clone);
      commands.push({
        action: "object.clone",
        source_object_id: sourceMetadata.objectId,
        expected_object_version: sourceMetadata.objectVersion,
        object: durable,
      });
    }
    this.canvas.discardActiveObject();
    this.canvas.setActiveObject(
      clones.length === 1 && clones[0]
        ? clones[0]
        : new ActiveSelection(clones, { canvas: this.canvas }),
    );
    this.canvas.requestRenderAll();
    this.emit(commands, "api");
    this.notifySelection();
    return clones.map((object) => requireMetadata(object).objectId);
  }

  async replaceSelectedAsset(input: FabricAssetInput) {
    this.assertWritable();
    const selected = this.canvas.getActiveObjects();
    if (selected.length !== 1 || !selected[0])
      throw new Error("Select exactly one image or SVG to replace.");
    const previous = selected[0];
    const metadata = requireMetadata(previous);
    if (metadata.designType !== "image" && metadata.designType !== "svg")
      throw new Error("Selected object is not an image or SVG.");
    const resolved = await resolveSource(input.source);
    let replacement: FabricObject;
    try {
      replacement = await createAssetRuntime(
        metadata.designType,
        resolved.value,
      );
    } catch (error) {
      this.options.onResourceMissing?.({
        objectId: metadata.objectId,
        assetObjectId: input.assetObjectId,
        type: metadata.designType,
        error,
      });
      throw error;
    } finally {
      resolved.revoke?.();
    }
    const geometry = transformFields(previous);
    replacement.set({
      left: geometry.x,
      top: geometry.y,
      angle: geometry.rotation,
      opacity: geometry.opacity,
      flipX: previous.flipX,
      flipY: previous.flipY,
      scaleX: geometry.width / Math.max(0.001, replacement.width),
      scaleY: geometry.height / Math.max(0.001, replacement.height),
    });
    const durable = structuredClone(metadata.source) as Extract<
      DesignObject,
      { type: "image" | "svg" }
    >;
    durable.assetObjectId = input.assetObjectId;
    const nextResourceId = input.resourceId ?? null;
    durable.resourceId = nextResourceId;
    this.tag(replacement, durable);
    const index = this.canvas.getObjects().indexOf(previous);
    this.suppressEvents += 1;
    try {
      this.canvas.remove(previous);
      this.canvas.add(replacement);
      this.canvas.moveObjectTo(replacement, index);
    } finally {
      this.suppressEvents -= 1;
    }
    this.objects.set(metadata.objectId, replacement);
    const replacementMetadata = requireMetadata(replacement);
    const expected = replacementMetadata.objectVersion;
    const patch = designObjectPatchSchema.parse({
      object_type: metadata.designType,
      asset_object_id: input.assetObjectId,
      resource_id: nextResourceId,
    });
    applyPatchToRuntime(replacement, replacementMetadata, patch);
    bumpVersion(replacement);
    this.canvas.setActiveObject(replacement);
    this.canvas.requestRenderAll();
    this.emit(
      [
        {
          action: "object.update",
          object_id: metadata.objectId,
          expected_object_version: expected,
          patch,
        },
      ],
      "api",
    );
    this.notifySelection();
    return metadata.objectId;
  }

  updateObject(objectId: string, input: UpdateFabricObjectPatch) {
    this.assertWritable();
    const runtime = this.requireObject(objectId);
    const metadata = requireMetadata(runtime);
    const patch: Record<string, unknown> = { object_type: metadata.designType };
    if (input.x !== undefined) {
      runtime.set("left", input.x);
      patch.x = input.x;
    }
    if (input.y !== undefined) {
      runtime.set("top", input.y);
      patch.y = input.y;
    }
    if (input.width !== undefined) {
      runtime.set("scaleX", input.width / Math.max(0.001, runtime.width));
      patch.width = input.width;
    }
    if (input.height !== undefined) {
      runtime.set("scaleY", input.height / Math.max(0.001, runtime.height));
      patch.height = input.height;
    }
    if (input.rotation !== undefined) {
      runtime.set("angle", input.rotation);
      patch.rotation = input.rotation;
    }
    if (input.opacity !== undefined) {
      runtime.set("opacity", input.opacity);
      patch.opacity = input.opacity;
    }
    if (input.name !== undefined) patch.name = input.name;
    if (input.text !== undefined) patch.text = input.text;
    if (input.fontFamily !== undefined) patch.font_family = input.fontFamily;
    if (input.fontFaceId !== undefined) patch.font_face_id = input.fontFaceId;
    if (input.fontSize !== undefined) patch.font_size = input.fontSize;
    if (input.fontWeight !== undefined) patch.font_weight = input.fontWeight;
    if (input.fontStyle !== undefined) patch.font_style = input.fontStyle;
    if (input.textAlign !== undefined) patch.text_align = input.textAlign;
    if (input.lineHeight !== undefined) patch.line_height = input.lineHeight;
    if (input.charSpacing !== undefined) patch.char_spacing = input.charSpacing;
    if (input.fill !== undefined) patch.fill = input.fill;
    if (input.stroke !== undefined) patch.stroke = input.stroke;
    if (input.strokeWidth !== undefined) patch.stroke_width = input.strokeWidth;
    if (input.shadow !== undefined) patch.shadow = input.shadow;
    if (input.fit !== undefined) patch.fit = input.fit;
    if (input.crop !== undefined) patch.crop = input.crop;
    if (input.mask !== undefined) patch.mask = input.mask;
    if (input.filters !== undefined) patch.filters = input.filters;
    const parsed = designObjectPatchSchema.parse(patch);
    applyPatchToRuntime(runtime, metadata, parsed);
    // Text metrics can change after font/text properties are applied; make the
    // requested logical box authoritative after Fabric recalculates them.
    if (input.width !== undefined && !(runtime instanceof FabricImage))
      runtime.set("scaleX", input.width / Math.max(0.001, runtime.width));
    if (input.height !== undefined && !(runtime instanceof FabricImage))
      runtime.set("scaleY", input.height / Math.max(0.001, runtime.height));
    const expected = metadata.objectVersion;
    bumpVersion(runtime);
    runtime.setCoords();
    this.canvas.requestRenderAll();
    this.emit(
      [
        {
          action: "object.update",
          object_id: objectId,
          expected_object_version: expected,
          patch: parsed,
        },
      ],
      "api",
    );
  }

  async addImage(input: FabricAssetInput) {
    return this.addAsset("image", input);
  }

  async addSvg(input: FabricAssetInput) {
    return this.addAsset("svg", input);
  }

  getSelectionIds() {
    const active = this.canvas.getActiveObjects();
    return active.flatMap((object) => {
      const metadata = readMetadata(object);
      return metadata ? [metadata.objectId] : [];
    });
  }

  subscribeSelection(listener: (objectIds: readonly string[]) => void) {
    this.assertAlive();
    this.selectionListeners.add(listener);
    listener(this.getSelectionIds());
    return () => this.selectionListeners.delete(listener);
  }

  select(objectIds: readonly string[]) {
    this.assertAlive();
    const selected = objectIds.flatMap((id) => {
      const object = this.objects.get(id);
      return object && object.visible !== false ? [object] : [];
    });
    this.canvas.discardActiveObject();
    if (selected.length === 1 && selected[0])
      this.canvas.setActiveObject(selected[0]);
    else if (selected.length > 1)
      this.canvas.setActiveObject(
        new ActiveSelection(selected, { canvas: this.canvas }),
      );
    this.canvas.requestRenderAll();
    this.notifySelection();
  }

  removeSelection() {
    this.assertWritable();
    const selection = [...this.canvas.getActiveObjects()];
    this.canvas.discardActiveObject();
    this.suppressEvents += 1;
    try {
      for (const object of selection) {
        const metadata = readMetadata(object);
        if (!metadata) continue;
        this.canvas.remove(object);
        this.objects.delete(metadata.objectId);
        this.emit(
          [
            {
              action: "object.remove",
              object_id: metadata.objectId,
              expected_object_version: metadata.objectVersion,
            },
          ],
          "api",
        );
      }
    } finally {
      this.suppressEvents -= 1;
    }
    this.canvas.requestRenderAll();
    this.notifySelection();
  }

  setLocked(objectIds: readonly string[], locked: boolean) {
    this.updateObjects(objectIds, (object) => {
      object.set({
        lockMovementX: locked,
        lockMovementY: locked,
        lockScalingX: locked,
        lockScalingY: locked,
        lockRotation: locked,
        selectable: !locked,
      });
      return { locked };
    });
  }

  setVisible(objectIds: readonly string[], visible: boolean) {
    this.updateObjects(objectIds, (object) => {
      const metadata = requireMetadata(object);
      object.set({
        visible,
        evented: visible,
        selectable: visible && !object.lockMovementX && !this.options.readOnly,
      });
      return { visible };
    });
  }

  flip(objectIds: readonly string[], axis: "horizontal" | "vertical") {
    this.updateObjects(objectIds, (object) => {
      if (axis === "horizontal") object.set("flipX", !object.flipX);
      else object.set("flipY", !object.flipY);
      return axis === "horizontal"
        ? { flip_x: Boolean(object.flipX) }
        : { flip_y: Boolean(object.flipY) };
    });
  }

  reorder(
    objectId: string,
    action: "front" | "back" | "forward" | "backward" | number,
  ) {
    this.assertWritable();
    const object = this.requireObject(objectId);
    const metadata = requireMetadata(object);
    if (typeof action === "number") this.canvas.moveObjectTo(object, action);
    else if (action === "front") this.canvas.bringObjectToFront(object);
    else if (action === "back") this.canvas.sendObjectToBack(object);
    else if (action === "forward") this.canvas.bringObjectForward(object);
    else this.canvas.sendObjectBackwards(object);
    this.canvas.requestRenderAll();
    const command: DesignCommand = {
      action: "object.reorder",
      object_id: objectId,
      expected_object_version: metadata.objectVersion,
      to_index: this.canvas.getObjects().indexOf(object),
    };
    bumpVersion(object);
    this.emit([command], "api");
  }

  align(
    objectIds: readonly string[],
    alignment: Parameters<FabricObjectEditorApi["align"]>[1],
  ) {
    this.assertWritable();
    const objects = this.requireObjects(objectIds, 2);
    const bounds = unionBounds(objects);
    for (const object of objects) {
      const rect = object.getBoundingRect();
      if (alignment === "left") object.left += bounds.left - rect.left;
      if (alignment === "right")
        object.left += bounds.left + bounds.width - (rect.left + rect.width);
      if (alignment === "horizontal_center")
        object.left +=
          bounds.left + bounds.width / 2 - (rect.left + rect.width / 2);
      if (alignment === "top") object.top += bounds.top - rect.top;
      if (alignment === "bottom")
        object.top += bounds.top + bounds.height - (rect.top + rect.height);
      if (alignment === "vertical_center")
        object.top +=
          bounds.top + bounds.height / 2 - (rect.top + rect.height / 2);
      object.setCoords();
    }
    this.canvas.requestRenderAll();
    const command: DesignCommand = {
      action: "objects.align",
      alignment,
      objects: objects.map(commandRef),
    };
    for (const object of objects) bumpVersion(object);
    this.emit([command], "api");
  }

  distribute(
    objectIds: readonly string[],
    direction: "horizontal" | "vertical",
  ) {
    this.assertWritable();
    const objects = this.requireObjects(objectIds, 3).sort((a, b) =>
      direction === "horizontal" ? a.left - b.left : a.top - b.top,
    );
    const firstObject = objects[0];
    const lastObject = objects.at(-1);
    if (!firstObject || !lastObject) return;
    const first = firstObject.getBoundingRect();
    const last = lastObject.getBoundingRect();
    const total = objects.reduce(
      (sum, object) =>
        sum +
        (direction === "horizontal"
          ? object.getScaledWidth()
          : object.getScaledHeight()),
      0,
    );
    const span =
      direction === "horizontal"
        ? last.left + last.width - first.left
        : last.top + last.height - first.top;
    const gap = (span - total) / (objects.length - 1);
    let cursor = direction === "horizontal" ? first.left : first.top;
    for (const object of objects) {
      const rect = object.getBoundingRect();
      if (direction === "horizontal") {
        object.left += cursor - rect.left;
        cursor += rect.width + gap;
      } else {
        object.top += cursor - rect.top;
        cursor += rect.height + gap;
      }
      object.setCoords();
    }
    this.canvas.requestRenderAll();
    const command: DesignCommand = {
      action: "objects.distribute",
      direction,
      objects: objects.map(commandRef),
    };
    for (const object of objects) bumpVersion(object);
    this.emit([command], "api");
  }

  group(objectIds: readonly string[]) {
    this.assertWritable();
    const objects = this.requireObjects(objectIds, 2);
    const childRefs = objects.map(commandRef);
    const childIds = childRefs.map((ref) => ref.object_id);
    this.suppressEvents += 1;
    let group: Group;
    try {
      this.canvas.discardActiveObject();
      for (const object of objects) this.canvas.remove(object);
      group = new Group(objects);
      const durable = baseObject(
        "group",
        this.createId(),
        this.canvas.getObjects().length,
        group,
      ) as Extract<DesignObject, { type: "group" }>;
      durable.childObjectIds = childIds;
      this.addRuntime(group, durable);
      this.canvas.setActiveObject(group);
      this.notifySelection();
      this.emit(
        [{ action: "objects.group", group: durable, children: childRefs }],
        "api",
      );
      return durable.objectId;
    } finally {
      this.suppressEvents -= 1;
      this.canvas.requestRenderAll();
    }
  }

  ungroup(groupObjectId: string) {
    this.assertWritable();
    const runtime = this.requireObject(groupObjectId);
    if (!(runtime instanceof Group)) throw new Error("Object is not a group.");
    const metadata = requireMetadata(runtime);
    this.suppressEvents += 1;
    try {
      this.canvas.discardActiveObject();
      this.canvas.remove(runtime);
      this.objects.delete(groupObjectId);
      const children = runtime.removeAll();
      for (const child of children) {
        util.sendObjectToPlane(child, runtime.calcTransformMatrix());
        this.canvas.add(child);
      }
      this.canvas.setActiveObject(
        new ActiveSelection(children, { canvas: this.canvas }),
      );
      this.notifySelection();
      this.emit(
        [
          {
            action: "objects.ungroup",
            group_object_id: groupObjectId,
            expected_object_version: metadata.objectVersion,
          },
        ],
        "api",
      );
    } finally {
      this.suppressEvents -= 1;
      this.canvas.requestRenderAll();
    }
  }

  async waitForImages() {
    this.assertAlive();
    const visit = async (object: FabricObject): Promise<void> => {
      if (object instanceof FabricImage) {
        const element = object.getElement();
        if (
          "complete" in element &&
          (!element.complete || element.naturalWidth === 0) &&
          typeof element.decode === "function"
        ) {
          await element.decode();
        }
      }
      if (object instanceof Group) {
        await Promise.all(object.getObjects().map(visit));
      }
    };
    await Promise.all(this.canvas.getObjects().map(visit));
    return { missingAssetObjectIds: [...this.missingAssetObjectIds] };
  }

  async renderToBlob(
    options: {
      format?: "png" | "jpeg";
      mimeType?: "image/png" | "image/jpeg";
      logicalWidth?: number;
      logicalHeight?: number;
      multiplier?: 1 | 2;
      transparent?: boolean;
      quality?: number;
    } = {},
  ) {
    this.assertAlive();
    const imageState = await this.waitForImages();
    if (imageState.missingAssetObjectIds.length)
      throw new Error("Design export has unresolved image resources.");
    if (
      (options.logicalWidth !== undefined &&
        options.logicalWidth !== this.logicalWidth) ||
      (options.logicalHeight !== undefined &&
        options.logicalHeight !== this.logicalHeight)
    )
      throw new Error("Export dimensions do not match the active design.");
    const format =
      options.format ?? (options.mimeType === "image/jpeg" ? "jpeg" : "png");
    const requestedMultiplier = options.multiplier ?? 1;
    const renderedPixels =
      this.logicalWidth * this.logicalHeight * requestedMultiplier ** 2;
    if (
      !Number.isSafeInteger(renderedPixels) ||
      renderedPixels > DESIGN_BROWSER_EXPORT_MAX_PIXELS
    ) {
      throw new RangeError(
        `Browser export pixel budget exceeded: ${renderedPixels} > ${DESIGN_BROWSER_EXPORT_MAX_PIXELS}.`,
      );
    }
    const previousBackground = this.canvas.backgroundColor;
    if (options.transparent) this.canvas.backgroundColor = "rgba(0,0,0,0)";
    try {
      const output = this.canvas.toCanvasElement(
        requestedMultiplier / this.renderScale,
      );
      return await new Promise<Blob>((resolve, reject) => {
        output.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("Design export returned no data.")),
          format === "jpeg" ? "image/jpeg" : "image/png",
          options.quality ?? 0.92,
        );
      });
    } finally {
      this.canvas.backgroundColor = previousBackground;
      this.canvas.requestRenderAll();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.off("object:modified", this.handleModified);
    this.canvas.off("object:moving", this.handleMoving);
    this.canvas.off("text:editing:exited", this.handleTextEditingExited);
    this.canvas.off("selection:created", this.handleSelectionChanged);
    this.canvas.off("selection:updated", this.handleSelectionChanged);
    this.canvas.off("selection:cleared", this.handleSelectionChanged);
    this.selectionListeners.clear();
    this.objects.clear();
  }

  private handleModified = (event: { target?: FabricObject }) => {
    this.options.onAlignmentGuidesChange?.([]);
    if (this.suppressEvents || !event.target) return;
    const target = event.target;
    const members =
      target instanceof ActiveSelection ? target.getObjects() : [target];
    const commands: DesignCommand[] = [];
    for (const object of members) {
      const metadata = readMetadata(object);
      if (!metadata) continue;
      const patch = transformPatch(object, metadata.designType);
      const previous = this.previousScene.objects.find(
        (candidate) => candidate.objectId === metadata.objectId,
      );
      if (previous && !patchChangesObject(patch, previous)) continue;
      const expected = metadata.objectVersion;
      metadata.objectVersion += 1;
      metadata.source.objectVersion = metadata.objectVersion;
      commands.push({
        action: "object.update",
        object_id: metadata.objectId,
        expected_object_version: expected,
        patch,
      });
    }
    this.emit(
      commands,
      "user",
      `transform:${commands.map(commandObjectId).join(",")}`,
    );
  };

  private handleMoving = (event: { target?: FabricObject }) => {
    if (this.suppressEvents || !event.target) return;
    const target = event.target;
    const result = calculateObjectSnap({
      moving: target.getBoundingRect(),
      canvasWidth: this.logicalWidth,
      canvasHeight: this.logicalHeight,
      others: this.canvas
        .getObjects()
        .filter((object) => object !== target && object.visible !== false)
        .map((object) => object.getBoundingRect()),
      threshold: this.options.snapThreshold ?? 6,
    });
    target.set({ left: target.left + result.dx, top: target.top + result.dy });
    target.setCoords();
    this.options.onAlignmentGuidesChange?.(result.guides);
  };

  private handleTextEditingExited = (event: { target?: IText }) => {
    if (this.suppressEvents || !event.target) return;
    const metadata = readMetadata(event.target);
    if (
      !metadata ||
      (metadata.designType !== "text" && metadata.designType !== "textbox")
    )
      return;
    const previous = this.previousScene.objects.find(
      (object) => object.objectId === metadata.objectId,
    );
    if (
      (previous?.type === "text" || previous?.type === "textbox") &&
      previous.text === event.target.text
    )
      return;
    const expected = metadata.objectVersion;
    bumpVersion(event.target);
    this.emit(
      [
        {
          action: "object.update",
          object_id: metadata.objectId,
          expected_object_version: expected,
          patch: transformPatch(event.target, metadata.designType),
        },
      ],
      "user",
      `text:${metadata.objectId}`,
    );
  };

  private handleSelectionChanged = () => this.notifySelection();

  private notifySelection() {
    const selection = this.getSelectionIds();
    for (const listener of this.selectionListeners) listener(selection);
  }

  private async addAsset(type: "image" | "svg", input: FabricAssetInput) {
    this.assertWritable();
    const objectId = this.createId();
    const resolved = await resolveSource(input.source);
    let runtime: FabricObject;
    try {
      if (type === "image")
        runtime = await FabricImage.fromURL(resolved.value, {
          crossOrigin: "anonymous",
        });
      else {
        const parsed = await loadSVGFromString(resolved.value);
        runtime = util.groupSVGElements(
          parsed.objects.filter((value): value is FabricObject =>
            Boolean(value),
          ),
          parsed.options,
        );
      }
    } finally {
      resolved.revoke?.();
    }
    runtime.set({ left: 40, top: 40 });
    const durable = baseObject(
      type,
      objectId,
      this.canvas.getObjects().length,
      runtime,
    ) as Extract<DesignObject, { type: "image" | "svg" }>;
    durable.assetObjectId = input.assetObjectId;
    if (input.resourceId !== undefined) durable.resourceId = input.resourceId;
    if (type === "image")
      (durable as Extract<DesignObject, { type: "image" }>).fit = "contain";
    this.addRuntime(runtime, durable);
    this.canvas.setActiveObject(runtime);
    this.canvas.requestRenderAll();
    this.emit([{ action: "object.add", object: durable }], "api");
    this.notifySelection();
    return objectId;
  }

  private async fromDesignObject(
    object: DesignObject,
    resolveAsset?: (
      object: Extract<DesignObject, { type: "image" | "svg" }>,
    ) => Promise<string | Blob> | string | Blob,
  ): Promise<FabricObject | null> {
    if (object.type !== "image" && object.type !== "svg")
      return this.fromSynchronousDesignObject(object);
    try {
      if (!resolveAsset)
        throw new Error("No authorized asset resolver was provided.");
      const source = await resolveSource(await resolveAsset(object));
      let runtime: FabricObject;
      try {
        if (object.type === "image")
          runtime = await FabricImage.fromURL(source.value, {
            crossOrigin: "anonymous",
          });
        else {
          const parsed = await loadSVGFromString(source.value);
          runtime = util.groupSVGElements(
            parsed.objects.filter((value): value is FabricObject =>
              Boolean(value),
            ),
            parsed.options,
          );
        }
      } finally {
        source.revoke?.();
      }
      runtime.set(fabricOptions(object));
      if (runtime instanceof FabricImage && object.type === "image") {
        applyImagePresentation(runtime, object);
      }
      this.missingAssetObjectIds.delete(object.assetObjectId);
      return runtime;
    } catch (error) {
      this.options.onResourceMissing?.({
        objectId: object.objectId,
        assetObjectId: object.assetObjectId,
        type: object.type,
        error,
      });
      this.missingAssetObjectIds.add(object.assetObjectId);
      return null;
    }
  }

  private fromSynchronousDesignObject(
    object:
      | Exclude<DesignObject, { type: "image" | "svg" | "group" }>
      | DesignObject,
  ): FabricObject {
    const options = fabricOptions(object);
    if (object.type === "rect")
      return new Rect({
        ...options,
        fill: paintColor(object.fill),
        stroke: paintColor(object.stroke),
        strokeWidth: object.strokeWidth,
        rx: object.radiusX ?? 0,
        ry: object.radiusY ?? 0,
      });
    if (object.type === "circle") {
      const circle = new Circle({
        ...options,
        radius: object.width / 2,
        fill: paintColor(object.fill),
        stroke: paintColor(object.stroke),
        strokeWidth: object.strokeWidth,
      });
      const naturalHeight = Math.max(0.001, circle.height || object.width);
      circle.set("scaleY", object.height / naturalHeight);
      return circle;
    }
    if (object.type === "triangle")
      return new Triangle({
        ...options,
        fill: paintColor(object.fill),
        stroke: paintColor(object.stroke),
        strokeWidth: object.strokeWidth,
      });
    if (object.type === "line")
      return new Line([0, 0, object.x2 - object.x1, object.y2 - object.y1], {
        ...options,
        stroke: paintColor(object.stroke),
        strokeWidth: object.strokeWidth,
      });
    if (object.type === "arrow") return createArrowRuntime(object);
    if (object.type === "text")
      return new IText(object.text, { ...options, ...textOptions(object) });
    if (object.type === "textbox")
      return new Textbox(object.text, {
        ...options,
        ...textOptions(object),
        width: object.width,
        ...(object.minWidth === undefined ? {} : { minWidth: object.minWidth }),
      });
    throw new Error(`Unsupported synchronous object type: ${object.type}`);
  }

  private addRuntime(runtime: FabricObject, object: DesignObject) {
    this.tag(runtime, object);
    this.objects.set(object.objectId, runtime);
    this.canvas.add(runtime);
  }

  private tag(runtime: FabricObject, object: DesignObject) {
    (runtime as FabricObject & { data?: RuntimeMetadata }).data = {
      objectId: object.objectId,
      objectVersion: object.objectVersion,
      designType: object.type,
      source: structuredClone(object),
    };
    runtime.set({
      visible: object.visible,
      evented: object.visible,
      selectable: object.visible && !object.locked && !this.options.readOnly,
      lockMovementX: object.locked,
      lockMovementY: object.locked,
      lockScalingX: object.locked,
      lockScalingY: object.locked,
      lockRotation: object.locked,
    });
  }

  private toDesignObject(
    runtime: FabricObject,
    metadata: RuntimeMetadata,
    zIndex: number,
  ): DesignObject {
    const source = structuredClone(metadata.source) as DesignObject;
    const previousX = source.x;
    const previousY = source.y;
    Object.assign(source, transformFields(runtime), {
      objectVersion: metadata.objectVersion,
      zIndex,
      locked: Boolean(
        runtime.lockMovementX && runtime.lockScalingX && runtime.lockRotation,
      ),
      visible: runtime.visible !== false,
    });
    if (source.type === "image" || source.type === "svg") {
      source.flipX = Boolean(runtime.flipX);
      source.flipY = Boolean(runtime.flipY);
    }
    if (
      (source.type === "text" || source.type === "textbox") &&
      (runtime instanceof IText || runtime instanceof Textbox)
    ) {
      source.text = runtime.text;
      source.fontFamily = runtime.fontFamily;
      source.fontSize = runtime.fontSize;
      source.fontWeight = runtime.fontWeight;
      source.fontStyle = ["normal", "italic", "oblique"].includes(
        runtime.fontStyle,
      )
        ? (runtime.fontStyle as typeof source.fontStyle)
        : "normal";
      source.textAlign = runtime.textAlign as typeof source.textAlign;
      source.lineHeight = runtime.lineHeight;
      source.charSpacing = runtime.charSpacing;
    }
    if (source.type === "group" && runtime instanceof Group) {
      source.childObjectIds = runtime.getObjects().flatMap((child) => {
        const childMetadata = readMetadata(child);
        return childMetadata ? [childMetadata.objectId] : [];
      });
    }
    if (source.type === "line" || source.type === "arrow") {
      const scaleX = runtime.getScaledWidth() / Math.max(0.001, source.width);
      const scaleY = runtime.getScaledHeight() / Math.max(0.001, source.height);
      source.x1 = runtime.left + (source.x1 - previousX) * scaleX;
      source.y1 = runtime.top + (source.y1 - previousY) * scaleY;
      source.x2 = runtime.left + (source.x2 - previousX) * scaleX;
      source.y2 = runtime.top + (source.y2 - previousY) * scaleY;
    }
    return source;
  }

  private updateObjects(
    objectIds: readonly string[],
    apply: (object: FabricObject) => Record<string, unknown>,
  ) {
    this.assertWritable();
    for (const object of this.requireObjects(objectIds, 1)) {
      const metadata = requireMetadata(object);
      const expected = metadata.objectVersion;
      const patch = apply(object);
      metadata.objectVersion += 1;
      metadata.source.objectVersion = metadata.objectVersion;
      object.setCoords();
      this.emit(
        [
          {
            action: "object.update",
            object_id: metadata.objectId,
            expected_object_version: expected,
            patch: { object_type: metadata.designType, ...patch } as never,
          },
        ],
        "api",
      );
    }
    this.canvas.requestRenderAll();
  }

  private requireObject(id: string) {
    const object = this.objects.get(id);
    if (!object) throw new Error(`Design object not found: ${id}`);
    return object;
  }

  private requireObjects(ids: readonly string[], minimum: number) {
    const unique = [...new Set(ids)];
    if (unique.length < minimum)
      throw new Error(`Expected at least ${minimum} design objects.`);
    return unique.map((id) => this.requireObject(id));
  }

  private createId() {
    return (this.options.createId ?? (() => crypto.randomUUID()))();
  }

  private emit(
    commands: readonly DesignCommand[],
    source: "user" | "api",
    mergeKey?: string,
  ) {
    if (!commands.length) return;
    const inverseCommands = [...commands]
      .reverse()
      .map((command) => inverseForCommand(command, this.previousScene));
    const edits = commands.map((command) => ({
      command,
      inverse: inverseForCommand(command, this.previousScene),
      ...(mergeKey === undefined ? {} : { mergeKey }),
    }));
    this.options.onCommand?.({
      commands,
      inverseCommands,
      edits,
      source,
      ...(mergeKey === undefined ? {} : { mergeKey }),
    });
    this.previousScene = this.serializeScene();
  }

  private assertAlive() {
    if (this.disposed) throw new Error("Fabric object editor is disposed.");
  }

  private assertWritable() {
    this.assertAlive();
    if (this.options.readOnly)
      throw new Error("Fabric object editor is read-only.");
  }

  private resizeBackingStore(width: number, height: number) {
    this.logicalWidth = Math.max(1, Math.round(width));
    this.logicalHeight = Math.max(1, Math.round(height));
    const pixels = this.logicalWidth * this.logicalHeight;
    const budget =
      this.options.maxBackingPixels ?? FABRIC_EDITOR_MAX_BACKING_PIXELS;
    this.renderScale = Math.min(1, Math.sqrt(budget / pixels));
    this.canvas.setDimensions(
      {
        width: Math.max(1, Math.round(this.logicalWidth * this.renderScale)),
        height: Math.max(1, Math.round(this.logicalHeight * this.renderScale)),
      },
      { backstoreOnly: true },
    );
    this.canvas.setViewportTransform([
      this.renderScale,
      0,
      0,
      this.renderScale,
      0,
      0,
    ]);
  }

  private async suppressed(operation: () => Promise<void>) {
    this.suppressEvents += 1;
    try {
      await operation();
    } finally {
      this.suppressEvents -= 1;
    }
  }
}

function readMetadata(object: FabricObject): RuntimeMetadata | null {
  const data = (object as FabricObject & { data?: Partial<RuntimeMetadata> })
    .data;
  return data &&
    typeof data.objectId === "string" &&
    typeof data.objectVersion === "number" &&
    data.source
    ? (data as RuntimeMetadata)
    : null;
}

function requireMetadata(object: FabricObject) {
  const metadata = readMetadata(object);
  if (!metadata) throw new Error("Fabric object is missing Loomic metadata.");
  return metadata;
}

function commandRef(object: FabricObject) {
  const metadata = requireMetadata(object);
  return {
    object_id: metadata.objectId,
    expected_object_version: metadata.objectVersion,
  };
}

function fabricOptions(object: DesignObject) {
  return {
    left: object.x,
    top: object.y,
    width: object.width,
    height: object.height,
    angle: object.rotation,
    opacity: object.opacity,
    flipX: "flipX" in object ? Boolean(object.flipX) : false,
    flipY: "flipY" in object ? Boolean(object.flipY) : false,
    shadow:
      "shadow" in object && object.shadow ? fabricShadow(object.shadow) : null,
  };
}

function transformFields(object: FabricObject) {
  const transform = util.qrDecompose(object.calcTransformMatrix());
  const presentation = imagePresentationByRuntime.get(object);
  const width = Math.max(
    0.001,
    presentation
      ? presentation.frameWidth *
          Math.abs(transform.scaleX / presentation.baseScaleX)
      : object.width * Math.abs(transform.scaleX),
  );
  const height = Math.max(
    0.001,
    presentation
      ? presentation.frameHeight *
          Math.abs(transform.scaleY / presentation.baseScaleY)
      : object.height * Math.abs(transform.scaleY),
  );
  return {
    x: transform.translateX - width / 2,
    y: transform.translateY - height / 2,
    width,
    height,
    rotation: transform.angle,
    opacity: Number(object.opacity ?? 1),
  };
}

function transformPatch(object: FabricObject, type: DesignObject["type"]) {
  const fields = transformFields(object);
  const patch: Record<string, unknown> = {
    object_type: type,
    x: fields.x,
    y: fields.y,
    width: fields.width,
    height: fields.height,
    rotation: fields.rotation,
    opacity: fields.opacity,
  };
  if (
    (type === "text" || type === "textbox") &&
    (object instanceof IText || object instanceof Textbox)
  ) {
    Object.assign(patch, {
      text: object.text,
      font_family: object.fontFamily,
      font_size: object.fontSize,
      font_weight: object.fontWeight,
      font_style: object.fontStyle,
      text_align: object.textAlign,
      line_height: object.lineHeight,
      char_spacing: object.charSpacing,
    });
  }
  return patch as never;
}

function baseObject(
  type: DesignObject["type"],
  objectId: string,
  zIndex: number,
  runtime: FabricObject,
) {
  return {
    objectId,
    objectVersion: 1,
    type,
    name: `${type} ${zIndex + 1}`,
    ...transformFields(runtime),
    zIndex,
    locked: false,
    visible: true,
  };
}

function createNewDesignObject(
  input: AddFabricObjectInput,
  objectId: string,
  zIndex: number,
): DesignObject {
  const x = "x" in input ? (input.x ?? 40) : 40;
  const y = "y" in input ? (input.y ?? 40) : 40;
  if (input.type === "rect")
    return {
      ...common(
        input.type,
        objectId,
        zIndex,
        x,
        y,
        input.width ?? 240,
        input.height ?? 160,
      ),
      fill: solid("#ffffff"),
      stroke: solid("#111111"),
      strokeWidth: 2,
      radiusX: 8,
      radiusY: 8,
    };
  if (input.type === "circle" || input.type === "ellipse")
    return {
      ...common(
        "circle",
        objectId,
        zIndex,
        x,
        y,
        input.width ?? 160,
        input.height ?? 160,
      ),
      fill: solid("#ffffff"),
      stroke: solid("#111111"),
      strokeWidth: 2,
    };
  if (input.type === "triangle")
    return {
      ...common(
        input.type,
        objectId,
        zIndex,
        x,
        y,
        input.width ?? 180,
        input.height ?? 160,
      ),
      fill: solid("#ffffff"),
      stroke: solid("#111111"),
      strokeWidth: 2,
    };
  if (input.type === "line" || input.type === "arrow") {
    const x1 = input.x1 ?? 40;
    const y1 = input.y1 ?? 40;
    const x2 = input.x2 ?? 280;
    const y2 = input.y2 ?? 40;
    const result = {
      ...common(
        input.type,
        objectId,
        zIndex,
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(1, Math.abs(x2 - x1)),
        Math.max(1, Math.abs(y2 - y1)),
      ),
      stroke: solid("#111111"),
      strokeWidth: 3,
      x1,
      y1,
      x2,
      y2,
    };
    return input.type === "arrow"
      ? {
          ...result,
          type: "arrow",
          arrowStart: input.arrowStart ?? "none",
          arrowEnd: input.arrowEnd ?? "arrow",
        }
      : { ...result, type: "line" };
  }
  const text = input.text ?? (input.type === "text" ? "文字" : "文本框");
  const width =
    input.type === "textbox"
      ? (input.width ?? 320)
      : Math.max(1, text.length * 32);
  const result = {
    ...common(input.type, objectId, zIndex, x, y, width, 48),
    text,
    fontFamily: "Arial",
    fontSize: 40,
    fontWeight: 400,
    fontStyle: "normal" as const,
    textAlign: "left" as const,
    lineHeight: 1.2,
    charSpacing: 0,
    fill: solid("#111111"),
  };
  return input.type === "textbox"
    ? { ...result, type: "textbox", minWidth: 40 }
    : { ...result, type: "text" };
}

function common<T extends DesignObject["type"]>(
  type: T,
  objectId: string,
  zIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return {
    objectId,
    objectVersion: 1,
    type,
    name: `${type} ${zIndex + 1}`,
    x,
    y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    zIndex,
    locked: false,
    visible: true,
  };
}

function paintColor(paint: DesignPaint | null | undefined) {
  if (!paint) return "transparent";
  if (paint.kind === "solid") return paint.color;
  const colorStops = paint.stops.map((stop) => ({
    offset: stop.offset,
    color: stop.color,
  }));
  if (paint.kind === "radial") {
    return new Gradient({
      type: "radial",
      gradientUnits: "percentage",
      coords: {
        x1: paint.centerX,
        y1: paint.centerY,
        r1: 0,
        x2: paint.centerX,
        y2: paint.centerY,
        r2: paint.radius,
      },
      colorStops,
    });
  }
  const radians = (paint.angle * Math.PI) / 180;
  const dx = Math.cos(radians) / 2;
  const dy = Math.sin(radians) / 2;
  return new Gradient({
    type: "linear",
    gradientUnits: "percentage",
    coords: {
      x1: 0.5 - dx,
      y1: 0.5 - dy,
      x2: 0.5 + dx,
      y2: 0.5 + dy,
    },
    colorStops,
  });
}

function textOptions(
  object: Extract<DesignObject, { type: "text" | "textbox" }>,
) {
  return {
    fontFamily: object.fontFamily,
    fontSize: object.fontSize,
    fontWeight: object.fontWeight,
    fontStyle: object.fontStyle,
    textAlign: object.textAlign,
    lineHeight: object.lineHeight,
    charSpacing: object.charSpacing,
    fill: paintColor(object.fill),
    stroke: paintColor(object.stroke),
    strokeWidth: object.strokeWidth ?? 0,
  };
}

function createArrowRuntime(object: Extract<DesignObject, { type: "arrow" }>) {
  const dx = object.x2 - object.x1;
  const dy = object.y2 - object.y1;
  const line = new Line([0, 0, dx, dy], {
    stroke: paintColor(object.stroke),
    strokeWidth: object.strokeWidth,
    selectable: false,
    evented: false,
  });
  const children: FabricObject[] = [line];
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (object.arrowEnd === "arrow")
    children.push(
      new Triangle({
        left: dx,
        top: dy,
        width: 14,
        height: 18,
        fill: paintColor(object.stroke),
        angle,
        originX: "center",
        originY: "center",
        selectable: false,
        evented: false,
      }),
    );
  if (object.arrowStart === "arrow")
    children.push(
      new Triangle({
        left: 0,
        top: 0,
        width: 14,
        height: 18,
        fill: paintColor(object.stroke),
        angle: angle + 180,
        originX: "center",
        originY: "center",
        selectable: false,
        evented: false,
      }),
    );
  return new Group(children, fabricOptions(object));
}

function unionBounds(objects: readonly FabricObject[]) {
  const rects = objects.map((object) => object.getBoundingRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

async function resolveSource(source: string | Blob) {
  if (typeof source === "string") return { value: source };
  if (source.type === "image/svg+xml") return { value: await source.text() };
  const value = URL.createObjectURL(source);
  return { value, revoke: () => URL.revokeObjectURL(value) };
}

function bumpVersion(object: FabricObject) {
  const metadata = requireMetadata(object);
  metadata.objectVersion += 1;
  metadata.source.objectVersion = metadata.objectVersion;
}

function commandObjectId(command: DesignCommand) {
  return "object_id" in command
    ? command.object_id
    : "group_object_id" in command
      ? command.group_object_id
      : command.action;
}

const patchToSceneKey: Record<string, string> = {
  z_index: "zIndex",
  flip_x: "flipX",
  flip_y: "flipY",
  font_face_id: "fontFaceId",
  font_family: "fontFamily",
  font_size: "fontSize",
  font_weight: "fontWeight",
  font_style: "fontStyle",
  text_align: "textAlign",
  line_height: "lineHeight",
  char_spacing: "charSpacing",
  stroke_width: "strokeWidth",
  radius_x: "radiusX",
  radius_y: "radiusY",
  min_width: "minWidth",
  arrow_start: "arrowStart",
  arrow_end: "arrowEnd",
  asset_object_id: "assetObjectId",
  resource_id: "resourceId",
};

function applyPatchToRuntime(
  runtime: FabricObject,
  metadata: RuntimeMetadata,
  patch: DesignObjectPatch,
) {
  const record = patch as unknown as Record<string, unknown>;
  const source = metadata.source as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "object_type") continue;
    source[patchToSceneKey[key] ?? key] = structuredClone(value);
  }
  if (runtime instanceof IText || runtime instanceof Textbox) {
    if (typeof record.text === "string") runtime.set("text", record.text);
    if (typeof record.font_family === "string")
      runtime.set("fontFamily", record.font_family);
    if (typeof record.font_size === "number")
      runtime.set("fontSize", record.font_size);
    if (
      typeof record.font_weight === "string" ||
      typeof record.font_weight === "number"
    )
      runtime.set("fontWeight", record.font_weight);
    if (typeof record.font_style === "string")
      runtime.set("fontStyle", record.font_style);
    if (typeof record.text_align === "string")
      runtime.set("textAlign", record.text_align);
    if (typeof record.line_height === "number")
      runtime.set("lineHeight", record.line_height);
    if (typeof record.char_spacing === "number")
      runtime.set("charSpacing", record.char_spacing);
  }
  if (record.fill !== undefined)
    runtime.set("fill", paintColor(record.fill as DesignPaint | null));
  if (record.stroke !== undefined)
    runtime.set("stroke", paintColor(record.stroke as DesignPaint | null));
  if (typeof record.stroke_width === "number")
    runtime.set("strokeWidth", record.stroke_width);
  if (record.shadow !== undefined) {
    const shadow = record.shadow as DesignShadow | null;
    runtime.set("shadow", shadow ? fabricShadow(shadow) : null);
  }
  if (runtime instanceof FabricImage && metadata.source.type === "image") {
    applyImagePresentation(runtime, metadata.source);
  }
}

function fabricShadow(shadow: DesignShadow) {
  return new Shadow({
    color: colorWithOpacity(shadow.color, shadow.opacity),
    blur: shadow.blur,
    offsetX: shadow.offsetX,
    offsetY: shadow.offsetY,
  });
}

function colorWithOpacity(color: string, opacity: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${alpha}`;
}

function applyImagePresentation(
  runtime: FabricImage,
  object: Extract<DesignObject, { type: "image" }>,
) {
  const element = runtime.getElement();
  const sourceWidth =
    "naturalWidth" in element && element.naturalWidth > 0
      ? element.naturalWidth
      : Math.max(1, runtime.width);
  const sourceHeight =
    "naturalHeight" in element && element.naturalHeight > 0
      ? element.naturalHeight
      : Math.max(1, runtime.height);
  const layout = calculateDesignImageLayout({
    sourceWidth,
    sourceHeight,
    frameWidth: object.width,
    frameHeight: object.height,
    fit: object.fit,
    crop: object.crop,
    mask: object.mask,
  });
  runtime.set({
    left: object.x + layout.offsetX,
    top: object.y + layout.offsetY,
    cropX: layout.cropX,
    cropY: layout.cropY,
    width: layout.sourceWidth,
    height: layout.sourceHeight,
    scaleX: layout.scaleX,
    scaleY: layout.scaleY,
    stroke: paintColor(object.stroke),
    strokeWidth: object.strokeWidth ?? 0,
    shadow: object.shadow ? fabricShadow(object.shadow) : null,
  });
  imagePresentationByRuntime.set(runtime, {
    baseScaleX: layout.scaleX,
    baseScaleY: layout.scaleY,
    frameWidth: object.width,
    frameHeight: object.height,
  });

  const clip = layout.clip;
  const commonMask = {
    left: clip.left,
    top: clip.top,
    width: clip.width,
    height: clip.height,
    originX: "left" as const,
    originY: "top" as const,
  };
  runtime.set(
    "clipPath",
    clip.shape === "ellipse"
      ? new Ellipse({
          ...commonMask,
          rx: clip.width / 2,
          ry: clip.height / 2,
        })
      : new Rect({
          ...commonMask,
          rx: clip.radiusX,
          ry: clip.radiusY,
        }),
  );

  const filters = object.filters;
  runtime.filters = filters
    ? [
        ...(filters.brightness !== undefined
          ? [new fabricFilters.Brightness({ brightness: filters.brightness })]
          : []),
        ...(filters.contrast !== undefined
          ? [new fabricFilters.Contrast({ contrast: filters.contrast })]
          : []),
        ...(filters.saturation !== undefined
          ? [new fabricFilters.Saturation({ saturation: filters.saturation })]
          : []),
        ...(filters.blur !== undefined
          ? [new fabricFilters.Blur({ blur: filters.blur })]
          : []),
        ...(filters.grayscale ? [new fabricFilters.Grayscale()] : []),
        ...(filters.sepia ? [new fabricFilters.Sepia()] : []),
      ]
    : [];
  runtime.applyFilters();
  runtime.setCoords();
}

function inverseForCommand(
  command: DesignCommand,
  previousScene: LoomicSceneV1,
): DesignCommand {
  if (command.action === "object.add" || command.action === "object.clone") {
    return {
      action: "object.remove",
      object_id: command.object.objectId,
      expected_object_version: command.object.objectVersion,
    };
  }
  if (command.action === "object.remove") {
    const previous = previousScene.objects.find(
      (object) => object.objectId === command.object_id,
    );
    if (previous)
      return { action: "object.add", object: structuredClone(previous) };
  }
  if (command.action === "object.reorder") {
    const previousIndex = previousScene.objects.findIndex(
      (object) => object.objectId === command.object_id,
    );
    if (previousIndex >= 0) {
      return {
        action: "object.reorder",
        object_id: command.object_id,
        expected_object_version: command.expected_object_version + 1,
        to_index: previousIndex,
      };
    }
  }
  if (command.action === "objects.group") {
    return {
      action: "objects.ungroup",
      group_object_id: command.group.objectId,
      expected_object_version: command.group.objectVersion,
    };
  }
  if (command.action === "objects.ungroup") {
    const group = previousScene.objects.find(
      (object) =>
        object.objectId === command.group_object_id && object.type === "group",
    );
    if (group?.type === "group") {
      return {
        action: "objects.group",
        group: structuredClone(group),
        children: group.childObjectIds.map((objectId) => ({
          object_id: objectId,
          expected_object_version:
            previousScene.objects.find((object) => object.objectId === objectId)
              ?.objectVersion ?? 1,
        })),
      };
    }
  }
  if (command.action === "object.update") {
    const previous = previousScene.objects.find(
      (object) => object.objectId === command.object_id,
    );
    if (previous) {
      const patch: Record<string, unknown> = {
        object_type: command.patch.object_type,
      };
      for (const key of Object.keys(command.patch)) {
        if (key === "object_type") continue;
        const previousValue = (previous as unknown as Record<string, unknown>)[
          patchToSceneKey[key] ?? key
        ];
        patch[key] =
          key === "resource_id" && previousValue === undefined
            ? null
            : previousValue;
      }
      return {
        action: "object.update",
        object_id: command.object_id,
        expected_object_version: command.expected_object_version + 1,
        patch: patch as never,
      };
    }
  }
  return { action: "scene.replace", scene: structuredClone(previousScene) };
}

function patchChangesObject(patch: DesignObjectPatch, object: DesignObject) {
  const record = object as unknown as Record<string, unknown>;
  return Object.entries(patch).some(([key, value]) => {
    if (key === "object_type") return false;
    return (
      JSON.stringify(record[patchToSceneKey[key] ?? key]) !==
      JSON.stringify(value)
    );
  });
}

function applyCommandsToScene(
  input: LoomicSceneV1,
  commands: readonly DesignCommand[],
): LoomicSceneV1 {
  let scene = structuredClone(input);
  const find = (id: string) => {
    const object = scene.objects.find((candidate) => candidate.objectId === id);
    if (!object) throw new Error(`Design object not found: ${id}`);
    return object;
  };
  const reindex = () => {
    scene.objects.forEach((object, index) => {
      object.zIndex = index;
    });
  };
  for (const command of commands) {
    if (command.action === "scene.replace") {
      scene = structuredClone(command.scene);
      continue;
    }
    if (command.action === "object.add")
      scene.objects.push(structuredClone(command.object));
    else if (command.action === "object.clone")
      scene.objects.push(structuredClone(command.object));
    else if (command.action === "object.remove") {
      scene.objects = scene.objects.filter(
        (object) => object.objectId !== command.object_id,
      );
    } else if (command.action === "object.update") {
      const object = find(command.object_id);
      for (const [key, value] of Object.entries(command.patch)) {
        if (key !== "object_type")
          (object as unknown as Record<string, unknown>)[
            patchToSceneKey[key] ?? key
          ] = structuredClone(value);
      }
      object.objectVersion += 1;
    } else if (command.action === "object.reorder") {
      const object = find(command.object_id);
      object.objectVersion += 1;
      scene.objects = scene.objects.filter((candidate) => candidate !== object);
      scene.objects.splice(command.to_index, 0, object);
    } else if (command.action === "objects.group") {
      scene.objects.splice(
        command.group.zIndex,
        0,
        structuredClone(command.group),
      );
    } else if (command.action === "objects.ungroup") {
      scene.objects = scene.objects.filter(
        (object) => object.objectId !== command.group_object_id,
      );
    } else if (command.action === "objects.align") {
      const objects = command.objects.map((reference) =>
        find(reference.object_id),
      );
      const bounds = sceneBounds(objects);
      for (const object of objects) {
        if (command.alignment === "left") object.x = bounds.left;
        if (command.alignment === "right")
          object.x = bounds.right - object.width;
        if (command.alignment === "horizontal_center")
          object.x = (bounds.left + bounds.right - object.width) / 2;
        if (command.alignment === "top") object.y = bounds.top;
        if (command.alignment === "bottom")
          object.y = bounds.bottom - object.height;
        if (command.alignment === "vertical_center")
          object.y = (bounds.top + bounds.bottom - object.height) / 2;
        object.objectVersion += 1;
      }
    } else if (command.action === "objects.distribute") {
      const horizontal = command.direction === "horizontal";
      const objects = command.objects
        .map((reference) => find(reference.object_id))
        .sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const first = objects[0];
      const last = objects.at(-1);
      if (!first || !last) continue;
      const span = horizontal
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
      const total = objects.reduce(
        (sum, object) => sum + (horizontal ? object.width : object.height),
        0,
      );
      const gap = (span - total) / (objects.length - 1);
      let cursor = horizontal ? first.x : first.y;
      for (const object of objects) {
        if (horizontal) object.x = cursor;
        else object.y = cursor;
        cursor += (horizontal ? object.width : object.height) + gap;
        object.objectVersion += 1;
      }
    } else if (command.action === "object.set_role") {
      const object = find(command.object_id);
      object.role = command.role;
      object.objectVersion += 1;
    } else if (command.action === "canvas.update") {
      scene = applyDesignCanvasUpdate(scene, command);
    }
    reindex();
  }
  return loomicSceneV1Schema.parse(scene);
}

function sceneBounds(objects: readonly DesignObject[]) {
  return {
    left: Math.min(...objects.map((object) => object.x)),
    right: Math.max(...objects.map((object) => object.x + object.width)),
    top: Math.min(...objects.map((object) => object.y)),
    bottom: Math.max(...objects.map((object) => object.y + object.height)),
  };
}

type SnapRect = { left: number; top: number; width: number; height: number };

export function calculateObjectSnap(input: {
  moving: SnapRect;
  canvasWidth: number;
  canvasHeight: number;
  others: readonly SnapRect[];
  threshold: number;
}) {
  const movingX = [
    input.moving.left,
    input.moving.left + input.moving.width / 2,
    input.moving.left + input.moving.width,
  ];
  const movingY = [
    input.moving.top,
    input.moving.top + input.moving.height / 2,
    input.moving.top + input.moving.height,
  ];
  const xTargets = [
    { position: 0, source: "canvas" as const },
    { position: input.canvasWidth / 2, source: "canvas" as const },
    { position: input.canvasWidth, source: "canvas" as const },
    ...input.others.flatMap((rect) => [
      { position: rect.left, source: "object" as const },
      { position: rect.left + rect.width / 2, source: "object" as const },
      { position: rect.left + rect.width, source: "object" as const },
    ]),
  ];
  const yTargets = [
    { position: 0, source: "canvas" as const },
    { position: input.canvasHeight / 2, source: "canvas" as const },
    { position: input.canvasHeight, source: "canvas" as const },
    ...input.others.flatMap((rect) => [
      { position: rect.top, source: "object" as const },
      { position: rect.top + rect.height / 2, source: "object" as const },
      { position: rect.top + rect.height, source: "object" as const },
    ]),
  ];
  const x = nearestSnap(movingX, xTargets, input.threshold);
  const y = nearestSnap(movingY, yTargets, input.threshold);
  const guides: FabricAlignmentGuide[] = [];
  if (x) guides.push({ axis: "x", position: x.position, source: x.source });
  if (y) guides.push({ axis: "y", position: y.position, source: y.source });
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides };
}

function nearestSnap(
  anchors: readonly number[],
  targets: readonly { position: number; source: "canvas" | "object" }[],
  threshold: number,
) {
  let nearest:
    | {
        delta: number;
        distance: number;
        position: number;
        source: "canvas" | "object";
      }
    | undefined;
  for (const anchor of anchors) {
    for (const target of targets) {
      const delta = target.position - anchor;
      const distance = Math.abs(delta);
      if (distance <= threshold && (!nearest || distance < nearest.distance))
        nearest = { delta, distance, ...target };
    }
  }
  return nearest;
}

async function createAssetRuntime(type: "image" | "svg", source: string) {
  if (type === "image")
    return FabricImage.fromURL(source, { crossOrigin: "anonymous" });
  const parsed = await loadSVGFromString(source);
  return util.groupSVGElements(
    parsed.objects.filter((value): value is FabricObject => Boolean(value)),
    parsed.options,
  );
}
