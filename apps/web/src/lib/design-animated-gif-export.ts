import type { DesignObject, LoomicSceneV1 } from "@loomic/shared";
import { GIFEncoder } from "gifenc";
import { buildStableGifPalette, GIF_PALETTE_SAMPLE_PIXELS, indexStableGifFrame } from "./design-gif-palette";

import { DesignBrowserExportError } from "./design-browser-export";
import { evaluateDesignAnimationTransform, getVisibleAnimatedObjects } from "./design-animation-evaluation";

export const DESIGN_GIF_MAX_EDGE = 1_024;
export const DESIGN_GIF_TARGET_FPS = 12;
export const DESIGN_GIF_MAX_FRAMES = 60;
export const DESIGN_GIF_MAX_DURATION_MS = 10_000;

type DesignObjectAnimation = {
  type: "float" | "scale";
  durationMs: number;
  amount: number;
};

type AnimatedDesignObject = DesignObject & {
  animation?: DesignObjectAnimation | null;
};

export type AnimatedGifPlan = {
  width: number;
  height: number;
  frameCount: number;
  frameDelayMs: number;
  durationMs: number;
};

export type AnimatedGifExportPort = {
  waitForFonts: () => Promise<void>;
  waitForImages: () => Promise<{ missingAssetObjectIds: string[] }>;
  renderFrame: (
    scene: LoomicSceneV1,
    options: { width: number; height: number; timeMs: number },
  ) => Promise<ImageData>;
};

export type AnimatedGifExportResult = {
  status: "downloaded";
  filename: string;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
};

/**
 * Evaluates one animation from its durable pose. Scale uses a centred
 * 1 -> 1 + amount/100 -> 1 pulse; float uses a full +/- amount sine wave.
 */
export function evaluateDesignObjectAnimation(
  object: DesignObject,
  timeMs: number,
): DesignObject {
  const original = structuredClone(object) as AnimatedDesignObject;
  const animation = original.animation;
  if (!animation) return original;
  const transform = evaluateDesignAnimationTransform(animation, timeMs);
  if (animation.type === "float") {
    original.y = object.y + transform.translateY;
    return original;
  }
  const scale = transform.scale;
  const width = object.width * scale;
  const height = object.height * scale;
  original.x = object.x - (width - object.width) / 2;
  original.y = object.y - (height - object.height) / 2;
  original.width = width;
  original.height = height;
  return original;
}

/** Creates a new frame scene and never mutates the input or its objects. */
export function buildAnimatedDesignSceneFrame(
  scene: LoomicSceneV1,
  timeMs: number,
): LoomicSceneV1 {
  return {
    ...structuredClone(scene),
    objects: scene.objects.map((object) =>
      evaluateDesignObjectAnimation(object, timeMs),
    ),
  };
}

export function getAnimatedGifPlan(scene: LoomicSceneV1): AnimatedGifPlan {
  if (
    !Number.isFinite(scene.canvas.width) ||
    !Number.isFinite(scene.canvas.height) ||
    scene.canvas.width < 1 ||
    scene.canvas.height < 1
  ) {
    throw new DesignBrowserExportError(
      "invalid_dimensions",
      "设计逻辑尺寸无效，无法导出 GIF。",
    );
  }
  const animations = getVisibleAnimatedObjects(scene.objects).flatMap((object) => {
    const animation = (object as AnimatedDesignObject).animation;
    return animation ? [animation] : [];
  });
  if (animations.length === 0) {
    throw new Error("请先为至少一个可见对象设置浮动或缩放动画，再导出 GIF。");
  }
  const durationMs = commonLoopDuration(
    animations.map((animation) => animation.durationMs),
  );
  const frameCount = Math.max(
    2,
    Math.min(
      DESIGN_GIF_MAX_FRAMES,
      Math.round((durationMs / 1_000) * DESIGN_GIF_TARGET_FPS),
    ),
  );
  const scale = Math.min(
    1,
    DESIGN_GIF_MAX_EDGE / Math.max(scene.canvas.width, scene.canvas.height),
  );
  return {
    width: Math.max(1, Math.round(scene.canvas.width * scale)),
    height: Math.max(1, Math.round(scene.canvas.height * scale)),
    frameCount,
    frameDelayMs: Math.max(20, Math.round(durationMs / frameCount)),
    durationMs,
  };
}

export async function exportAnimatedDesignGifInBrowser(
  input: { name: string; scene: LoomicSceneV1 },
  port: AnimatedGifExportPort,
  dependencies: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    clickDownload?: (url: string, filename: string) => void;
    scheduleRevoke?: (callback: () => void) => void;
    yieldToBrowser?: () => Promise<void>;
    createGifBlob?: (bytes: Uint8Array) => Blob;
  } = {},
): Promise<AnimatedGifExportResult> {
  const sourceScene = structuredClone(input.scene);
  const plan = getAnimatedGifPlan(sourceScene);
  try {
    await port.waitForFonts();
  } catch (cause) {
    throw new DesignBrowserExportError(
      "font_load_failed",
      "字体尚未加载完成，无法导出 GIF。",
      [],
      { cause },
    );
  }
  let imageState: { missingAssetObjectIds: string[] };
  try {
    imageState = await port.waitForImages();
  } catch (cause) {
    throw new DesignBrowserExportError(
      "image_load_failed",
      "图片资源加载失败，无法导出 GIF。",
      [],
      { cause },
    );
  }
  if (imageState.missingAssetObjectIds.length > 0) {
    throw new DesignBrowserExportError(
      "missing_resources",
      `缺少 ${imageState.missingAssetObjectIds.length} 个图片资源，无法导出 GIF。`,
      imageState.missingAssetObjectIds,
    );
  }

  const encoder = GIFEncoder();
  try {
    // Two deterministic render passes keep memory bounded to one frame plus
    // the sample buffer rather than retaining up to 60 full RGBA frames.
    const perFrameSamples = Math.max(1, Math.floor(GIF_PALETTE_SAMPLE_PIXELS / plan.frameCount));
    const samples = new Uint8Array(perFrameSamples * plan.frameCount * 4);
    let sampleBytes = 0;
    let hasTransparency = false;
    const render = async (index: number) => {
      const timeMs = (index / plan.frameCount) * plan.durationMs;
      const image = await port.renderFrame(buildAnimatedDesignSceneFrame(sourceScene, timeMs),
        { width: plan.width, height: plan.height, timeMs });
      if (image.width !== plan.width || image.height !== plan.height || image.data.length !== plan.width * plan.height * 4)
        throw new Error("GIF frame dimensions do not match the export plan.");
      return image;
    };
    for (let index = 0; index < plan.frameCount; index += 1) {
      const image = await render(index);
      const pixels = image.width * image.height;
      const stride = Math.max(1, Math.ceil(pixels / perFrameSamples));
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const offset = pixel * 4;
        if (image.data[offset + 3]! <= 127) { hasTransparency = true; continue; }
        if (pixel % stride !== 0) continue;
        samples.set(image.data.subarray(offset, offset + 4), sampleBytes);
        samples[sampleBytes + 3] = 255;
        sampleBytes += 4;
      }
      if ((index + 1) % 4 === 0) await (dependencies.yieldToBrowser?.() ?? yieldToBrowser());
    }
    const { palette, lookup } = buildStableGifPalette(samples.slice(0, sampleBytes));
    for (let index = 0; index < plan.frameCount; index += 1) {
      const image = await render(index);
      const indexed = indexStableGifFrame(image.data, lookup);
      encoder.writeFrame(indexed, plan.width, plan.height, {
        ...(index === 0 ? { palette } : {}),
        delay: frameDelayMs(plan, index),
        repeat: 0,
        transparent: hasTransparency,
        transparentIndex: 0,
        dispose: hasTransparency ? 2 : 1,
      });
      if ((index + 1) % 4 === 0) {
        await (dependencies.yieldToBrowser?.() ?? yieldToBrowser());
      }
    }
    encoder.finish();
  } catch (cause) {
    throw new DesignBrowserExportError(
      "render_failed",
      "GIF 逐帧渲染失败，无法导出。",
      [],
      { cause },
    );
  }

  const filename = `${sanitizeFilename(input.name)}.gif`;
  const encoded = encoder.bytes();
  const blob = dependencies.createGifBlob
    ? dependencies.createGifBlob(encoded)
    : gifBlob(encoded);
  const createObjectURL =
    dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL =
    dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const clickDownload = dependencies.clickDownload ?? defaultClickDownload;
  const scheduleRevoke =
    dependencies.scheduleRevoke ??
    ((callback: () => void) => setTimeout(callback, 30_000));
  const url = createObjectURL(blob);
  try {
    clickDownload(url, filename);
  } finally {
    scheduleRevoke(() => revokeObjectURL(url));
  }
  return {
    status: "downloaded",
    filename,
    width: plan.width,
    height: plan.height,
    frameCount: plan.frameCount,
    durationMs: plan.durationMs,
  };
}

function commonLoopDuration(durations: number[]) {
  let duration = Math.max(500, Math.round(durations[0] ?? 500));
  for (const nextDuration of durations.slice(1)) {
    const next = Math.max(500, Math.round(nextDuration));
    const divisor = greatestCommonDivisor(duration, next);
    const candidate = (duration / divisor) * next;
    if (!Number.isSafeInteger(candidate) || candidate > DESIGN_GIF_MAX_DURATION_MS) {
      return DESIGN_GIF_MAX_DURATION_MS;
    }
    duration = candidate;
  }
  return Math.min(DESIGN_GIF_MAX_DURATION_MS, duration);
}

function frameDelayMs(plan: AnimatedGifPlan, index: number) {
  const elapsedCentiseconds = Math.round(
    ((index + 1) * plan.durationMs) / plan.frameCount / 10,
  );
  const previousCentiseconds = Math.round(
    (index * plan.durationMs) / plan.frameCount / 10,
  );
  return Math.max(20, (elapsedCentiseconds - previousCentiseconds) * 10);
}

function greatestCommonDivisor(left: number, right: number) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function gifBlob(encoded: Uint8Array) {
  const encodedBuffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(encodedBuffer).set(encoded);
  return new Blob([encodedBuffer], { type: "image/gif" });
}

function sanitizeFilename(value: string): string {
  const sanitized = [...value.trim().replace(/[<>:"/\\|?*]/g, "-")]
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("");
  return sanitized || "loomic-design";
}

function defaultClickDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}
