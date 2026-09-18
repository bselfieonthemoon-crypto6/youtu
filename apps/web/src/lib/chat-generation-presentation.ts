import type { ContentBlock, ToolBlock } from "@loomic/shared";
import type { Message } from "../hooks/use-chat-sessions";

function generation(block: ContentBlock): { id: string; block: ToolBlock; score: number } | null {
  if (block.type !== "tool" || !["generate_image", "edit_image", "confirm_image_generation"].includes(block.toolName)) return null;
  const output = block.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const value = output as Record<string, unknown>;
  if (typeof value.jobId !== "string" || !value.jobId) return null;
  const score = value.status === "succeeded" ? 100 : ["failed", "dead_letter", "canceled"].includes(String(value.status)) ? 50 : 0;
  return { id: value.jobId, block, score: score + (block.artifacts?.length ? 10 : 0) };
}

/** Display projection only: preserve audit messages and polling data unchanged.
 * A task owns its first visible slot; later status/audit copies update that slot.
 * Terminal results win over stale submission messages, including after reload.
 */
export function projectGenerationMessages(messages: readonly Message[]): Message[] {
  const best = new Map<string, { block: ToolBlock; score: number }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.contentBlocks) {
      const task = generation(block);
      if (!task) continue;
      const score = task.score + (message.id === task.id ? 1 : 0);
      if (!best.has(task.id) || score >= best.get(task.id)!.score) best.set(task.id, { block: task.block, score });
    }
  }
  const shown = new Set<string>();
  return messages.flatMap(message => {
    if (message.role !== "assistant") return [message];
    const boilerplate = new Set<string>();
    for (const block of message.contentBlocks) {
      const task = generation(block);
      if (!task) continue;
      if (block.type === "tool" && block.outputSummary) boilerplate.add(block.outputSummary.trim());
      const summary = (task.block.output as Record<string, unknown>).summary;
      if (typeof summary === "string") boilerplate.add(summary.trim());
    }
    let changed = false;
    const blocks = message.contentBlocks.flatMap((block): ContentBlock[] => {
      const task = generation(block);
      if (task) {
        if (shown.has(task.id)) { changed = true; return []; }
        shown.add(task.id);
        const selected = best.get(task.id)!.block;
        if (selected !== block) changed = true;
        return [selected];
      }
      if (block.type === "text" && boilerplate.has(block.text.trim())) { changed = true; return []; }
      return [block];
    });
    // Preserve empty streaming placeholders, but omit rows emptied by dedup.
    if (changed && !blocks.length) return [];
    return [changed ? { ...message, contentBlocks: blocks } : message];
  });
}
