import type { DesignImageCrop, DesignImageMask } from "@loomic/shared";

type ImageLayoutInput = {
  sourceWidth: number;
  sourceHeight: number;
  frameWidth: number;
  frameHeight: number;
  fit: "contain" | "cover" | "fill" | "original";
  crop?: DesignImageCrop | null | undefined;
  mask?: DesignImageMask | null | undefined;
};

export type DesignImageLayout = {
  cropX: number;
  cropY: number;
  sourceWidth: number;
  sourceHeight: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  clip: {
    shape: DesignImageMask["shape"];
    left: number;
    top: number;
    width: number;
    height: number;
    radiusX: number;
    radiusY: number;
  };
};

/**
 * Mirrors the server SVG renderer's image viewport rules. A normalized crop is
 * stretched into the destination frame; otherwise `preserveAspectRatio` is
 * represented by uniform contain/cover scaling (`original` is server-compatible
 * `meet`). Clip coordinates are returned in Fabric image-local units.
 */
export function calculateDesignImageLayout(
  input: ImageLayoutInput,
): DesignImageLayout {
  const sourceWidth = positive(input.sourceWidth);
  const sourceHeight = positive(input.sourceHeight);
  const frameWidth = positive(input.frameWidth);
  const frameHeight = positive(input.frameHeight);
  const crop = input.crop;
  const cropX = crop ? sourceWidth * crop.x : 0;
  const cropY = crop ? sourceHeight * crop.y : 0;
  const visibleWidth = crop ? sourceWidth * crop.width : sourceWidth;
  const visibleHeight = crop ? sourceHeight * crop.height : sourceHeight;

  let scaleX = frameWidth / visibleWidth;
  let scaleY = frameHeight / visibleHeight;
  if (!crop && input.fit !== "fill") {
    const uniform =
      input.fit === "cover"
        ? Math.max(scaleX, scaleY)
        : Math.min(scaleX, scaleY);
    scaleX = uniform;
    scaleY = uniform;
  }

  const renderedWidth = visibleWidth * scaleX;
  const renderedHeight = visibleHeight * scaleY;
  const offsetX = (frameWidth - renderedWidth) / 2;
  const offsetY = (frameHeight - renderedHeight) / 2;
  const mask = input.mask ?? {
    shape: "rect" as const,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
  const displayWidth = frameWidth * mask.width;
  const displayHeight = frameHeight * mask.height;
  const displayRadius =
    mask.shape === "rounded_rect"
      ? Math.min(displayWidth, displayHeight) * (mask.radius ?? 0.1)
      : 0;

  return {
    cropX,
    cropY,
    sourceWidth: visibleWidth,
    sourceHeight: visibleHeight,
    scaleX,
    scaleY,
    offsetX,
    offsetY,
    clip: {
      shape: mask.shape,
      left: (-frameWidth / 2 + frameWidth * mask.x) / scaleX,
      top: (-frameHeight / 2 + frameHeight * mask.y) / scaleY,
      width: displayWidth / scaleX,
      height: displayHeight / scaleY,
      radiusX: displayRadius / scaleX,
      radiusY: displayRadius / scaleY,
    },
  };
}

function positive(value: number) {
  return Math.max(0.001, Number.isFinite(value) ? value : 0.001);
}
