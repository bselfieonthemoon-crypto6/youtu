import type { ImageGenerationPreference, MessageMention } from "@loomic/shared";
import type { ImageGenerationModelConstraint } from "./image-generation-contracts.js";

/**
 * Server-only model choice constraint derived from authenticated request
 * fields. It is not parsed from prompt text, Skill content or model output.
 *
 * Lives outside `runtime.ts` so the Mastra runtime can use it without pulling
 * the legacy DeepAgent graph (`runtime.ts` -> `deep-agent.ts`) into its module
 * graph. The type-only import below is erased at build time.
 */
export function buildImageGenerationModelConstraint(
  preference: ImageGenerationPreference | undefined,
  mentions: MessageMention[] = [],
): ImageGenerationModelConstraint | undefined {
  const manualModelIds = preference?.mode === "manual"
    ? [...new Set(preference.models)]
    : undefined;
  const mentionedModelIds = [...new Set(mentions.flatMap(mention =>
    mention.mentionType === "image-model" ? [mention.id] : []))];
  if (manualModelIds === undefined && !mentionedModelIds.length) return;
  return {
    ...(manualModelIds !== undefined ? { manualModelIds } : {}),
    ...(mentionedModelIds.length ? { mentionedModelIds } : {}),
  };
}
