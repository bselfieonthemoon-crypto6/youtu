export type CropResolution = { width: number; height: number };
export type NormalizedImageRegion = { x: number; y: number; width: number; height: number };
export type SourceImageRegion = CropResolution & { x: number; y: number };

type ImageLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  } | null;
  customData?: Record<string, unknown> & { originalWidth?: number; originalHeight?: number };
  version?: number;
};

/** Read the intrinsic pixel dimensions of the actual image file. */
export function readImageNaturalSize(source: string): Promise<CropResolution> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
        return;
      }
      reject(new Error("Unable to read image dimensions"));
    };
    image.onerror = () => reject(new Error("Unable to load image dimensions"));
    image.src = source;
  });
}

export async function renderImageCrop(
  source: string,
  element: ImageLike,
  requested: CropResolution,
  preferredMimeType = "image/png",
): Promise<{ dataURL: string; mimeType: string; width: number; height: number }> {
  const resized = resizeImageCrop(element, requested);
  const natural = getImageNaturalSize(resized);
  const crop = resized.crop ?? {
    x: 0,
    y: 0,
    width: natural.width,
    height: natural.height,
  };
  const width = Math.max(1, Math.round(crop.width));
  const height = Math.max(1, Math.round(crop.height));
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.crossOrigin = "anonymous";
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("无法加载原图，裁剪图片生成失败"));
    nextImage.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成裁剪图片");
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    width,
    height,
  );
  const supportedMimeType = ["image/png", "image/jpeg", "image/webp"].includes(preferredMimeType)
    ? preferredMimeType
    : "image/png";
  const dataURL = canvas.toDataURL(supportedMimeType, 0.95);
  const mimeType = dataURL.slice(5, dataURL.indexOf(";")) || supportedMimeType;
  return { dataURL, mimeType, width, height };
}

/** Map a 0..1 selection inside the displayed image to source-image pixels. */
export function mapNormalizedImageRegion(
  element: ImageLike,
  region: NormalizedImageRegion,
): SourceImageRegion {
  const natural = getImageNaturalSize(element);
  const visible = element.crop ?? {
    x: 0,
    y: 0,
    width: natural.width,
    height: natural.height,
  };
  const left = clamp(region.x, 0, 1);
  const top = clamp(region.y, 0, 1);
  const right = clamp(region.x + region.width, left, 1);
  const bottom = clamp(region.y + region.height, top, 1);
  const x = Math.round(visible.x + left * visible.width);
  const y = Math.round(visible.y + top * visible.height);
  const maxRight = Math.round(visible.x + visible.width);
  const maxBottom = Math.round(visible.y + visible.height);
  const width = Math.max(1, Math.round(visible.x + right * visible.width) - x);
  const height = Math.max(1, Math.round(visible.y + bottom * visible.height) - y);
  return {
    x: clamp(x, 0, natural.width - 1),
    y: clamp(y, 0, natural.height - 1),
    width: Math.min(width, maxRight - x, natural.width - x),
    height: Math.min(height, maxBottom - y, natural.height - y),
  };
}

/** Render only the user-selected image region for local foreground extraction. */
export async function renderImageRegion(
  source: string,
  element: ImageLike,
  region: NormalizedImageRegion,
): Promise<{ dataURL: string; mimeType: string; width: number; height: number }> {
  const sourceRegion = mapNormalizedImageRegion(element, region);
  const natural = getImageNaturalSize(element);
  return renderImageCrop(
    source,
    {
      ...element,
      width: sourceRegion.width,
      height: sourceRegion.height,
      crop: {
        ...sourceRegion,
        naturalWidth: natural.width,
        naturalHeight: natural.height,
      },
    },
    { width: sourceRegion.width, height: sourceRegion.height },
    "image/webp",
  );
}

export function setImageNaturalSize<T extends ImageLike>(
  element: T,
  natural: CropResolution,
): T {
  return {
    ...element,
    customData: {
      ...element.customData,
      originalWidth: Math.max(1, Math.round(natural.width)),
      originalHeight: Math.max(1, Math.round(natural.height)),
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getImageNaturalSize(element: ImageLike): CropResolution {
  return {
    width: Math.max(1, Math.round(element.crop?.naturalWidth ?? element.customData?.originalWidth ?? element.width)),
    height: Math.max(1, Math.round(element.crop?.naturalHeight ?? element.customData?.originalHeight ?? element.height)),
  };
}

export function getImageCropResolution(element: ImageLike): CropResolution {
  const natural = getImageNaturalSize(element);
  return {
    width: Math.max(1, Math.round(element.crop?.width ?? natural.width)),
    height: Math.max(1, Math.round(element.crop?.height ?? natural.height)),
  };
}

/** Resize the source-pixel crop around its current centre. */
export function resizeImageCrop(element: ImageLike, requested: CropResolution): ImageLike {
  const natural = getImageNaturalSize(element);
  const current = element.crop ?? {
    x: 0,
    y: 0,
    width: natural.width,
    height: natural.height,
    naturalWidth: natural.width,
    naturalHeight: natural.height,
  };
  const width = clamp(Math.round(requested.width), 10, natural.width);
  const height = clamp(Math.round(requested.height), 10, natural.height);
  const cropX = clamp(current.x + current.width / 2 - width / 2, 0, natural.width - width);
  const cropY = clamp(current.y + current.height / 2 - height / 2, 0, natural.height - height);
  const displayWidth = width * (element.width / current.width);
  const displayHeight = height * (element.height / current.height);
  const isFullImage = width === natural.width && height === natural.height && cropX === 0 && cropY === 0;

  return {
    ...element,
    x: element.x + (element.width - displayWidth) / 2,
    y: element.y + (element.height - displayHeight) / 2,
    width: displayWidth,
    height: displayHeight,
    crop: isFullImage ? null : {
      x: cropX,
      y: cropY,
      width,
      height,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
    },
    version: Number(element.version ?? 1) + 1,
  };
}
