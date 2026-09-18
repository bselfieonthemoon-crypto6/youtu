import sharp from "sharp";
import { generateImage } from "../../generation/image-generation.js";
import { resolveImageProviderName } from "../../generation/providers/registry.js";
import { safeDownload } from "../../security/safe-download.js";
import type { FeynobgResult } from "./feynobg-service.js";

export const BACKGROUND_REMOVAL_MODEL = "gpt-image-2";

export type BackgroundRemovalProviderReference = {
  url: string;
  mimeType: string;
};

export type BackgroundRemovalProviderPersistence = {
  getOrCreate: (
    invoke: () => Promise<BackgroundRemovalProviderReference>,
  ) => Promise<BackgroundRemovalProviderReference>;
  persistDownloaded: (source: {
    buffer: Buffer;
    mimeType: string;
  }) => Promise<void>;
};

function invalidOutput(message: string) {
  return Object.assign(new Error(message), { code: "background_removal_invalid_output" });
}

/** Check pixels, not the filename or the provider's claim of transparency. */
export async function validateTransparentPng(buffer: Buffer): Promise<void> {
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== "png" || !metadata.hasAlpha) throw invalidOutput("未返回透明 PNG，未将不透明图片作为成功结果。");
  const alpha = await sharp(buffer).extractChannel("alpha").raw().toBuffer();
  if (!alpha.some(value => value < 255) || !alpha.some(value => value > 0)) throw invalidOutput("返回了不透明图片或空白图片，不能作为透明前景交付。");
}

/** Uses the job's pinned workspace provider, not a local model or all/vip fallback. */
export async function removeBackgroundWithApi(
  source: Buffer,
  model: string,
  options: { providerPersistence?: BackgroundRemovalProviderPersistence } = {},
): Promise<FeynobgResult> {
  if (model !== BACKGROUND_REMOVAL_MODEL && !model.startsWith("workspace:")) {
    throw new Error("去除背景模型配置错误：必须使用 gpt-image-2。");
  }
  const input = await sharp(source).rotate().png().toBuffer({ resolveWithObject: true });
  const { width, height } = input.info;
  // Native constraints: multiples of 16, at most 3:1, at least 655360 pixels.
  const scale = (width === height ? 1024 : 1536) / Math.max(width, height);
  const outputWidth = Math.max(512, Math.round(width * scale / 16) * 16);
  const outputHeight = Math.max(512, Math.round(height * scale / 16) * 16);
  const invoke = async (): Promise<BackgroundRemovalProviderReference> => {
    const generated = await generateImage(resolveImageProviderName(model), {
      model,
      prompt: "Remove only the background of the supplied image. Preserve all foreground subjects, logos, text, colors, shapes, fine edges and their relative positions as faithfully as possible. Do not redesign, add objects, crop the subject or draw a checkerboard. Return the entire subject on a genuinely transparent alpha background. Keep the original composition.",
      inputImages: [`data:image/png;base64,${input.data.toString("base64")}`],
      background: "transparent",
      outputFormat: "png",
      quality: "hd",
      outputWidth,
      outputHeight,
    });
    return { url: generated.url, mimeType: generated.mimeType };
  };
  const generated = options.providerPersistence
    ? await options.providerPersistence.getOrCreate(invoke)
    : await invoke();
  const downloaded = await safeDownload(generated.url, {
    kind: "image", maxBytes: 30 * 1024 * 1024, timeoutMs: 60000,
    maxRedirects: 2, allowDataUri: true,
    expectedMimeType: "image/png", allowedMimeTypes: ["image/png"],
  });
  await options.providerPersistence?.persistDownloaded({
    buffer: downloaded.buffer,
    mimeType: downloaded.mimeType,
  });
  await validateTransparentPng(downloaded.buffer);
  // Keep the source dimensions and do not stretch/crop the generated subject.
  const buffer = await sharp(downloaded.buffer).resize(width, height, {
    fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  return { model, width, height,
    layers: [{ kind: "foreground" as const, buffer, x: 0, y: 0, width, height }] };
}
