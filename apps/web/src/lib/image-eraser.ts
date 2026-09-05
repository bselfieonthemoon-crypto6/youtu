export type NormalizedErasePoint = { x: number; y: number };
export type NormalizedEraseStroke = {
  points: NormalizedErasePoint[];
  /** Brush radius relative to the shorter image edge. */
  radius: number;
  /** Subtract removes an earlier painted area from the final mask. */
  operation?: "add" | "subtract";
};

export function renderEraseMask(
  strokes: NormalizedEraseStroke[],
  width: number,
  height: number,
): string {
  const outputWidth = Math.max(1, Math.round(width));
  const outputHeight = Math.max(1, Math.round(height));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法创建橡皮蒙版");
  context.fillStyle = "black";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.strokeStyle = "white";
  context.fillStyle = "white";
  context.lineCap = "round";
  context.lineJoin = "round";
  const shorterEdge = Math.min(outputWidth, outputHeight);
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const color = stroke.operation === "subtract" ? "black" : "white";
    context.strokeStyle = color;
    context.fillStyle = color;
    const radius = Math.max(1, stroke.radius * shorterEdge);
    if (stroke.points.length === 1) {
      const point = stroke.points[0]!;
      context.beginPath();
      context.arc(point.x * outputWidth, point.y * outputHeight, radius, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.lineWidth = radius * 2;
    context.beginPath();
    context.moveTo(stroke.points[0]!.x * outputWidth, stroke.points[0]!.y * outputHeight);
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x * outputWidth, point.y * outputHeight);
    }
    context.stroke();
  }
  return canvas.toDataURL("image/png");
}
