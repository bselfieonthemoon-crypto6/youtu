import type { DesignObject, DesignObjectRole } from "@loomic/shared";

export type DesignLayerNode = {
  object: DesignObject;
  children: DesignLayerNode[];
  depth: number;
};

export type DesignLayerMove = "up" | "down" | "top" | "bottom";

export type DesignLayerAdapter = {
  selectObjectIds: (objectIds: string[], mode: "replace" | "toggle") => void;
  renameObject: (objectId: string, name: string) => void;
  updateObject: (
    objectId: string,
    patch: { locked?: boolean; visible?: boolean },
  ) => void;
  reorderObject: (objectId: string, toIndex: number) => void;
  updateMany: (
    objectIds: string[],
    patch: { locked?: boolean; visible?: boolean },
  ) => void;
};

const TYPE_LABELS: Record<DesignObject["type"], string> = {
  image: "图片",
  svg: "SVG",
  text: "文字",
  textbox: "文本框",
  rect: "矩形",
  circle: "圆形",
  triangle: "三角形",
  line: "直线",
  arrow: "箭头",
  group: "组合",
};

export const DESIGN_ROLE_LABELS: Record<DesignObjectRole, string> = {
  background: "背景",
  title: "标题",
  subtitle: "副标题",
  logo: "标志",
  product: "产品",
  decoration: "装饰",
};

export function designLayerLabel(object: DesignObject): string {
  return object.name?.trim() || TYPE_LABELS[object.type];
}

export function buildDesignLayerTree(
  objects: readonly DesignObject[],
  query = "",
): DesignLayerNode[] {
  const byId = new Map(objects.map((object) => [object.objectId, object]));
  const childIds = new Set(
    objects.flatMap((object) =>
      object.type === "group" ? object.childObjectIds : [],
    ),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visit = (
    object: DesignObject,
    depth: number,
    ancestry: ReadonlySet<string>,
  ): DesignLayerNode | null => {
    if (ancestry.has(object.objectId)) return null;
    const nextAncestry = new Set(ancestry).add(object.objectId);
    const children =
      object.type === "group"
        ? object.childObjectIds.flatMap((childId) => {
            const child = byId.get(childId);
            if (!child) return [];
            const node = visit(child, depth + 1, nextAncestry);
            return node ? [node] : [];
          })
        : [];
    const roleLabel = object.role ? DESIGN_ROLE_LABELS[object.role] : "";
    const matches =
      normalizedQuery.length === 0 ||
      `${designLayerLabel(object)} ${TYPE_LABELS[object.type]} ${roleLabel}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    if (!matches && children.length === 0) return null;
    return { object, children, depth };
  };

  return [...objects]
    .filter((object) => !childIds.has(object.objectId))
    .sort((left, right) => right.zIndex - left.zIndex)
    .flatMap((object) => {
      const node = visit(object, 0, new Set());
      return node ? [node] : [];
    });
}

export function flattenVisibleDesignLayers(
  nodes: readonly DesignLayerNode[],
  collapsedGroupIds: ReadonlySet<string>,
): DesignLayerNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.object.type === "group" &&
    collapsedGroupIds.has(node.object.objectId)
      ? []
      : flattenVisibleDesignLayers(node.children, collapsedGroupIds)),
  ]);
}

export function designLayerMoveTarget(
  objects: readonly DesignObject[],
  objectId: string,
  move: DesignLayerMove,
): number | null {
  const current = objects.findIndex((object) => object.objectId === objectId);
  if (current < 0) return null;
  if (move === "top") return objects.length - 1;
  if (move === "bottom") return 0;
  if (move === "up") return Math.min(objects.length - 1, current + 1);
  return Math.max(0, current - 1);
}
