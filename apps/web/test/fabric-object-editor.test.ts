import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeObject, FakeText, FakeGroup, FakeActiveSelection, FakeImage } =
  vi.hoisted(() => {
    class FakeObject {
      data?: unknown;
      left = 0;
      top = 0;
      width = 1;
      height = 1;
      scaleX = 1;
      scaleY = 1;
      angle = 0;
      opacity = 1;
      flipX = false;
      flipY = false;
      stroke?: unknown;
      visible = true;
      selectable = true;
      evented = true;
      lockMovementX = false;
      lockMovementY = false;
      lockScalingX = false;
      lockScalingY = false;
      lockRotation = false;

      constructor(options: Record<string, unknown> = {}) {
        Object.assign(this, options);
      }

      set(key: string | Record<string, unknown>, value?: unknown) {
        if (typeof key === "string") Object.assign(this, { [key]: value });
        else Object.assign(this, key);
        return this;
      }

      setCoords() {}
      getScaledWidth() {
        return this.width * this.scaleX;
      }
      getScaledHeight() {
        return this.height * this.scaleY;
      }
      getBoundingRect() {
        return {
          left: this.left,
          top: this.top,
          width: this.getScaledWidth(),
          height: this.getScaledHeight(),
        };
      }
      calcTransformMatrix() {
        return [
          this.scaleX,
          0,
          0,
          this.scaleY,
          this.left + this.getScaledWidth() / 2,
          this.top + this.getScaledHeight() / 2,
          this.angle,
        ];
      }
      async clone() {
        return new FakeObject({
          left: this.left,
          top: this.top,
          width: this.width,
          height: this.height,
          scaleX: this.scaleX,
          scaleY: this.scaleY,
          angle: this.angle,
          opacity: this.opacity,
          flipX: this.flipX,
          flipY: this.flipY,
        });
      }
    }

    class FakeText extends FakeObject {
      fontFamily = "Arial";
      fontSize = 40;
      fontWeight: string | number = 400;
      fontStyle = "normal";
      textAlign = "left";
      lineHeight = 1.2;
      charSpacing = 0;
      constructor(
        public text: string,
        options: Record<string, unknown> = {},
      ) {
        super(options);
      }
    }

    class FakeGroup extends FakeObject {
      constructor(
        private children: FakeObject[],
        options: Record<string, unknown> = {},
      ) {
        super(options);
      }
      getObjects() {
        return this.children;
      }
      removeAll() {
        const children = this.children;
        this.children = [];
        return children;
      }
    }

    class FakeActiveSelection extends FakeGroup {}
    class FakeImage extends FakeObject {
      filters: unknown[] = [];
      static async fromURL() {
        return new FakeImage({ width: 64, height: 64 });
      }
      getElement() {
        return {
          complete: true,
          naturalWidth: 64,
          naturalHeight: 64,
          decode: vi.fn(),
        };
      }
      applyFilters() {}
    }

    return { FakeObject, FakeText, FakeGroup, FakeActiveSelection, FakeImage };
  });

vi.mock("fabric", () => ({
  ActiveSelection: FakeActiveSelection,
  Circle: FakeObject,
  Ellipse: FakeObject,
  FabricImage: FakeImage,
  filters: {
    Blur: FakeObject,
    Brightness: FakeObject,
    Contrast: FakeObject,
    Grayscale: FakeObject,
    Saturation: FakeObject,
    Sepia: FakeObject,
  },
  Group: FakeGroup,
  Gradient: FakeObject,
  IText: FakeText,
  Line: class extends FakeObject {
    constructor(points: number[], options: Record<string, unknown>) {
      super({
        width: Math.max(1, Math.abs((points[2] ?? 1) - (points[0] ?? 0))),
        height: Math.max(1, Math.abs((points[3] ?? 1) - (points[1] ?? 0))),
        ...options,
      });
    }
  },
  Rect: FakeObject,
  Shadow: FakeObject,
  Textbox: FakeText,
  Triangle: FakeObject,
  loadSVGFromString: vi.fn(),
  util: {
    groupSVGElements: vi.fn(),
    sendObjectToPlane: vi.fn(),
    qrDecompose: vi.fn((matrix: number[]) => ({
      angle: matrix[6] ?? 0,
      scaleX: matrix[0] ?? 1,
      scaleY: matrix[3] ?? 1,
      translateX: matrix[4] ?? 0,
      translateY: matrix[5] ?? 0,
    })),
  },
}));

import {
  FabricObjectEditor,
  calculateObjectSnap,
} from "../src/components/design/fabric-object-editor";

type FakeObjectInstance = InstanceType<typeof FakeObject>;

class FakeCanvas {
  backgroundColor: string | null = null;
  private width = 800;
  private height = 600;
  private objects: FakeObjectInstance[] = [];
  private active: FakeObjectInstance | null = null;
  private listeners = new Map<
    string,
    Set<(event: { target?: FakeObjectInstance }) => void>
  >();
  viewportTransform: number[] = [1, 0, 0, 1, 0, 0];
  lastExportMultiplier = 0;

  on(name: string, listener: (event: { target?: FakeObjectInstance }) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  off(
    name: string,
    listener: (event: { target?: FakeObjectInstance }) => void,
  ) {
    this.listeners.get(name)?.delete(listener);
  }
  fire(name: string, event: { target?: FakeObjectInstance }) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  listenerCount(name: string) {
    return this.listeners.get(name)?.size ?? 0;
  }
  add(object: FakeObjectInstance) {
    this.objects.push(object);
  }
  remove(object: FakeObjectInstance) {
    this.objects = this.objects.filter((candidate) => candidate !== object);
  }
  clear() {
    this.objects = [];
  }
  getObjects() {
    return this.objects;
  }
  forEachObject(visitor: (object: FakeObjectInstance) => void) {
    this.objects.forEach(visitor);
  }
  setActiveObject(object: FakeObjectInstance) {
    this.active = object;
  }
  discardActiveObject() {
    this.active = null;
  }
  getActiveObjects() {
    return this.active instanceof FakeActiveSelection
      ? this.active.getObjects()
      : this.active
        ? [this.active]
        : [];
  }
  getActiveObject() {
    return this.active;
  }
  setDimensions(dimensions: { width: number; height: number }) {
    this.width = dimensions.width;
    this.height = dimensions.height;
  }
  setViewportTransform(transform: number[]) {
    this.viewportTransform = transform;
  }
  getWidth() {
    return this.width;
  }
  getHeight() {
    return this.height;
  }
  requestRenderAll() {}
  toCanvasElement(multiplier: number) {
    this.lastExportMultiplier = multiplier;
    return {
      toBlob(callback: (blob: Blob | null) => void, type: string) {
        callback(new Blob(["rendered"], { type }));
      },
    };
  }
  moveObjectTo(object: FakeObjectInstance, index: number) {
    this.remove(object);
    this.objects.splice(index, 0, object);
  }
  bringObjectToFront(object: FakeObjectInstance) {
    this.moveObjectTo(object, this.objects.length - 1);
  }
  sendObjectToBack(object: FakeObjectInstance) {
    this.moveObjectTo(object, 0);
  }
  bringObjectForward(object: FakeObjectInstance) {
    this.moveObjectTo(
      object,
      Math.min(this.objects.length - 1, this.objects.indexOf(object) + 1),
    );
  }
  sendObjectBackwards(object: FakeObjectInstance) {
    this.moveObjectTo(object, Math.max(0, this.objects.indexOf(object) - 1));
  }
}

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

describe("FabricObjectEditor", () => {
  let canvas: FakeCanvas;
  let nextId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    canvas = new FakeCanvas();
    nextId = vi.fn();
    for (const id of ids) nextId.mockReturnValueOnce(id);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("adds durable objects and serializes a strict Loomic scene", () => {
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
    });
    const rectId = editor.addObject({ type: "rect", width: 120, height: 80 });
    const ellipseId = editor.addObject({
      type: "ellipse",
      width: 160,
      height: 80,
    });
    const textId = editor.addObject({
      type: "textbox",
      text: "Loomic",
      width: 240,
    });
    editor.updateObject(textId, {
      fontWeight: 700,
      fontStyle: "italic",
      lineHeight: 1.5,
      charSpacing: 20,
      fill: { kind: "solid", color: "#ff0000" },
      stroke: { kind: "solid", color: "#ffffff" },
      strokeWidth: 2,
      shadow: {
        color: "#000000",
        blur: 8,
        offsetX: 0,
        offsetY: 4,
        opacity: 0.25,
      },
    });

    const scene = editor.serializeScene();
    expect([rectId, ellipseId]).toEqual(ids.slice(0, 2));
    expect(scene.objects.map((object) => object.type)).toEqual([
      "rect",
      "circle",
      "textbox",
    ]);
    expect(scene.objects.map((object) => object.zIndex)).toEqual([0, 1, 2]);
    expect(scene.objects[1]).toMatchObject({ width: 160, height: 80 });
    expect(scene.objects[2]).toMatchObject({
      type: "textbox",
      fontWeight: 700,
      fontStyle: "italic",
      lineHeight: 1.5,
      charSpacing: 20,
      strokeWidth: 2,
    });
  });

  it("coalesces a multi-selection modification into one structured history event", async () => {
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const first = editor.addObject({ type: "rect" });
    const second = editor.addObject({ type: "triangle" });
    onCommand.mockClear();
    editor.select([first, second]);
    for (const object of canvas.getActiveObjects()) object.left += 10;

    canvas.fire("object:modified", {
      target: canvas.getActiveObject() ?? new FakeObject(),
    });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      source: "user",
      mergeKey: `transform:${first},${second}`,
      commands: [{ action: "object.update" }, { action: "object.update" }],
      edits: [
        {
          command: { action: "object.update" },
          inverse: { action: "object.update" },
        },
        {
          command: { action: "object.update" },
          inverse: { action: "object.update" },
        },
      ],
    });
    expect(
      editor.serializeScene().objects.map((object) => object.objectVersion),
    ).toEqual([2, 2]);
    await editor.applyCommands(
      onCommand.mock.calls[0]?.[0].inverseCommands,
      "undo",
    );
    expect(
      editor.serializeScene().objects.map((object) => object.objectVersion),
    ).toEqual([3, 3]);
  });

  it("performs selection operations and releases its Fabric listener", () => {
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const first = editor.addObject({ type: "rect", x: 10 });
    const second = editor.addObject({ type: "rect", x: 200 });
    const third = editor.addObject({ type: "rect", x: 400 });

    editor.align([first, second], "left");
    editor.distribute([first, second, third], "horizontal");
    editor.flip([first], "horizontal");
    editor.setLocked([first], true);
    editor.setVisible([second], false);
    editor.reorder(first, "front");

    expect(editor.serializeScene().objects.at(-1)).toMatchObject({
      objectId: first,
      locked: true,
    });
    expect(
      onCommand.mock.calls
        .flatMap((call) => call[0].commands)
        .map((command) => command.action),
    ).toEqual(
      expect.arrayContaining([
        "objects.align",
        "objects.distribute",
        "object.update",
        "object.reorder",
      ]),
    );
    expect(canvas.listenerCount("object:modified")).toBe(1);
    editor.dispose();
    expect(canvas.listenerCount("object:modified")).toBe(0);
  });

  it("updates base and text properties canonically and publishes selection", () => {
    const onCommand = vi.fn();
    const selections = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const unsubscribe = editor.subscribeSelection(selections);
    const objectId = editor.addObject({ type: "textbox", text: "old" });
    onCommand.mockClear();

    editor.updateObject(objectId, {
      name: "Title",
      x: 120,
      y: 90,
      width: 360,
      height: 120,
      rotation: 12,
      opacity: 0.75,
      text: "new",
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: 700,
      fontStyle: "italic",
      textAlign: "center",
    });

    expect(selections).toHaveBeenLastCalledWith([objectId]);
    expect(editor.serializeScene().objects[0]).toMatchObject({
      name: "Title",
      x: 120,
      y: 90,
      width: 360,
      height: 120,
      rotation: 12,
      opacity: 0.75,
      text: "new",
      fontFamily: "Inter",
      fontSize: 48,
      fontWeight: 700,
      fontStyle: "italic",
      textAlign: "center",
      objectVersion: 2,
    });
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      commands: [
        {
          action: "object.update",
          patch: {
            object_type: "textbox",
            name: "Title",
            text: "new",
            font_family: "Inter",
          },
        },
      ],
      edits: [{ inverse: { action: "object.update" } }],
    });
    unsubscribe();
  });

  it("groups and ungroups through real runtime collection operations", () => {
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const first = editor.addObject({ type: "rect" });
    const second = editor.addObject({ type: "circle" });
    const groupId = editor.group([first, second]);

    expect(groupId).toBe(ids[2]);
    expect(
      editor.serializeScene().objects.map((object) => object.type),
    ).toEqual(["group", "rect", "circle"]);
    editor.ungroup(groupId ?? "");
    expect(
      editor.serializeScene().objects.map((object) => object.type),
    ).toEqual(["rect", "circle"]);
    expect(
      onCommand.mock.calls
        .flatMap((call) => call[0].commands)
        .map((command) => command.action),
    ).toEqual(expect.arrayContaining(["objects.group", "objects.ungroup"]));
  });

  it("reports an asset that cannot be resolved without silently substituting it", async () => {
    const onResourceMissing = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      onResourceMissing,
    });
    await editor.loadScene(
      {
        schemaVersion: 1,
        engine: "fabric",
        canvas: { width: 400, height: 300, background: null },
        objects: [
          {
            objectId: ids[0] ?? "",
            objectVersion: 1,
            type: "image",
            assetObjectId: ids[3] ?? "",
            fit: "contain",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
            zIndex: 0,
            locked: false,
            visible: true,
          },
        ],
      },
      () => {
        throw new Error("not found");
      },
    );

    expect(onResourceMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: ids[0],
        assetObjectId: ids[3],
        type: "image",
        error: expect.any(Error),
      }),
    );
    expect(canvas.getObjects()).toHaveLength(0);
    await expect(editor.waitForImages()).resolves.toEqual({
      missingAssetObjectIds: [ids[3]],
    });
  });

  it("revokes a temporary Blob URL after the image has loaded", async () => {
    const createObjectURL = vi.fn(() => "blob:authorized-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
    });

    await editor.addImage({
      assetObjectId: ids[3] ?? "",
      resourceId: ids[1] ?? "",
      source: new Blob(["image"], { type: "image/png" }),
    });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:authorized-image");
    expect(editor.serializeScene().objects[0]).toMatchObject({
      assetObjectId: ids[3],
      resourceId: ids[1],
    });
    const blob = await editor.renderToBlob({
      format: "png",
      multiplier: 2,
      transparent: true,
    });
    expect(blob.type).toBe("image/png");
  });

  it("restores advanced image crop, mask, filters, stroke and shadow", async () => {
    const editor = new FabricObjectEditor(canvas as never);
    await editor.loadScene(
      {
        schemaVersion: 1,
        engine: "fabric",
        canvas: { width: 400, height: 300, background: null },
        objects: [
          {
            objectId: ids[0] ?? "",
            objectVersion: 1,
            type: "image",
            assetObjectId: ids[3] ?? "",
            fit: "cover",
            x: 20,
            y: 30,
            width: 160,
            height: 120,
            rotation: 0,
            opacity: 1,
            zIndex: 0,
            locked: false,
            visible: true,
            crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
            mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1 },
            filters: {
              brightness: 0.2,
              contrast: -0.1,
              grayscale: true,
            },
            stroke: { kind: "solid", color: "#ffffff" },
            strokeWidth: 3,
            shadow: {
              color: "#000000",
              blur: 8,
              offsetX: 2,
              offsetY: 4,
              opacity: 0.25,
            },
          },
        ],
      },
      () => "https://example.test/image.png",
    );

    expect(canvas.getObjects()[0]).toMatchObject({
      cropX: 16,
      cropY: 16,
      width: 32,
      height: 32,
      scaleX: 5,
      scaleY: 3.75,
      stroke: "#ffffff",
      strokeWidth: 3,
      clipPath: expect.any(FakeObject),
      filters: [
        expect.any(FakeObject),
        expect.any(FakeObject),
        expect.any(FakeObject),
      ],
      shadow: expect.any(FakeObject),
    });
    expect(editor.serializeScene().objects[0]).toMatchObject({
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      mask: { shape: "ellipse" },
      filters: { brightness: 0.2, contrast: -0.1, grayscale: true },
    });
  });

  it("matches server contain and cover viewport geometry without changing durable bounds", async () => {
    const editor = new FabricObjectEditor(canvas as never);
    const image = (fit: "contain" | "cover", y: number) => ({
      objectId: fit === "contain" ? (ids[0] ?? "") : (ids[1] ?? ""),
      objectVersion: 1,
      type: "image" as const,
      assetObjectId: ids[3] ?? "",
      fit,
      x: 20,
      y,
      width: 160,
      height: 80,
      rotation: 0,
      opacity: 1,
      zIndex: fit === "contain" ? 0 : 1,
      locked: false,
      visible: true,
    });
    await editor.loadScene(
      {
        schemaVersion: 1,
        engine: "fabric",
        canvas: { width: 400, height: 300, background: null },
        objects: [image("contain", 20), image("cover", 120)],
      },
      () => "https://example.test/image.png",
    );

    expect(canvas.getObjects()[0]).toMatchObject({
      left: 60,
      top: 20,
      width: 64,
      height: 64,
      scaleX: 1.25,
      scaleY: 1.25,
    });
    expect(canvas.getObjects()[1]).toMatchObject({
      left: 20,
      top: 80,
      width: 64,
      height: 64,
      scaleX: 2.5,
      scaleY: 2.5,
      clipPath: expect.objectContaining({
        left: -32,
        top: -16,
        width: 64,
        height: 32,
      }),
    });
    expect(editor.serializeScene().objects).toEqual([
      expect.objectContaining({ x: 20, y: 20, width: 160, height: 80 }),
      expect.objectContaining({ x: 20, y: 120, width: 160, height: 80 }),
    ]);
  });

  it("keeps gradient image strokes as Fabric gradients", async () => {
    const editor = new FabricObjectEditor(canvas as never);
    await editor.loadScene(
      {
        schemaVersion: 1,
        engine: "fabric",
        canvas: { width: 200, height: 200, background: null },
        objects: [
          {
            objectId: ids[0] ?? "",
            objectVersion: 1,
            type: "image",
            assetObjectId: ids[3] ?? "",
            fit: "fill",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
            zIndex: 0,
            locked: false,
            visible: true,
            stroke: {
              kind: "linear",
              angle: 90,
              stops: [
                { offset: 0, color: "#ff0000" },
                { offset: 1, color: "#0000ff" },
              ],
            },
            strokeWidth: 4,
          },
        ],
      },
      () => "https://example.test/image.png",
    );

    const gradient = canvas.getObjects()[0]?.stroke as
      | (FakeObjectInstance & {
          coords?: { x1?: number; y1?: number; x2?: number; y2?: number };
        })
      | undefined;
    expect(gradient).toMatchObject({
      type: "linear",
      gradientUnits: "percentage",
      colorStops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
      ],
    });
    expect(gradient?.coords?.x1).toBeCloseTo(0.5);
    expect(gradient?.coords?.y1).toBeCloseTo(0);
    expect(gradient?.coords?.x2).toBeCloseTo(0.5);
    expect(gradient?.coords?.y2).toBeCloseTo(1);
  });

  it("keeps huge documents logical while capping backing pixels and export", async () => {
    const editor = new FabricObjectEditor(canvas as never, {
      logicalWidth: 32768,
      logicalHeight: 32768,
      maxBackingPixels: 1_000_000,
    });

    expect(canvas.getWidth()).toBeLessThanOrEqual(1000);
    expect(canvas.getHeight()).toBeLessThanOrEqual(1000);
    expect(canvas.viewportTransform[0]).toBeCloseTo(1000 / 32768, 3);
    expect(editor.serializeScene().canvas).toMatchObject({
      width: 32768,
      height: 32768,
    });
    await expect(editor.renderToBlob()).rejects.toThrow(
      "Browser export pixel budget exceeded",
    );
  });

  it("applies canonical scale-resize without stretching objects", async () => {
    const editor = new FabricObjectEditor(canvas as never, {
      logicalWidth: 400,
      logicalHeight: 400,
    });
    await editor.loadScene({
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 400, height: 400, background: null },
      objects: [
        {
          objectId: ids[0] ?? "",
          objectVersion: 4,
          type: "rect",
          x: 50,
          y: 50,
          width: 100,
          height: 100,
          rotation: 0,
          opacity: 1,
          zIndex: 0,
          locked: false,
          visible: true,
          fill: { kind: "solid", color: "#ff0000" },
          stroke: null,
          strokeWidth: 0,
          shadow: null,
        },
      ],
    });

    await editor.applyCommands(
      [
        {
          action: "canvas.update",
          width: 800,
          height: 400,
          resize_mode: "scale",
        },
      ],
      "sync",
    );

    expect(editor.serializeScene()).toMatchObject({
      canvas: { width: 800, height: 400 },
      objects: [
        {
          x: 250,
          y: 50,
          width: 100,
          height: 100,
          objectVersion: 5,
        },
      ],
    });
  });

  it("captures committed text editing as one history command", () => {
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const objectId = editor.addObject({ type: "text", text: "before" });
    onCommand.mockClear();
    const text = canvas.getActiveObject() as InstanceType<typeof FakeText>;
    text.text = "after";

    canvas.fire("text:editing:exited", { target: text });
    canvas.fire("object:modified", { target: text });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      mergeKey: `text:${objectId}`,
      commands: [
        {
          action: "object.update",
          patch: { object_type: "text", text: "after" },
        },
      ],
      edits: [
        {
          inverse: {
            action: "object.update",
            patch: { object_type: "text", text: "before" },
          },
        },
      ],
    });
  });

  it("renders logical output dimensions when backing pixels are downscaled", async () => {
    const editor = new FabricObjectEditor(canvas as never, {
      logicalWidth: 4000,
      logicalHeight: 4000,
      maxBackingPixels: 1_000_000,
    });

    await editor.renderToBlob({ multiplier: 1 });

    expect(canvas.getWidth()).toBe(1000);
    expect(canvas.lastExportMultiplier).toBe(4);
  });

  it("clones non-group selections with new durable ids and canonical commands", async () => {
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const originalId = editor.addObject({ type: "rect", x: 20, y: 30 });
    onCommand.mockClear();

    const clonedIds = await editor.cloneSelection();

    expect(clonedIds).toEqual([ids[1]]);
    expect(editor.serializeScene().objects[1]).toMatchObject({
      objectId: ids[1],
      objectVersion: 1,
      x: 36,
      y: 46,
    });
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      commands: [
        {
          action: "object.clone",
          source_object_id: originalId,
          object: { objectId: ids[1] },
        },
      ],
      inverseCommands: [{ action: "object.remove", object_id: ids[1] }],
    });
  });

  it("rejects group cloning explicitly instead of producing a shallow corrupt copy", async () => {
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
    });
    const first = editor.addObject({ type: "rect" });
    const second = editor.addObject({ type: "circle" });
    editor.group([first, second]);

    await expect(editor.cloneSelection()).rejects.toThrow(
      "Group cloning is not supported",
    );
  });

  it("replaces the selected asset while retaining its logical box", async () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:asset"),
      revokeObjectURL: vi.fn(),
    });
    const onCommand = vi.fn();
    const editor = new FabricObjectEditor(canvas as never, {
      createId: nextId,
      onCommand,
    });
    const objectId = await editor.addImage({
      assetObjectId: ids[2] ?? "",
      source: new Blob(["old"], { type: "image/png" }),
    });
    editor.updateObject(objectId, {
      x: 120,
      y: 80,
      width: 300,
      height: 180,
      rotation: 15,
    });
    onCommand.mockClear();

    await editor.replaceSelectedAsset({
      assetObjectId: ids[3] ?? "",
      resourceId: null,
      source: new Blob(["new"], { type: "image/png" }),
    });

    expect(editor.serializeScene().objects[0]).toMatchObject({
      objectId,
      assetObjectId: ids[3],
      resourceId: null,
      x: 120,
      y: 80,
      width: 300,
      height: 180,
      rotation: 15,
    });
    expect(onCommand.mock.calls[0]?.[0]).toMatchObject({
      commands: [
        {
          action: "object.update",
          object_id: objectId,
          patch: {
            object_type: "image",
            asset_object_id: ids[3],
            resource_id: null,
          },
        },
      ],
    });
  });

  it("snaps to canvas centers and neighboring object edges", () => {
    expect(
      calculateObjectSnap({
        moving: { left: 448, top: 3, width: 100, height: 100 },
        canvasWidth: 1000,
        canvasHeight: 800,
        others: [],
        threshold: 5,
      }),
    ).toEqual({
      dx: 2,
      dy: -3,
      guides: [
        { axis: "x", position: 500, source: "canvas" },
        { axis: "y", position: 0, source: "canvas" },
      ],
    });
    expect(
      calculateObjectSnap({
        moving: { left: 198, top: 50, width: 50, height: 50 },
        canvasWidth: 1000,
        canvasHeight: 800,
        others: [{ left: 250, top: 200, width: 100, height: 100 }],
        threshold: 3,
      }).dx,
    ).toBe(2);
  });
});
