/**
 * A deliberately small, Excalidraw-independent layout pass.  Keeping this
 * structural means callers can use it with scene elements without importing
 * Excalidraw into server/test bundles.
 */
export type TidyCanvasElement = {
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  isDeleted?: boolean;
  locked?: boolean;
  groupIds?: readonly string[];
  boundElements?: readonly { id?: string }[] | null;
  containerId?: string | null;
  frameId?: string | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  /** Linear elements keep coordinates relative to `x`/`y`; they can extend negatively. */
  points?: readonly (readonly [number, number])[];
  [key: string]: unknown;
};

export type TidySelection = Record<string, boolean | undefined> | readonly string[] | ReadonlySet<string> | undefined;

export type TidyCanvasLayoutResult<T extends TidyCanvasElement> = {
  elements: T[];
  movedCount: number;
};

type Bounds = { left: number; top: number; right: number; bottom: number };
type Cluster<T> = { members: T[]; bounds: Bounds; order: number };

export const CANVAS_TIDY_GAP = 64;

/**
 * Arrange selected scene objects (or every live object if there is no
 * selection) in a compact grid. Group, binding, and frame relationships are
 * treated as one movable unit. A locked member makes its whole unit fixed.
 *
 * The returned array retains its input order and only moved records are
 * cloned; callers can consequently stamp versions only for changed records.
 */
export function tidyCanvasLayout<T extends TidyCanvasElement>(
  elements: readonly T[],
  selectedElementIds?: TidySelection,
): TidyCanvasLayoutResult<T> {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const indexById = new Map(elements.map((element, index) => [element.id, index]));
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string | null | undefined) => {
    if (!b || !byId.has(a) || !byId.has(b)) return;
    (links.get(a) ?? links.set(a, new Set()).get(a)!).add(b);
    (links.get(b) ?? links.set(b, new Set()).get(b)!).add(a);
  };

  const groups = new Map<string, string[]>();
  for (const element of live) {
    for (const groupId of element.groupIds ?? []) {
      const members = groups.get(groupId) ?? [];
      members.push(element.id);
      groups.set(groupId, members);
    }
    for (const bound of element.boundElements ?? []) link(element.id, bound.id);
    link(element.id, element.containerId);
    link(element.id, element.frameId);
    // Connectors keep their endpoints. Moving an arrow without the elements it
    // is bound to would leave an invalid-looking connector behind.
    link(element.id, element.startBinding?.elementId);
    link(element.id, element.endBinding?.elementId);
  }
  for (const memberIds of groups.values()) {
    const first = memberIds[0];
    if (!first) continue;
    for (let index = 1; index < memberIds.length; index += 1) link(first, memberIds[index]);
  }

  const selected = selectedIds(selectedElementIds);
  const hasSelection = selected.size > 0;
  const visited = new Set<string>();
  const clusters: Cluster<T>[] = [];
  for (const element of live) {
    if (visited.has(element.id)) continue;
    const memberIds: string[] = [];
    const pending = [element.id];
    visited.add(element.id);
    while (pending.length) {
      const id = pending.pop()!;
      memberIds.push(id);
      for (const neighbour of links.get(id) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          pending.push(neighbour);
        }
      }
    }
    const members = memberIds.map((id) => byId.get(id)!).filter(Boolean);
    clusters.push({
      members,
      bounds: boundsOf(members),
      order: Math.min(...members.map((member) => indexById.get(member.id) ?? Number.MAX_SAFE_INTEGER)),
    });
  }

  const movable = clusters.filter((cluster) =>
    !cluster.members.some((member) => member.locked) &&
    (!hasSelection || cluster.members.some((member) => selected.has(member.id))),
  );
  if (!movable.length) return { elements: [...elements], movedCount: 0 };

  const fixed = clusters.filter((cluster) => !movable.includes(cluster));
  // Keep the user's rough reading order; this also makes repeated tidy clicks stable.
  movable.sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left || a.order - b.order);
  const columns = Math.ceil(Math.sqrt(movable.length));
  const rows = Math.ceil(movable.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(...movable.filter((_, index) => index % columns === column).map((cluster) => width(cluster.bounds))),
  );
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(...movable.slice(row * columns, (row + 1) * columns).map((cluster) => height(cluster.bounds))),
  );

  const baseLeft = Math.min(...movable.map((cluster) => cluster.bounds.left));
  let baseTop = Math.min(...movable.map((cluster) => cluster.bounds.top));
  const originalTargets = gridTargets(baseLeft, baseTop, movable, columns, columnWidths, rowHeights);
  if (originalTargets.some((target, index) => fixed.some((cluster) => intersects(target, cluster.bounds)))) {
    // A fixed cluster cannot be displaced. Put the whole grid below it so the
    // normal grid still has an exact, visually obvious 64px clearance.
    baseTop = Math.max(baseTop, Math.max(...fixed.map((cluster) => cluster.bounds.bottom)) + CANVAS_TIDY_GAP);
  }
  const targets = gridTargets(baseLeft, baseTop, movable, columns, columnWidths, rowHeights);
  const replacements = new Map<string, T>();
  for (let index = 0; index < movable.length; index += 1) {
    const cluster = movable[index]!;
    const target = targets[index]!;
    const deltaX = target.left - cluster.bounds.left;
    const deltaY = target.top - cluster.bounds.top;
    for (const member of cluster.members) {
      if (deltaX !== 0 || deltaY !== 0) {
        replacements.set(member.id, { ...member, x: member.x + deltaX, y: member.y + deltaY });
      }
    }
  }
  let movedCount = 0;
  const arranged = elements.map((element) => {
    const replacement = replacements.get(element.id);
    if (replacement) movedCount += 1;
    return replacement ?? element;
  });
  return { elements: arranged, movedCount };
}

function selectedIds(selection: TidySelection): Set<string> {
  if (!selection) return new Set();
  if (selection instanceof Set) return new Set(selection);
  if (Array.isArray(selection)) return new Set(selection);
  return new Set(Object.entries(selection).filter(([, selected]) => selected).map(([id]) => id));
}

function boundsOf(elements: readonly TidyCanvasElement[]): Bounds {
  return elements.reduce<Bounds>((total, element) => mergeBounds(total, elementBounds(element)), {
    left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity,
  });
}

function elementBounds(element: TidyCanvasElement): Bounds {
  const pointXs = element.points?.map((point) => point[0]).filter((point): point is number => Number.isFinite(point)) ?? [];
  const pointYs = element.points?.map((point) => point[1]).filter((point): point is number => Number.isFinite(point)) ?? [];
  const localLeft = pointXs.length ? Math.min(0, ...pointXs) : 0;
  const localTop = pointYs.length ? Math.min(0, ...pointYs) : 0;
  const localRight = pointXs.length ? Math.max(0, ...pointXs) : Math.abs(element.width ?? 0);
  const localBottom = pointYs.length ? Math.max(0, ...pointYs) : Math.abs(element.height ?? 0);
  const width = localRight - localLeft;
  const height = localBottom - localTop;
  const centreX = element.x + localLeft + width / 2;
  const centreY = element.y + localTop + height / 2;
  const angle = element.angle ?? 0;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const corners = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]];
  const xs = corners.map(([x, y]) => centreX + x! * cosine - y! * sine);
  const ys = corners.map(([x, y]) => centreY + x! * sine + y! * cosine);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

function width(bounds: Bounds) { return bounds.right - bounds.left; }
function height(bounds: Bounds) { return bounds.bottom - bounds.top; }
function intersects(a: Bounds, b: Bounds) { return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; }

function gridTargets<T>(left: number, top: number, clusters: readonly Cluster<TidyCanvasElement>[], columns: number, columnWidths: readonly number[], rowHeights: readonly number[]): Bounds[] {
  const xOffsets = columnWidths.map((_, column) => left + columnWidths.slice(0, column).reduce((sum, value) => sum + value + CANVAS_TIDY_GAP, 0));
  const yOffsets = rowHeights.map((_, row) => top + rowHeights.slice(0, row).reduce((sum, value) => sum + value + CANVAS_TIDY_GAP, 0));
  return clusters.map((cluster, index) => {
    const targetLeft = xOffsets[index % columns]!;
    const targetTop = yOffsets[Math.floor(index / columns)]!;
    return { left: targetLeft, top: targetTop, right: targetLeft + width(cluster.bounds), bottom: targetTop + height(cluster.bounds) };
  });
}
