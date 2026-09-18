/**
 * Request constraints that are documented for a specific upstream image model.
 *
 * Do not apply these values to similarly named gateway aliases such as
 * gpt-image-2-all: an OpenAI-compatible provider may implement a different
 * contract. Unknown models intentionally have no inferred limit here.
 */
export const GPT_IMAGE_2_REQUEST_LIMITS = {
  maxInputImages: 16,
  maxPromptCharacters: 32_000,
} as const;

export type ImageRequestLimitViolation = {
  code: "image_prompt_too_long" | "image_reference_limit_exceeded";
  message: string;
};

export function isExactGptImage2(
  model: string,
  upstreamModelId?: string,
): boolean {
  return model === "gpt-image-2" || upstreamModelId === "gpt-image-2";
}

/**
 * Returns a user-safe validation error before a request is quoted, charged or
 * sent. Callers that only know a public workspace alias can pass its frozen
 * upstream model ID; provider adapters receive the upstream ID directly.
 */
export function validateImageGenerationRequestLimits(input: {
  model: string;
  upstreamModelId?: string;
  prompt: string;
  inputImages?: readonly string[];
}): ImageRequestLimitViolation | null {
  if (!isExactGptImage2(input.model, input.upstreamModelId)) return null;

  if (input.prompt.length > GPT_IMAGE_2_REQUEST_LIMITS.maxPromptCharacters) {
    return {
      code: "image_prompt_too_long",
      message: `gpt-image-2 的提示词最多 ${GPT_IMAGE_2_REQUEST_LIMITS.maxPromptCharacters.toLocaleString("en-US")} 个字符；当前为 ${input.prompt.length.toLocaleString("en-US")} 个字符。请缩短提示词后重新提交，未创建任务或扣费。`,
    };
  }

  const inputImageCount = input.inputImages?.length ?? 0;
  if (inputImageCount > GPT_IMAGE_2_REQUEST_LIMITS.maxInputImages) {
    return {
      code: "image_reference_limit_exceeded",
      message: `gpt-image-2 最多接受 ${GPT_IMAGE_2_REQUEST_LIMITS.maxInputImages} 张参考图；当前为 ${inputImageCount} 张。请明确移除或分批提交参考图，系统不会静默删除任何图片，未创建任务或扣费。`,
    };
  }

  return null;
}
