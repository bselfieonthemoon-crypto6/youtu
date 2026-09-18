export type MapRect = { x: number; y: number; width: number; height: number };
export type MapElement = MapRect & { id: string; angle?: number; isDeleted?: boolean; customData?: { kind?: string } };
export const MAP_WIDTH = 224;
export const MAP_HEIGHT = 144;

export function minimapLayout(elements: MapElement[], viewport: MapRect) {
  const blocks = elements.filter(el => !el.isDeleted && [el.x, el.y, el.width, el.height].every(Number.isFinite)).map(el => {
    const angle = Number.isFinite(el.angle) ? el.angle! : 0;
    const width = Math.abs(el.width * Math.cos(angle)) + Math.abs(el.height * Math.sin(angle));
    const height = Math.abs(el.width * Math.sin(angle)) + Math.abs(el.height * Math.cos(angle));
    return { id: el.id, board: el.customData?.kind === "loomic-design", x: el.x + el.width / 2 - width / 2, y: el.y + el.height / 2 - height / 2, width, height };
  });
  let left = viewport.x, top = viewport.y;
  let right = left + viewport.width, bottom = top + viewport.height;
  for (const block of blocks) {
    left = Math.min(left, block.x); top = Math.min(top, block.y);
    right = Math.max(right, block.x + block.width); bottom = Math.max(bottom, block.y + block.height);
  }
  const scale = Math.min((MAP_WIDTH - 24) / Math.max(1, right - left), (MAP_HEIGHT - 24) / Math.max(1, bottom - top));
  const offsetX = (MAP_WIDTH - (right - left) * scale) / 2 - left * scale;
  const offsetY = (MAP_HEIGHT - (bottom - top) * scale) / 2 - top * scale;
  return { blocks, scale, offsetX, offsetY };
}

export function mapPointToScroll(point: { x: number; y: number }, layout: ReturnType<typeof minimapLayout>, viewport: MapRect) {
  return {
    scrollX: -(point.x - layout.offsetX) / layout.scale + viewport.width / 2,
    scrollY: -(point.y - layout.offsetY) / layout.scale + viewport.height / 2,
  };
}

export function clampMapPosition(x: number, y: number, width: number, height: number) {
  return { x: Math.max(8, Math.min(x, width - 248)), y: Math.max(8, Math.min(y, height - 218)) };
}
