/** Extract only a standalone cancellation command, never a question,
 * conditional instruction, quoted example, or compound edit request. */
export function namedImageCancellationSubject(prompt: unknown): string | null {
  if (typeof prompt !== "string" || prompt.length > 160 || /[?？]|如果|假如|不要取消|别取消|不取消|再生成|然后|同时|但是|并且/.test(prompt)) return null;
  const command = prompt.trim().replace(/^(?:先)?(?:不要|不)生成(?:了)?[，,。]\s*/u, "");
  const match = command.match(/^(?:请)?(?:帮我)?取消(?:刚才|刚刚)?(?:的)?(?:那个|这个|那张|这张)?\s*(.+?)[。！!\s]*$/u);
  if (!match) return null;
  const subject = match[1]!.replace(/^[“「"]|[”」"]$/g, "").replace(/(?:的)?(?:图片)?(?:生成任务|方案|生成)$/u, "").trim();
  return subject.length >= 2 && !/[，,；;\n]/.test(subject) ? subject : null;
}

export function matchesNamedImageCancellation(subject: string, title: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s“”「」"']/g, "");
  const key = normalize(subject);
  const titleKey = normalize(title);
  if (titleKey.includes(key)) return true;
  // Users naturally place orientation after a name while a saved title may
  // put it before the name. Both facts must match; never drop orientation.
  const orientation = key.match(/(横版|竖版)$/u)?.[1];
  const name = orientation ? key.slice(0, -orientation.length) : "";
  return name.length >= 2 && !!orientation && titleKey.includes(orientation) && titleKey.includes(name);
}
