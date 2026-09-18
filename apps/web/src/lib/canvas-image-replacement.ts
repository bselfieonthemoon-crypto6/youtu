export type ImageReplacementStatus = "generating" | "error";

export type ImageReplacementData = {
  type: "image-replacement";
  status: ImageReplacementStatus;
  operation: "replace-text" | "regenerate" | "upscale" | "remove-background" | "region-matting" | "split-layers" | "erase-transparent" | "smart-erase" | "local-repaint" | "outpaint";
  jobId?: string;
  errorMessage?: string;
};

function generateId(): string {
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 20);
}

export function createImageReplacementElement(api: {
  getSceneElements: () => readonly any[];
  updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
}, placement: { x: number; y: number; width: number; height: number }, operation: ImageReplacementData["operation"] = "replace-text"): string {
  const id = generateId();
  const element = {
    type: "rectangle",
    id,
    ...placement,
    angle: 0,
    strokeColor: "#D1D5DB",
    backgroundColor: "#F3F4F6",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    roundness: { type: 3 },
    boundElements: null,
    frameId: null,
    index: null,
    seed: Math.floor(Math.random() * 2_000_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: {
      type: "image-replacement",
      status: "generating",
      operation,
    } satisfies ImageReplacementData,
  };
  api.updateScene({
    elements: [...api.getSceneElements(), element],
    captureUpdate: "IMMEDIATELY",
  });
  return id;
}

export function isImageReplacementElement(element: any): element is { customData: ImageReplacementData } & Record<string, unknown> {
  return element?.customData?.type === "image-replacement";
}

export function updateImageReplacementElement(api: {
  getSceneElements: () => readonly any[];
  updateScene: (scene: { elements: any[]; captureUpdate?: string }) => void;
}, elementId: string, updates: Partial<ImageReplacementData> & { isDeleted?: boolean }): void {
  const elements = api.getSceneElements().map((element: any) => {
    if (element.id !== elementId || element.isDeleted || !isImageReplacementElement(element)) return element;
    const { isDeleted, ...customUpdates } = updates;
    return {
      ...element,
      ...(isDeleted !== undefined ? { isDeleted } : {}),
      customData: { ...element.customData, ...customUpdates },
      version: Number(element.version ?? 1) + 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
      updated: Date.now(),
    };
  });
  api.updateScene({ elements, captureUpdate: "IMMEDIATELY" });
}
