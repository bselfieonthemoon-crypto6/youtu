import type { DesignObject } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  buildDesignLayerTree,
  designLayerMoveTarget,
  flattenVisibleDesignLayers,
} from "../src/lib/design-layer-model";

const ids = {
  group: "10000000-0000-4000-8000-000000000001",
  child: "10000000-0000-4000-8000-000000000002",
  nested: "10000000-0000-4000-8000-000000000003",
  top: "10000000-0000-4000-8000-000000000004",
} as const;

describe("design layer model", () => {
  it("builds nested groups without duplicating children at the root", () => {
    const objects = [
      rect(ids.child, 0, "标题块", "title"),
      group(ids.nested, 1, [ids.child], "内部组合"),
      group(ids.group, 2, [ids.nested], "主组合"),
      rect(ids.top, 3, "装饰", "decoration"),
    ];
    const tree = buildDesignLayerTree(objects);
    expect(tree.map((node) => node.object.objectId)).toEqual([
      ids.top,
      ids.group,
    ]);
    expect(tree[1]?.children[0]?.children[0]?.object.objectId).toBe(ids.child);
    expect(
      flattenVisibleDesignLayers(tree, new Set()).map((node) => node.depth),
    ).toEqual([0, 0, 1, 2]);
    expect(flattenVisibleDesignLayers(tree, new Set([ids.group]))).toHaveLength(
      2,
    );
  });

  it("keeps matching descendants visible when filtering by name or role", () => {
    const objects = [
      rect(ids.child, 0, "主标题", "title"),
      group(ids.group, 1, [ids.child], "组合"),
    ];
    expect(buildDesignLayerTree(objects, "主标题")[0]?.children).toHaveLength(
      1,
    );
    expect(buildDesignLayerTree(objects, "标题")[0]?.children).toHaveLength(1);
    expect(buildDesignLayerTree(objects, "不存在")).toEqual([]);
  });

  it("maps relative and absolute stacking actions to scene indices", () => {
    const objects = [rect(ids.child, 0), rect(ids.nested, 1), rect(ids.top, 2)];
    expect(designLayerMoveTarget(objects, ids.nested, "up")).toBe(2);
    expect(designLayerMoveTarget(objects, ids.nested, "down")).toBe(0);
    expect(designLayerMoveTarget(objects, ids.child, "top")).toBe(2);
    expect(designLayerMoveTarget(objects, ids.top, "bottom")).toBe(0);
  });
});

function rect(
  objectId: string,
  zIndex: number,
  name = "矩形",
  role?: "title" | "decoration",
): DesignObject {
  return {
    objectId,
    objectVersion: 1,
    type: "rect",
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex,
    locked: false,
    visible: true,
    ...(role ? { role } : {}),
    fill: { kind: "solid", color: "#ffffff" },
    stroke: null,
    strokeWidth: 0,
  };
}

function group(
  objectId: string,
  zIndex: number,
  childObjectIds: string[],
  name: string,
): DesignObject {
  return {
    objectId,
    objectVersion: 1,
    type: "group",
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    zIndex,
    locked: false,
    visible: true,
    childObjectIds,
  };
}
