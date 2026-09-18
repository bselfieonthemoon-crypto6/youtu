export const DESIGN_BROWSER_EXPORT_MAX_PIXELS = 32_000_000;

export type DesignStaticBrowserExportFormat =
  | "png"
  | "transparent-png"
  | "jpeg";
export type DesignBrowserExportFormat = DesignStaticBrowserExportFormat | "gif";

export type DesignBrowserExportPort = {
  waitForFonts: () => Promise<void>;
  waitForImages: () => Promise<{ missingAssetObjectIds: string[] }>;
  renderToBlob: (options: {
    logicalWidth: number;
    logicalHeight: number;
    mimeType: "image/png" | "image/jpeg";
    multiplier: 1 | 2;
    transparent: boolean;
  }) => Promise<Blob>;
};

export type DesignBrowserExportResult =
  | { status: "downloaded"; filename: string; renderedPixels: number }
  | {
      status: "background_required";
      reason: "pixel_budget_exceeded";
      renderedPixels: number;
      maxPixels: number;
    };

export class DesignBrowserExportError extends Error {
  constructor(
    readonly code:
      | "invalid_dimensions"
      | "font_load_failed"
      | "image_load_failed"
      | "missing_resources"
      | "render_failed",
    message: string,
    readonly missingAssetObjectIds: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesignBrowserExportError";
  }
}

export async function exportDesignInBrowser(
  input: {
    name: string;
    width: number;
    height: number;
    multiplier: 1 | 2;
    format: DesignStaticBrowserExportFormat;
  },
  port: DesignBrowserExportPort,
  dependencies: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
    clickDownload?: (url: string, filename: string) => void;
    scheduleRevoke?: (callback: () => void) => void;
  } = {},
): Promise<DesignBrowserExportResult> {
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 1 ||
    input.height < 1
  ) {
    throw new DesignBrowserExportError(
      "invalid_dimensions",
      "设计逻辑尺寸无效，无法导出。",
    );
  }
  const renderedPixels = input.width * input.height * input.multiplier ** 2;
  if (
    !Number.isSafeInteger(renderedPixels) ||
    renderedPixels > DESIGN_BROWSER_EXPORT_MAX_PIXELS
  ) {
    return {
      status: "background_required",
      reason: "pixel_budget_exceeded",
      renderedPixels,
      maxPixels: DESIGN_BROWSER_EXPORT_MAX_PIXELS,
    };
  }

  try {
    await port.waitForFonts();
  } catch (cause) {
    throw new DesignBrowserExportError(
      "font_load_failed",
      "字体尚未加载完成，无法导出。",
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
      "图片资源加载失败，无法导出。",
      [],
      { cause },
    );
  }
  if (imageState.missingAssetObjectIds.length > 0) {
    throw new DesignBrowserExportError(
      "missing_resources",
      `缺少 ${imageState.missingAssetObjectIds.length} 个图片资源，无法导出。`,
      imageState.missingAssetObjectIds,
    );
  }

  const transparent = input.format === "transparent-png";
  const mimeType = input.format === "jpeg" ? "image/jpeg" : "image/png";
  let blob: Blob;
  try {
    blob = await port.renderToBlob({
      logicalWidth: input.width,
      logicalHeight: input.height,
      mimeType,
      multiplier: input.multiplier,
      transparent,
    });
  } catch (cause) {
    throw new DesignBrowserExportError(
      "render_failed",
      "设计渲染失败，无法导出。",
      [],
      { cause },
    );
  }
  const extension = input.format === "jpeg" ? "jpg" : "png";
  const filename = `${sanitizeFilename(input.name)}@${input.multiplier}x.${extension}`;
  const createObjectURL =
    dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL =
    dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const clickDownload = dependencies.clickDownload ?? defaultClickDownload;
  const scheduleRevoke = dependencies.scheduleRevoke ?? queueMicrotask;
  const url = createObjectURL(blob);
  try {
    clickDownload(url, filename);
  } finally {
    scheduleRevoke(() => revokeObjectURL(url));
  }
  return { status: "downloaded", filename, renderedPixels };
}

function defaultClickDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

function sanitizeFilename(value: string): string {
  const sanitized = [...value.trim().replace(/[<>:"/\\|?*]/g, "-")]
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("");
  return sanitized || "loomic-design";
}
