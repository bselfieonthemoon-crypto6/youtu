"use client";

import { type ButtonHTMLAttributes, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Check, Download, Info, Layers3, LayoutTemplate, Loader2, Redo2, Save, Type, Undo2 } from "lucide-react";
import { createPortal } from "react-dom";
import type { DesignEditorOverlayProps } from "./design-editor-overlay";
import { DesignEditorOverlay } from "./design-editor-overlay";
import { DesignLayersPanel } from "./design-layers-panel";
import { DesignPropertiesPanel } from "./design-properties-panel";
import { FabricDesignSurface } from "./fabric-design-surface";
import { DesignNameButton } from "./design-name-button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";

function ToolbarButton({ label, active = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button {...props} type="button" title={label} aria-label={label}
    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-30 ${active ? "bg-foreground/[0.08] text-foreground" : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"}`}>
    {children}
  </button>;
}

/** Inline shell. Authoritative document/history/jobs remain owned by the session. */
export function DesignInlineEditor(props: DesignEditorOverlayProps) {
  const [bounds, setBounds] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    clipLeft: number;
    clipTop: number;
    clipWidth: number;
    clipHeight: number;
    panelRight: number;
    panelWidth: number;
  } | null>(null);
  const [resources, setResources] = useState(false);
  const [layers, setLayers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [rotatedBoard, setRotatedBoard] = useState(false);
  const currentProps = useRef(props);
  currentProps.current = props;

  useEffect(() => {
    if (legacy) return;
    let frame = 0;
    const update = () => {
      const root = props.backgroundRoot;
      const preview = Array.from(
        root?.querySelectorAll<HTMLElement>(
          "[data-design-id][data-testid='design-node-preview']",
        ) ?? [],
      ).find((e) => e.dataset.designId === props.designId);
      if (preview) {
        const angle = /^rotate\(([-\d.]+)deg\)$/.exec(
          preview.style.transform,
        )?.[1];
        setRotatedBoard(Boolean(angle && Number(angle) !== 0));
        const rect = preview.getBoundingClientRect();
        const displayScale = Math.max(rect.width, rect.height) / Math.max(props.width, props.height);
        const clip = preview.parentElement?.getBoundingClientRect() ?? rect;
        const canvasBounds = root?.querySelector<HTMLElement>('[data-testid="canvas-editor"]')?.getBoundingClientRect()
          ?? root?.getBoundingClientRect() ?? clip;
        const next = {
          left: rect.left,
          top: rect.top,
          width: props.width * displayScale,
          height: props.height * displayScale,
          clipLeft: canvasBounds.left,
          clipTop: canvasBounds.top,
          clipWidth: canvasBounds.width,
          clipHeight: canvasBounds.height,
          panelRight: Math.max(0, window.innerWidth - canvasBounds.right),
          panelWidth: Math.min(288, Math.max(0, canvasBounds.width)),
        };
        setBounds((old) =>
          old &&
          Object.keys(next).every(
            (key) =>
              old[key as keyof typeof next] === next[key as keyof typeof next],
          )
            ? old
            : next,
        );
        setMissing(false);
      } else setMissing(true);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [legacy, props.backgroundRoot, props.designId, props.width, props.height]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (currentProps.current.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  async function save(after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await (after === props.onClose && props.onFinish ? props.onFinish() : props.onSave());
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，修改仍保留");
    } finally {
      setBusy(false);
    }
  }

  function handleKeys(e: KeyboardEvent<HTMLElement>) {
    e.stopPropagation();
    if (
      e.target instanceof HTMLElement &&
      (e.target.isContentEditable || e.target.matches("input,textarea,select"))
    )
      return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) props.onRedo?.();
      else props.onUndo?.();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      if (props.onEscapeSubInteraction?.()) return;
      props.dirty ? setClosing(true) : void save(props.onClose);
    }
  }

  const saveStatus = props.saving || busy ? "保存中…" : props.dirty ? "未保存" : (props.statusMessage ?? "已保存");
  if (legacy)
    return <DesignEditorOverlay {...props} />;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-30"
      data-testid="design-inline-editor"
    >
      <section
        className="pointer-events-auto fixed left-1/2 top-16 z-30 max-w-[90vw] -translate-x-1/2 rounded-xl border border-border bg-card/75 p-1 shadow-card backdrop-blur-lg"
        style={
          bounds
            ? {
                left: bounds.clipLeft + bounds.clipWidth / 2,
                maxWidth: Math.max(280, bounds.clipWidth - 32),
              }
            : undefined
        }
        onKeyDown={handleKeys}
      >
        <div role="toolbar" aria-label="画板工具栏" className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap">
          <div className="flex shrink-0 items-center gap-2 px-2" title={`正在编辑：${props.name} · ${saveStatus}`}>
            <span className={`size-1.5 shrink-0 rounded-full ${props.dirty ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden="true" />
            <span className="max-w-24 truncate text-xs text-foreground/70">{props.onRename ? <DesignNameButton name={props.name} onRename={props.onRename} /> : props.name}</span>
          </div>
          <div className="mx-0.5 h-6 w-px shrink-0 bg-border" />
          <ToolbarButton label="资源" active={resources} aria-pressed={resources} onClick={() => setResources((v) => !v)}><LayoutTemplate className="size-4" /></ToolbarButton>
          <ToolbarButton label="图层 / 属性" active={layers} aria-pressed={layers} onClick={() => setLayers((v) => !v)}><Layers3 className="size-4" /></ToolbarButton>
          <ToolbarButton label="添加文字" onClick={() => props.onAddObject?.("text")}><Type className="size-4" /></ToolbarButton>
          <div className="mx-0.5 h-6 w-px shrink-0 bg-border" />
          <ToolbarButton label="撤销" disabled={!props.canUndo} onClick={props.onUndo}><Undo2 className="size-4" /></ToolbarButton>
          <ToolbarButton label="重做" disabled={!props.canRedo} onClick={props.onRedo}><Redo2 className="size-4" /></ToolbarButton>
          <div className="mx-0.5 h-6 w-px shrink-0 bg-border" />
          <ToolbarButton label="保存" disabled={busy || props.saving} onClick={() => void save()}>{busy || props.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}</ToolbarButton>
          <ToolbarButton label="画板详情" disabled={busy || downloading} onClick={() => void save(() => setLegacy(true))}><Info className="size-4" /></ToolbarButton>
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="下载" title="下载" disabled={busy || downloading || !props.onExport} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/60 hover:bg-foreground/[0.04] disabled:opacity-30">
              {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-design-subinteraction="true" onKeyDown={e => e.stopPropagation()}>
              {([['png', 'PNG'], ['transparent-png', '透明 PNG'], ['jpeg', 'JPEG'], ['gif', '动态 GIF']] as const).map(([format, label]) => (
                <DropdownMenuItem key={format} disabled={downloading} onClick={async () => {
                  if (!props.onExport || downloading) return;
                  setDownloading(true); setError(null);
                  try { await props.onExport({ format, multiplier: 1 }); }
                  catch (cause) { setError(cause instanceof Error ? cause.message : "下载失败，请重试。"); }
                  finally { setDownloading(false); }
                }}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolbarButton label="完成" disabled={busy || props.saving} onClick={() => void save(props.onClose)}><Check className="size-4" /></ToolbarButton>
        </div>
        <p className="sr-only" role="status">
          {saveStatus}
        </p>
        {(error || props.saveError) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? props.saveError}
          </p>
        )}
        {missing && (
          <p role="alert">画板预览不在可视区域，请移回画板或切换完整编辑器。</p>
        )}
        {rotatedBoard && (
          <p role="alert">画板节点整体已旋转，暂不支持原位编辑。请将画板节点角度恢复为 0°，或点击“画板详情”继续。</p>
        )}
        {props.conflictRevision != null && (
          <div role="alert">
            远端版本已更新，本地修改已保留。
            <button
              onClick={() =>
                void props.onReloadKeep?.().catch((e) => setError(String(e)))
              }
            >
              保留本地并重载
            </button>
            <button
              onClick={() =>
                void props.onRetrySave?.().catch((e) => setError(String(e)))
              }
            >
              重试保存
            </button>
          </div>
        )}
        {closing && (
          <div role="alertdialog">
            还有未保存修改。
            <button disabled={busy} onClick={() => void save(props.onClose)}>
              保存并退出
            </button>
            <button onClick={() => setClosing(false)}>继续编辑</button>
          </div>
        )}
      </section>
      {resources && (
        <aside className="pointer-events-auto fixed z-20 bottom-24 left-3 top-32 w-72 overflow-auto rounded-2xl border bg-background p-3 shadow-lg">
          {props.resourcePanel}
        </aside>
      )}
      {layers && bounds && props.scene && props.layerAdapter && (
        <aside data-testid="design-properties-dock" style={{ right: bounds.panelRight, width: bounds.panelWidth }} className="pointer-events-auto fixed z-20 bottom-24 top-32 overflow-auto rounded-2xl border bg-background shadow-lg">
          {props.propertyActions && (
            <DesignPropertiesPanel
              selectedObjects={props.scene.objects.filter((o) =>
                props.selectedObjectIds?.includes(o.objectId),
              )}
              actions={props.propertyActions}
            />
          )}
          <DesignLayersPanel
            objects={props.scene.objects}
            selectedObjectIds={props.selectedObjectIds ?? []}
            adapter={props.layerAdapter}
          />
        </aside>
      )}
      {bounds && !rotatedBoard && (
        <div
          className="fixed overflow-hidden"
          style={{
            left: bounds.clipLeft,
            top: bounds.clipTop,
            width: bounds.clipWidth,
            height: bounds.clipHeight,
          }}
        >
          <div
            className="pointer-events-auto absolute overflow-visible ring-2 ring-primary"
            style={{
              left: bounds.left - bounds.clipLeft,
              top: bounds.top - bounds.clipTop,
              width: bounds.width,
              height: bounds.height,
              visibility: missing ? "hidden" : "visible",
            }}
            tabIndex={0}
            onKeyDown={handleKeys}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.target instanceof HTMLCanvasElement)
                e.currentTarget.focus({ preventScroll: true });
            }}
            onDragOver={(e) => {
              if (
                props.onDropResource &&
                e.dataTransfer.types.includes(
                  "application/x-loomic-design-resource",
                )
              )
                e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData(
                "application/x-loomic-design-resource",
              );
              const rect = e.currentTarget.getBoundingClientRect();
              if (!id || !rect.width || !rect.height) return;
              void props
                .onDropResource?.(id, {
                  x: ((e.clientX - rect.left) * props.width) / rect.width,
                  y: ((e.clientY - rect.top) * props.height) / rect.height,
                })
                .catch((e) => setError(String(e)));
            }}
          >
            <FabricDesignSurface
              showOverflow
              width={props.width}
              height={props.height}
              background={props.background}
              {...(props.scene ? { scene: props.scene } : {})}
              inlineSize={{ width: bounds.width, height: bounds.height }}
              ref={props.editorRef}
              {...(props.resolveAsset
                ? { resolveAsset: props.resolveAsset }
                : {})}
              {...(props.onCanvasReady
                ? { onCanvasReady: props.onCanvasReady }
                : {})}
              {...(props.onCanvasDispose
                ? { onCanvasDispose: props.onCanvasDispose }
                : {})}
              {...(props.onObjectCommand
                ? { onObjectCommand: props.onObjectCommand }
                : {})}
              {...(props.onResourceMissing
                ? { onResourceMissing: props.onResourceMissing }
                : {})}
              onCanvasError={(e) => setError(String(e))}
            />
          </div>
        </div>
      )}
      {props.subInteraction}
    </div>,
    document.body,
  );
}
