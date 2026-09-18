/** Same durable label in the canvas and manual import picker, independent of scene order. */
export function designBoardLabel(designId: string, name?: string): string {
  const title = name?.trim();
  return `${title && title !== "未命名设计" ? title : "画板"} · ${designId.slice(0, 8)}`;
}
