"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Aperture, Crop, Download, Ellipsis, Focus, Layers3, ScanSearch,
  Info, Languages, MessageCirclePlus, RefreshCw,
  Settings2, Sparkles, WandSparkles,
} from "lucide-react";
import { useImageToolbarPreferences, IMAGE_TOOLBAR_ACTIONS } from "../../hooks/use-image-toolbar-preferences";
import { ImageActionDialog } from "./image-action-dialog";
import { ImageDetailsDialog } from "./image-details-dialog";
import { ImageToolbarCustomizeDialog } from "./image-toolbar-customize-dialog";
import { ImageTextReplacementPanel } from "./image-text-replacement-panel";
import type { ImageToolbarActionId, SelectedCanvasImage } from "./image-toolbar-types";

const icons: Record<ImageToolbarActionId, typeof Sparkles> = {
  "remove-background": WandSparkles, "replace-text": Languages, "edit-region": Focus,
  "region-matting": ScanSearch,
  "split-layers": Layers3,
  regenerate: RefreshCw, panorama: Aperture, crop: Crop,
  upscale: Sparkles, erase: WandSparkles,
  "add-to-chat": MessageCirclePlus, details: Info, download: Download,
};

export function ImageSelectionToolbar({ image, screenBounds, onDownload, onCrop, onRegenerate, onUpscale, onRemoveBackground, onRegionMatting, onSplitLayers, onErase, onChatCommand, onRecognizeText, onApplyTextReplacement }: {
  image: SelectedCanvasImage;
  screenBounds: { x: number; y: number; width: number; height: number; viewportWidth?: number };
  onDownload: () => void;
  onCrop: () => void;
  onRegenerate: (prompt: string) => void;
  onUpscale: (prompt: string) => void;
  onRemoveBackground: () => void;
  onRegionMatting: () => void;
  onSplitLayers: () => void;
  onErase: () => void;
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
  const toolbarWidth = Math.min(canvasWidth - 24, Math.max(260, pinned.length * (preferences.showLabels ? 104 : 42) + 50));
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
    if (id === "region-matting") return onRegionMatting();
    if (id === "split-layers") return onSplitLayers();
    if (id === "erase") return onErase();
    if (id === "regenerate" || id === "upscale") return setActiveAction(id);
  };

  const button = (item: (typeof available)[number], compact = false) => {
    const Icon = icons[item.id];
    return <button key={item.id} type="button" onClick={() => invoke(item.id)} className={compact ? "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted" : "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm hover:bg-muted"} title={item.label}><Icon className="size-4" />{(preferences.showLabels || compact) && <span>{item.label}</span>}</button>;
  };

  const dialogOpen = detailsOpen || customizeOpen || activeAction !== null || replaceTextOpen;

  return createPortal(<>
    {!dialogOpen && <div className="fixed z-[9] flex items-center rounded-xl border border-border bg-background/95 p-1 shadow-xl backdrop-blur" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
        {pinned.map((item) => button(item))}
        <div className="relative">
          <button type="button" aria-label="更多图片工具" onClick={() => setMenuOpen((v) => !v)} className="flex size-9 items-center justify-center rounded-lg hover:bg-muted"><Ellipsis className="size-5" /></button>
          {menuOpen && <div className="absolute right-0 top-11 z-[101] w-48 rounded-xl border border-border bg-background p-1.5 shadow-xl">
            {more.map((item) => button(item, true))}
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
    <ImageActionDialog action={activeAction} image={image} screenBounds={screenBounds} onOpenChange={(open) => { if (!open) setActiveAction(null); }} onConfirm={(prompt) => {
      const action = activeAction;
      setActiveAction(null);
      if (action === "regenerate") onRegenerate(prompt);
      else if (action === "upscale") onUpscale(prompt);
    }} />
  </>, document.body);
}
