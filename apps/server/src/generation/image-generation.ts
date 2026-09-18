import { getImageProvider } from "./providers/registry.js";
import type { GeneratedImage, ImageGenerateParams } from "./types.js";
import { GenerationError } from "./utils.js";

export async function generateImage(
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = getImageProvider(providerName);
  if (params.maskImage && !provider.supportsImageMask) {
    throw new GenerationError(
      providerName,
      "invalid_input",
      `Image provider ${providerName} does not support masked edits.`,
    );
  }
  return provider.generate(params);
}
