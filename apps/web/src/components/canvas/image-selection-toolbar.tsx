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

export function ImageSelectionToolbar({ image, screenBounds, onDownload, onCrop, onRegenerate, onUpscale, onRemoveBackground, onSplitLayers, onSplitLayersDedicated, onSplitLayersQwen, onSplitLayersBox, onSplitLayersAuto, accessToken, onErase, onOutpaint, onChatCommand, onRecognizeText, onApplyTextReplacement, onAddToBoard, addToBoardLabel = "添加到画板", boardOnly = false }: {  image: SelectedCanvasImage;
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
  /**
   * Automatic element listing for the named generative split: one paid vision
   * call proposes the names, which then prefill the dialog for the user to edit.
   * Returning an empty list leaves the dialog on its manual path.
   */
  onSplitLayersAuto?: () => Promise<string[] | null>;
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
  const [suggestedLayerNames, setSuggestedLayerNames] = useState<string[]>([]);
  const [autoSplitBusy, setAutoSplitBusy] = useState(false);
  const [autoSplitError, setAutoSplitError] = useState<string | null>(null);
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const startAutomaticSplit = async () => {
    if (!onSplitLayersAuto || autoSplitBusy) return;
    setAutoSplitBusy(true);
    setAutoSplitError(null);
    try {
      const names = await onSplitLayersAuto();
      if (!names?.length) {
        setAutoSplitError("没能从这张图里识别出独立元素，请改用框选剥离或自己填写元素名称。");
        return;
      }
      setSuggestedLayerNames(names);
      setSplitMenuOpen(false);
      setActiveAction("split-layers");
    } catch (error) {
      setAutoSplitError(error instanceof Error ? error.message : "自动识别元素失败，请重试或改用框选剥离。");
    } finally {
      setAutoSplitBusy(false);
    }
  };
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
      // One entry, several modes. The panel states what each mode costs and what it
      // produces, instead of scattering four look-alike entries through the menu.
      // `onSplitLayers` is required, so the panel always has at least one mode.
      setSplitMenuOpen(true);
      return;
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
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => { setMenuOpen(false); setCustomizeOpen(true); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"><Settings2 className="size-4" />自定义工具栏</button>
          </div>}
        </div>
      </div>}

    {/* 图层拆分 modes. One entry point: every way to split a flat image is described
        here with its cost and output, so the toolbar does not grow one button per
        implementation detail. */}
    {splitMenuOpen && <div data-testid="layer-split-menu" role="dialog" aria-label="图层拆分方式"
      className="fixed z-[101] w-80 rounded-2xl border border-border bg-background p-3 shadow-xl"
      style={{ left: Math.max(12, Math.min(canvasWidth - 332, left)), top: top + 48 }}
      onPointerDown={(event) => event.stopPropagation()}>
      <h3 className="text-sm font-semibold">图层拆分</h3>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">把一张扁平图变成「修补后的底图 + 可独立摆放的透明元素」。选一种方式：</p>
      <div className="mt-2 grid gap-1">
        {onSplitLayersBox && <SplitMode icon={<Focus className="size-4" />} title="框选剥离"
          detail="拖框圈住一个元素，只提取它并修补底图" cost="2 次图片调用"
          onClick={() => { setSplitMenuOpen(false); onSplitLayersBox(); }} />}
        {onSplitLayersAuto && <SplitMode icon={<Sparkles className="size-4" />}
          title={autoSplitBusy ? "正在识别元素…" : "全部剥离"}
          detail="先识别画面里的元素，再逐个提取并修补底图"
          cost={autoSplitBusy ? undefined : "1 次识别 + N+1 次图片调用"} disabled={autoSplitBusy}
          onClick={() => void startAutomaticSplit()} />}
        <div className="my-0.5 h-px bg-border" />
        {onSplitLayersDedicated && <SplitMode icon={<Layers3 className="size-4" />} title="按名称拆分"
          detail="自己填写 2–4 个元素名，省掉识别那一次"
          cost="N+1 次图片调用"
          onClick={() => { setSplitMenuOpen(false); setSuggestedLayerNames([]); setActiveAction("split-layers"); }} />}
        {onSplitLayers && <SplitMode icon={<Layers3 className="size-4" />} title="本地快速拆分"
          detail="本地模型按前景连通块粗分，不修补底图" cost="免费 · 不出网"
          onClick={() => { setSplitMenuOpen(false); onSplitLayers(); }} />}
        {accessToken && onSplitLayersQwen && <LayerBackendOption accessToken={accessToken}
          onRun={() => { setSplitMenuOpen(false); onSplitLayersQwen(); }} />}
      </div>
      {autoSplitError && <p role="alert" className="mt-2 text-[11px] text-destructive">{autoSplitError}</p>}
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={() => setSplitMenuOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">取消</button>
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
    <ImageActionDialog action={activeAction} image={image} screenBounds={screenBounds} {...(accessToken !== undefined ? { accessToken } : {})} initialLayerNames={suggestedLayerNames} onOpenChange={(open) => { if (!open) setActiveAction(null); }} onConfirm={(prompt, quality, layerSplit) => {
      const action = activeAction;
      setActiveAction(null);
      if (action === "regenerate") onRegenerate(prompt);
      else if (action === "upscale") onUpscale(prompt, quality);
      else if (action === "split-layers" && layerSplit) onSplitLayersDedicated?.(layerSplit);
    }} />
  </>, document.body);
}

/** One way to split an image, with its honest cost and output in the same row. */
function SplitMode({ icon, title, detail, cost, disabled = false, onClick }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  cost?: string | undefined;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted disabled:opacity-60">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{title}</span>
          {cost && <span className="text-[10px] text-muted-foreground">{cost}</span>}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
