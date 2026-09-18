/** Text-only edits preserve the decoded source frame, not UI generation defaults. */
export function buildTextReplacementContent(
  source: { dataURL: string; width: number; height: number },
  replacements: Array<{ original: string; replacement: string }>,
) {
  if (![source.width, source.height].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("无法读取原图尺寸，请重新选择图片。");
  const instructions = replacements.map(({ original, replacement }, index) => original
    ? `${index + 1}. 将“${original}”替换为“${replacement}”`
    : `${index + 1}. 添加文字“${replacement}”`).join("\n");
  return {
    input_images: [source.dataURL],
    aspect_ratio: `${source.width}:${source.height}`,
    prompt: `编辑参考图片中的文字：\n${instructions}\n严格保持原图的主体、Logo 图形、字体视觉风格、字号、颜色、位置、排版、背景、构图和其他所有内容不变；确保新文字拼写准确、清晰可读。只修改上述文字。保持原图 ${source.width}:${source.height} 的宽高比例，输出一张完整图片；不要拼图、上下分屏、重复画面或增加画面。`,
  };
}
