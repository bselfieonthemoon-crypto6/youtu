"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Aperture, Crop, Download, Ellipsis, Focus, Layers3,
  Info, Languages, MessageCirclePlus, RefreshCw,
  Settings2, Sparkles, WandSparkles, Expand,
} from "lucide-react";
import { useImageToolbarPreferences, IMAGE_TOOLBAR_ACTIONS } from "../../hooks/use-image-toolbar-preferences";
import { ImageActionDialog, type SemanticLayerSplitRequest } from "./image-action-dialog";
import { ImageDetailsDialog } from "./image-details-dialog";
import { ImageToolbarCustomizeDialog } from "./image-toolbar-customize-dialog";
import { ImageTextReplacementPanel } from "./image-text-replacement-panel";
import { LayerBackendOption } from "./layer-backend-option";
import type { ImageToolbarActionId, SelectedCanvasImage } from "./image-toolbar-types";

const icons: Record<ImageToolbarActionId, typeof Sparkles> = {
  "remove-background": WandSparkles, "replace-text": Languages, "edit-region": Focus,
  "split-layers": Layers3,
  regenerate: RefreshCw, panorama: Aperture, crop: Crop,
  upscale: Sparkles, erase: WandSparkles,
  outpaint: Expand,
  "add-to-chat": MessageCirclePlus, details: Info, download: Download,
};

export function ImageSelectionToolbar({ image, screenBounds, onDownload, onCrop, onRegenerate, onUpscale, onRemoveBackground, onSplitLayers, onSplitLayersDedicated, onSplitLayersQwen, onSplitLayersBox, accessToken, onErase, onOutpaint, onChatCommand, onRecognizeText, onApplyTextReplacement, onAddToBoard, addToBoardLabel = "添加到画板", boardOnly = false }: {
  image: SelectedCanvasImage;
  screenBounds: { x: number; y: number; width: number; height: number; viewportWidth?: number };
  onDownload: () => void;
  onAddToBoard?: () => void;
  addToBoardLabel?: string;
  boardOnly?: boolean;
  onCrop: () => void;
  onRegenerate: (prompt: string) => void;
  onUpscale: (prompt: string, quality?: "hd" | "ultra") => void;
  onRemoveBackground: () => void;
  onSplitLayers: () => void;
  onSplitLayersDedicated?: (request: SemanticLayerSplitRequest) => void;
  onSplitLayersQwen?: () => void;
  /**
   * Box-selection split: the user frames one element and the model extracts it
   * together with a repaired background. When provided, the split button opens a
   * short menu instead of going straight to the named-layer dialog.
   */
  onSplitLayersBox?: () => void;
  accessToken?: string;
  onErase: () => void;
  onOutpaint?: () => void;
  onChatCommand: (prompt?: string) => void;
  onRecognizeText: () => Promise<string[]>;
  onApplyTextReplacement: (replacements: Array<{ original: string; replacement: string }>) => Promise<void>;
}) {
  const { preferences, setPreferences, reset } = useImageToolbarPreferences();
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [activeAction, setActiveAction] = useState<ImageToolbarActionId | null>(null);
  const [replaceTextOpen, setReplaceTextOpen] = useState(false);
  const available = useMemo(() => IMAGE_TOOLBAR_ACTIONS.filter((item) => item.available), []);
  const pinned = preferences.pinned.map((id) => available.find((item) => item.id === id)).filter(Boolean) as typeof available;
  const more = available.filter((item) => !preferences.pinned.includes(item.id));
  const windowWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const windowHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const canvasWidth = Math.min(windowWidth, screenBounds.viewportWidth ?? windowWidth);
  const toolbarWidth = Math.min(canvasWidth - 24, Math.max(260, pinned.length * (preferences.showLabels ? 104 : 42) + 50 + (onAddToBoard ? 120 : 0)));
  const left = Math.max(12, Math.min(canvasWidth - toolbarWidth - 12, screenBounds.x + screenBounds.width / 2 - toolbarWidth / 2));
  const preferredTop = screenBounds.y >= 64 ? screenBounds.y - 52 : screenBounds.y + screenBounds.height + 12;
  const top = Math.max(12, Math.min(windowHeight - 48, preferredTop));

  const invoke = (id: ImageToolbarActionId) => {
    setMenuOpen(false);
    if (id === "download") return onDownload();
    if (id === "crop") return onCrop();
    if (id === "details") return setDetailsOpen(true);
    if (id === "add-to-chat") return onChatCommand();
    if (id === "replace-text") return setReplaceTextOpen(true);
    if (id === "remove-background") return onRemoveBackground();
    if (id === "split-layers") {
      // Box selection is the everyday path, so it is the plain click. The paid
      // named-layer split stays one level down in the overflow menu instead of
      // being the default action of a button that looks free.
      if (onSplitLayersBox) return onSplitLayersBox();
      return onSplitLayersDedicated ? setActiveAction(id) : onSplitLayers();
    }
    if (id === "erase") return onErase();
    if (id === "outpaint") return onOutpaint?.();
    if (id === "regenerate" || id === "upscale") return setActiveAction(id);
  };

  const button = (item: (typeof available)[number], compact = false) => {
    const Icon = icons[item.id];
    return <button key={item.id} type="button" onClick={() => invoke(item.id)} className={compact ? "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted" : "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm hover:bg-muted"} title={item.label}><Icon className="size-4" />{(preferences.showLabels || compact) && <span>{item.label}</span>}</button>;
  };

  const dialogOpen = detailsOpen || customizeOpen || activeAction !== null || replaceTextOpen;

  if (boardOnly) {
    const compactLeft = Math.max(12, Math.min(canvasWidth - 136, screenBounds.x + screenBounds.width / 2 - 60));
    return createPortal(<div data-testid="image-board-only-toolbar" className="fixed z-[9] flex items-center rounded-xl border border-border bg-background/95 p-1 shadow-xl" style={{ left: compactLeft, top }} onPointerDown={e => e.stopPropagation()}>
      {onAddToBoard && <button type="button" onClick={onAddToBoard} className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted"><Layers3 className="size-4" />{addToBoardLabel}</button>}
    </div>, document.body);
  }

  return createPortal(<>
    {!dialogOpen && <div className="fixed z-[9] flex items-center rounded-xl border border-border bg-background/95 p-1 shadow-xl backdrop-blur" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
        {onAddToBoard && <button type="button" onClick={onAddToBoard} title={addToBoardLabel} className="flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-sm hover:bg-muted"><Layers3 className="size-4" />{addToBoardLabel}</button>}
        {pinned.map((item) => button(item))}
        <div className="relative">
          <button type="button" aria-label="更多图片工具" onClick={() => setMenuOpen((v) => !v)} className="flex size-9 items-center justify-center rounded-lg hover:bg-muted"><Ellipsis className="size-5" /></button>
          {menuOpen && <div className="absolute right-0 top-11 z-[101] max-h-[60vh] w-64 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-xl">
            {more.map((item) => button(item, true))}
            {onSplitLayersBox && <button type="button" onClick={() => { setMenuOpen(false); onSplitLayersBox(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"><Focus className="size-4" />框选剥离元素</button>}
            {onSplitLayersDedicated && <button type="button" onClick={() => { setMenuOpen(false); setActiveAction("split-layers"); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"><Layers3 className="size-4" />按名称拆分（付费）</button>}
            {onSplitLayersDedicated && <button type="button" onClick={() => { setMenuOpen(false); onSplitLayers(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"><Layers3 className="size-4" />本地快速拆分</button>}
            {accessToken && onSplitLayersQwen && <LayerBackendOption accessToken={accessToken} onRun={() => { setMenuOpen(false); onSplitLayersQwen(); }} />}
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => { setMenuOpen(false); setCustomizeOpen(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"><Settings2 className="size-4" />自定义工具栏</button>
          </div>}
        </div>
      </div>}
    <ImageDetailsDialog image={image} open={detailsOpen} onOpenChange={setDetailsOpen} />
    <ImageToolbarCustomizeDialog open={customizeOpen} value={preferences} onOpenChange={setCustomizeOpen} onSave={setPreferences} onReset={reset} />
    {replaceTextOpen && <ImageTextReplacementPanel image={image} screenBounds={screenBounds} onRecognize={onRecognizeText} onApply={(replacements) => {
      // The durable canvas placeholder owns generation progress. Close the
      // editor immediately so it cannot leave a duplicate loading dialog over it.
      setReplaceTextOpen(false);
      return onApplyTextReplacement(replacements);
    }} onCancel={() => setReplaceTextOpen(false)} />}
    <ImageActionDialog action={activeAction} image={image} screenBounds={screenBounds} {...(accessToken !== undefined ? { accessToken } : {})} onOpenChange={(open) => { if (!open) setActiveAction(null); }} onConfirm={(prompt, quality, layerSplit) => {
      const action = activeAction;
      setActiveAction(null);
      if (action === "regenerate") onRegenerate(prompt);
      else if (action === "upscale") onUpscale(prompt, quality);
      else if (action === "split-layers" && layerSplit) onSplitLayersDedicated?.(layerSplit);
    }} />
  </>, document.body);
}
