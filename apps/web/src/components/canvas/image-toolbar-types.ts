export type ImageToolbarActionId =
  | "remove-background"
  | "split-layers"
  | "replace-text"
  | "edit-region"
  | "regenerate"
  | "panorama"
  | "crop"
  | "upscale"
  | "erase"
  | "outpaint"
  | "add-to-chat"
  | "details"
  | "download";

export type SelectedCanvasImage = {
  id: string;
  fileId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  dataUrl?: string;
  storageUrl?: string;
  assetId?: string;
  mimeType: string;
  created?: number;
  title?: string;
  prompt?: string;
  model?: string;
  sourceJobId?: string;
  originalWidth?: number;
  originalHeight?: number;
};

export type CanvasImageChatCommand = {
  id: string;
  mode: "attach" | "run-agent";
  image: {
    assetId: string;
    url: string;
    previewUrl?: string;
    mimeType: string;
    name?: string;
  };
  prompt?: string;
};
