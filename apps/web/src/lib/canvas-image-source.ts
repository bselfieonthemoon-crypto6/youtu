import { fetchAssetAsDataURL, fetchAsDataURL, fetchCanvasStorageAsDataURL } from "./canvas-elements";
import { getImageCropResolution, readImageNaturalSize, renderImageCrop, setImageNaturalSize } from "./canvas-image-crop";

type ImageElement = Parameters<typeof setImageNaturalSize>[0] & {
  fileId?: string | null;
  scale?: readonly number[];
};
type ImageFile = { dataURL?: string; assetId?: string; storageUrl?: string };

/** File bindings identify the current pixels; inherited element bindings may
 * still refer to an older image after a local edit creates a new file. */
export async function resolveCanvasImageSource(
  accessToken: string,
  element: ImageElement,
  files: Record<string, ImageFile>,
): Promise<string> {
  const file = element.fileId ? files[element.fileId] : undefined;
  if (file?.assetId) return fetchAssetAsDataURL(accessToken, file.assetId);
  if (file?.dataURL?.startsWith("data:image/")) return file.dataURL;
  const assetId = element.customData?.assetId;
  if (typeof assetId === "string") return fetchAssetAsDataURL(accessToken, assetId);
  if (file?.storageUrl) return fetchCanvasStorageAsDataURL(file.storageUrl);
  const storageUrl = element.customData?.storageUrl;
  if (typeof storageUrl === "string") return fetchAsDataURL(storageUrl);
  throw new Error("原图尚未加载完成，请稍后重试。");
}

/** Decode real dimensions, never infer source pixels from the display size.
 * Existing crops may have been authored against a smaller preview. */
export async function resolveCanvasImageGeometry(source: string, element: ImageElement) {
  const natural = await readImageNaturalSize(source);
  const normalized = setImageNaturalSize(element, natural);
  if (!element.crop) return normalized;
  const sx = natural.width / element.crop.naturalWidth;
  const sy = natural.height / element.crop.naturalHeight;
  return {
    ...normalized,
    crop: {
      x: element.crop.x * sx, y: element.crop.y * sy,
      width: element.crop.width * sx, height: element.crop.height * sy,
      naturalWidth: natural.width, naturalHeight: natural.height,
    },
  };
}

/** Pixel space matches the unrotated overlay, including crop and reflection.
 * Rotation is handled by the overlay's inverse pointer transform, not baked
 * into a bounding-box export (which would offset the erase mask). */
export async function prepareCanvasImageOperation(
  accessToken: string, element: ImageElement, files: Record<string, ImageFile>,
) {
  const source = await resolveCanvasImageSource(accessToken, element, files);
  const normalized = await resolveCanvasImageGeometry(source, element);
  const resolution = getImageCropResolution(normalized);
  const rendered = normalized.crop
    ? await renderImageCrop(source, normalized, resolution, "image/png")
    : { dataURL: source, mimeType: /^data:([^;,]+)/.exec(source)?.[1] ?? "image/png", ...resolution };
  const flipX = element.scale?.[0] === -1;
  const flipY = element.scale?.[1] === -1;
  if (!flipX && !flipY) return rendered;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("无法读取翻转图片。"));
    image.src = rendered.dataURL;
  });
  const canvas = document.createElement("canvas");
  canvas.width = rendered.width;
  canvas.height = rendered.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建图片处理画布。");
  ctx.translate(flipX ? canvas.width : 0, flipY ? canvas.height : 0);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(image, 0, 0);
  return { ...rendered, dataURL: canvas.toDataURL("image/png"), mimeType: "image/png" };
}
