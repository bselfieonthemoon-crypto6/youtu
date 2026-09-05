import { describe, expect, it } from "vitest";

import type { DesignCommand, LoomicSceneV1 } from "@loomic/shared";

import {
  type DesignCommandApplyError,
  applyDesignCommands,
} from "./design-command-applier.js";

const firstId = "10000000-0000-0000-0000-000000000001";
const secondId = "10000000-0000-0000-0000-000000000002";

function rect(objectId: string, zIndex: number, x: number) {
  return {
    objectId,
    objectVersion: 1,
    type: "rect" as const,
    x,
    y: 20,
    width: 100,
    height: 80,
    rotation: 0,
    opacity: 1,
    zIndex,
    locked: false,
    visible: true,
    fill: { kind: "solid" as const, color: "#ffffff" },
    stroke: { kind: "solid" as const, color: "#000000" },
    strokeWidth: 1,
  };
}

function scene(): LoomicSceneV1 {
  return {
    schemaVersion: 1,
    engine: "fabric",
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [rect(firstId, 0, 10), rect(secondId, 1, 300)],
  };
}

describe("applyDesignCommands", () => {
  it("applies a typed patch and increments only the target version", () => {
    const result = applyDesignCommands(scene(), [
      {
        action: "object.update",
        object_id: firstId,
        expected_object_version: 1,
        patch: { object_type: "rect", x: 42, radius_x: 8 },
      },
    ]);

    expect(result.objects[0]).toMatchObject({
      objectId: firstId,
      objectVersion: 2,
      x: 42,
      radiusX: 8,
    });
    expect(result.objects[1]?.objectVersion).toBe(1);
  });

  it("applies the canonical Agent text patch without changing unrelated text fields", () => {
    const input = scene();
    input.objects = [
      {
        objectId: firstId,
        objectVersion: 1,
        type: "text",
        x: 40,
        y: 40,
        width: 480,
        height: 80,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        visible: true,
        text: "Agent 修改前",
        fontFamily: "Arial",
        fontSize: 48,
        fontWeight: 700,
        fontStyle: "normal",
        textAlign: "left",
        lineHeight: 1.2,
        charSpacing: 0,
        fill: { kind: "solid", color: "#111111" },
      },
    ];

    const result = applyDesignCommands(input, [
      {
        action: "object.update",
        object_id: firstId,
        expected_object_version: 1,
        patch: { object_type: "text", text: "Agent 已真实修改" },
      },
    ]);

    expect(result.objects[0]).toMatchObject({
      objectId: firstId,
      objectVersion: 2,
      type: "text",
      text: "Agent 已真实修改",
      fontFamily: "Arial",
      fontSize: 48,
    });
  });

  it("applies advanced image properties through the canonical patch reducer", () => {
    const input = scene();
    input.objects = [
      {
        objectId: firstId,
        objectVersion: 1,
        type: "image",
        x: 10,
        y: 20,
        width: 320,
        height: 240,
        rotation: 0,
        opacity: 1,
        zIndex: 0,
        locked: false,
        visible: true,
        assetObjectId: "20000000-0000-0000-0000-000000000001",
        fit: "cover",
      },
    ];

    const result = applyDesignCommands(input, [
      {
        action: "object.update",
        object_id: firstId,
        expected_object_version: 1,
        patch: {
          object_type: "image",
          crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1 },
          filters: { brightness: 0.2, saturation: -0.1 },
          stroke: { kind: "solid", color: "#ffffff" },
          stroke_width: 3,
          shadow: {
            color: "#000000",
            blur: 8,
            offsetX: 2,
            offsetY: 4,
            opacity: 0.25,
          },
        },
      },
    ]);

    expect(result.objects[0]).toMatchObject({
      objectVersion: 2,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      mask: { shape: "ellipse" },
      filters: { brightness: 0.2, saturation: -0.1 },
      strokeWidth: 3,
    });
  });

  it("reindexes and versions every object shifted by an insertion", () => {
    const added = rect("10000000-0000-0000-0000-000000000003", 0, 0);
    const result = applyDesignCommands(scene(), [
      { action: "object.add", object: added },
    ]);

    expect(result.objects.map((object) => object.objectId)).toEqual([
      added.objectId,
      firstId,
      secondId,
    ]);
    expect(result.objects.map((object) => object.zIndex)).toEqual([0, 1, 2]);
    expect(result.objects.map((object) => object.objectVersion)).toEqual([
      1, 2, 2,
    ]);
  });

  it("rejects a stale object version before producing a next scene", () => {
    const command: DesignCommand = {
      action: "object.remove",
      object_id: firstId,
      expected_object_version: 9,
    };
    expect(() => applyDesignCommands(scene(), [command])).toThrowError(
      expect.objectContaining<Partial<DesignCommandApplyError>>({
        code: "object_version_conflict",
        objectId: firstId,
      }),
    );
  });

  it("keeps scene.replace exclusive", () => {
    expect(() =>
      applyDesignCommands(scene(), [
        { action: "scene.replace", scene: scene() },
        {
          action: "object.remove",
          object_id: firstId,
          expected_object_version: 1,
        },
      ]),
    ).toThrow("scene.replace must be the only command");
  });

  it("applies canonical uniform canvas scaling and advances object versions", () => {
    const input = scene();
    input.canvas.width = 400;
    input.canvas.height = 400;
    input.objects = [
      {
        ...rect(firstId, 0, 50),
        y: 50,
        width: 100,
        height: 100,
        objectVersion: 7,
      },
    ];

    const result = applyDesignCommands(input, [
      {
        action: "canvas.update",
        width: 800,
        height: 400,
        resize_mode: "scale",
      },
    ]);

    expect(result.objects[0]).toMatchObject({
      x: 250,
      y: 50,
      width: 100,
      height: 100,
      objectVersion: 8,
    });
  });
});
