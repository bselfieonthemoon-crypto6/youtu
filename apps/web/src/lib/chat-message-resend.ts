import type { ContentBlock, ImageGenerationPreference, MessageMention } from "@loomic/shared";
import type { ReadyAttachment } from "../hooks/use-image-attachments";

/** Restore only this message's references, never the current composer's draft. */
export function messageResendReferences(blocks: ContentBlock[]) {
  const attachments: ReadyAttachment[] = [];
  const mentions: MessageMention[] = [];
  for (const block of blocks) {
    if (block.type === "image") {
      const { assetId, url, mimeType, source, name } = block;
      attachments.push({ assetId, url, mimeType, source, ...(name !== undefined ? { name } : {}) });
    } else if (block.type === "mention") {
      const { type: _type, ...mention } = block;
      mentions.push(mention);
    }
  }
  const models = [...new Set(mentions.filter(mention => mention.mentionType === "image-model").map(mention => mention.id))];
  const imageGenerationPreference: ImageGenerationPreference | undefined = models.length
    ? { mode: "manual", models } : undefined;
  return { attachments, mentions, imageGenerationPreference };
}
