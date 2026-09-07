/** Only an unambiguous approval may cross the generation billing boundary. */
export function isExplicitImageConfirmationMessage(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const text = prompt
    .trim()
    .toLowerCase()
    .replace(/[，。！？!?,.\s]/g, "");
  return /^(确认|确认生成|确认并生成|同意|同意生成|可以|可以生成|好|好的|没问题|开始生成|继续|继续生成|就按这个生成|按这个生成|确认就按这个生成|确认请按上述方案继续执行并生成预览)$/.test(
    text,
  );
}

export function isExplicitImageCancellation(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  return /^(取消|取消生成|不生成|不要生成|先不生成|算了|不要了)[。！!\s]*$/.test(
    prompt.trim(),
  );
}
