"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignEditorOverlayProps } from "./design-editor-overlay";
import { DesignEditorOverlay } from "./design-editor-overlay";
import { DesignLayersPanel } from "./design-layers-panel";
import { DesignPropertiesPanel } from "./design-properties-panel";
import { FabricDesignSurface } from "./fabric-design-surface";

/** Opt-in shell. Authoritative document/history/jobs remain owned by the session. */
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
  } | null>(null);
  const [resources, setResources] = useState(false);
  const [layers, setLayers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
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
        const clip = preview.parentElement?.getBoundingClientRect() ?? rect;
        const next = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          clipLeft: clip.left,
          clipTop: clip.top,
          clipWidth: clip.width,
          clipHeight: clip.height,
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
  }, [legacy, props.backgroundRoot, props.designId]);

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
      await props.onSave();
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

  // Stage gate: grouped/rotated documents keep the established editor until
  // their coordinate migration has its own browser acceptance coverage.
  const complex = props.scene?.objects.some(
    (o) => o.type === "group" || o.rotation !== 0,
  );
  if (legacy || complex || rotatedBoard)
    return <DesignEditorOverlay {...props} />;
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-30"
      data-testid="design-inline-editor"
    >
      <section
        className="pointer-events-auto fixed left-1/2 top-16 z-30 max-w-[90vw] -translate-x-1/2 rounded-2xl border bg-background p-2 shadow-lg [&_button]:rounded-lg [&_button]:px-2 [&_button]:py-1.5 [&_button:hover]:bg-muted [&_button:disabled]:opacity-40"
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
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>正在编辑：{props.name}</span>
          <button onClick={() => setResources((v) => !v)}>资源</button>
          <button onClick={() => setLayers((v) => !v)}>图层 / 属性</button>
          <button disabled={!props.canUndo} onClick={props.onUndo}>
            撤销
          </button>
          <button disabled={!props.canRedo} onClick={props.onRedo}>
            重做
          </button>
          <button onClick={() => props.onAddObject?.("text")}>添加文字</button>
          <button disabled={busy || props.saving} onClick={() => void save()}>
            保存
          </button>
          <button
            disabled={busy}
            onClick={() => void save(() => setLegacy(true))}
          >
            完整编辑器 / 导出
          </button>
          <button
            disabled={busy}
            onClick={() => (props.dirty ? setClosing(true) : void save(props.onClose))}
          >
            完成
          </button>
        </div>
        <p className="text-xs text-muted-foreground" role="status">
          {props.saving
            ? "保存中…"
            : props.dirty
              ? "未保存"
              : (props.statusMessage ?? "已保存")}
        </p>
        {(error || props.saveError) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? props.saveError}
          </p>
        )}
        {missing && (
          <p role="alert">画板预览不在可视区域，请移回画板或切换完整编辑器。</p>
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
      {layers && props.scene && props.layerAdapter && (
        <aside className="pointer-events-auto fixed z-20 bottom-24 right-[400px] top-32 w-72 overflow-auto rounded-2xl border bg-background shadow-lg">
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
      {bounds && (
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
            className="pointer-events-auto absolute overflow-hidden ring-2 ring-primary"
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
