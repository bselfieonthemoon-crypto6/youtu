"use client";

import { designUuidSchema } from "@loomic/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { readDesignNodeMetadata, type DesignOpenTarget } from "../../lib/canvas-design";
import { designBoardLabel } from "../../lib/design-board-label";
import { createDesignApiClient } from "../../lib/design-api";
import { resolveCanvasImageSource } from "../../lib/canvas-image-source";
import { fetchCanvas, uploadFile } from "../../lib/server-api";
import { importCanvasImageToDesign, undoCanvasImageImport } from "../../lib/design-canvas-image-api";
import { boardContainsImageCenter, type ImageBoardTarget } from "../../lib/image-board-placement";
import { DESIGN_PREVIEW_REFRESH_EVENT } from "../design/design-node-overlay-layer";
import { ImageBoardPicker } from "./image-board-picker";
import type { SelectedCanvasImage } from "./image-toolbar-types";

const designApi = createDesignApiClient();
type Pose = { x: number; y: number; width: number; height: number; angle: number };
const poseOf = (e: any): Pose => ({ x: e.x, y: e.y, width: e.width, height: e.height, angle: e.angle ?? 0 });
// Unknown outcomes retain their frozen request so retries cannot duplicate a layer.
const wasRejected = (error: unknown) => !!error && typeof error === "object"
  && "status" in error && Number(error.status) >= 400 && Number(error.status) < 500
  && "code" in error && error.code !== "response_invalid";
const replaceElement = (api: any, id: string, patch: Record<string, unknown>) => api.updateScene({
  elements: api.getSceneElementsIncludingDeleted().map((e: any) => e.id === id
    ? { ...e, ...patch, version: (e.version ?? 0) + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now() } : e),
});
const importableAssetId = (value: unknown) => {
  const parsed = designUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const imageFileName = (image: SelectedCanvasImage, mimeType: string) => {
  const title = image.title?.trim();
  if (title) return title.slice(0, 200);
  const extension = mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1]?.split("+")[0] || "png");
  return `canvas-image-${image.id.slice(0, 12)}.${extension}`;
};
function boardsOf(api: any): ImageBoardTarget[] {
  return (api?.getSceneElements() ?? []).flatMap((e: any) => {
    const metadata = readDesignNodeMetadata(e);
    return !e.isDeleted && metadata ? [{ elementId: e.id, designId: metadata.designId,
      name: designBoardLabel(metadata.designId), ...poseOf(e), locked: e.locked === true }] : [];
  });
}

/** Manual-only import: no agent, image generation or credit operations. */
export function CanvasImageBoardActions({ accessToken, canvasId, api, image, open, onClose,
  onPersistCanvas, onCanvasRefreshRequest, onCanvasRevisionChange, onOpenDesign }: {
  accessToken: string; canvasId: string; api: any; image: SelectedCanvasImage | null; open: boolean;
  onClose: () => void; onPersistCanvas: () => Promise<void>; onCanvasRefreshRequest?: () => Promise<void>;
  onCanvasRevisionChange: (revision: number) => void; onOpenDesign?: (target: DesignOpenTarget) => void;
}) {
  const [source, setSource] = useState<SelectedCanvasImage | null>(null);
  const [boards, setBoards] = useState<ImageBoardTarget[]>([]);
  const [highlight, setHighlight] = useState<ImageBoardTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [drop, setDrop] = useState<{ source: SelectedCanvasImage; pose: Pose } | null>(null);
  const [undo, setUndo] = useState<{ operationId: string; undoRequestId: string; designId: string; boardId: string; objectId: string; source: any; mode: "copy" | "adopt"; removedVersion?: number; restoredVersion?: number } | null>(null);
  const busyRef = useRef(false);
  const attempt = useRef<{ key: string; requestId: string; body?: Parameters<typeof importCanvasImageToDesign>[1] } | null>(null);
  const undoAttempt = useRef<Parameters<typeof undoCanvasImageImport>[3] | null>(null);
  const createAttempt = useRef<{ requestId: string; elementId: string; body?: Parameters<typeof designApi.createDesign>[1] } | null>(null);
  const sourceRef = useRef(image); sourceRef.current = image;
  const dragRef = useRef<{ original: any; image: SelectedCanvasImage } | null>(null);
  const previewKeys = useRef(new Map<string, string>());
  const queuePreview = useCallback(async (designId: string, revision: number) => {
    const key = `${designId}:${revision}`;
    if (!previewKeys.current.has(key)) previewKeys.current.set(key, crypto.randomUUID());
    await designApi.queueDesignPreview(accessToken, { design_id: designId, expected_revision: revision, idempotency_key: previewKeys.current.get(key)! });
  }, [accessToken]);
  useEffect(() => { if (open && image) { setSource(image); setBoards(boardsOf(api)); setError(undefined); } }, [open, image?.id, api]);
  useEffect(() => {
    if (!open && !drop) return;
    let active = true;
    const targets = drop ? boards : boardsOf(api);
    void Promise.all(targets.map(async board => {
      try { const doc = await designApi.getDesign(accessToken, board.designId);
        return { ...board, name: designBoardLabel(board.designId, doc.name) };
      } catch { return board; }
    })).then(next => { if (active) setBoards(next); });
    return () => { active = false; };
  }, [open, drop, api, accessToken]);
  const refresh = useCallback(async () => {
    await onCanvasRefreshRequest?.();
    window.dispatchEvent(new Event(DESIGN_PREVIEW_REFRESH_EVENT));
    setBoards(boardsOf(api));
  }, [api, onCanvasRefreshRequest]);

  const ensureImportableSource = useCallback(async (authoritative: any, selected: SelectedCanvasImage, projectId: string) => {
    if (importableAssetId(authoritative.customData?.assetId)) return false;
    const current = api.getSceneElements().find((e: any) => e.id === authoritative.id && !e.isDeleted);
    if (!current || current.version !== authoritative.version || current.fileId !== authoritative.fileId)
      throw new Error("图片在资产固化前已变化，请重新选择。");

    const files = api.getFiles?.() ?? {};
    const boundFileAssetId = importableAssetId(current.fileId ? files[current.fileId]?.assetId : null);
    let assetId = boundFileAssetId;
    if (!assetId) {
      const source = await resolveCanvasImageSource(accessToken, current, files);
      const response = await fetch(source);
      if (!response.ok) throw new Error("无法读取本地图片内容。");
      const blob = await response.blob();
      const mimeType = blob.type || selected.mimeType || "image/png";
      const uploaded = await uploadFile(
        accessToken,
        new File([blob], imageFileName(selected, mimeType), { type: mimeType }),
        projectId,
      );
      assetId = uploaded.asset.id;
    }

    const latest = api.getSceneElements().find((e: any) => e.id === authoritative.id && !e.isDeleted);
    if (!latest || latest.version !== authoritative.version || latest.fileId !== authoritative.fileId)
      throw new Error("图片在资产固化期间已变化；未替换当前图片，请重新选择。");
    replaceElement(api, latest.id, {
      customData: {
        ...(latest.customData ?? {}),
        assetId,
        mimeType: latest.customData?.mimeType ?? selected.mimeType,
      },
    });
    try {
      await onPersistCanvas();
    } catch (cause) {
      throw new Error(`图片资产已创建，但画布绑定尚未确认保存。请重试同一操作。${cause instanceof Error ? cause.message : ""}`);
    }
    return true;
  }, [accessToken, api, onPersistCanvas]);

  const perform = useCallback(async (board: ImageBoardTarget, mode: "copy" | "adopt", selected: SelectedCanvasImage, dropPose?: Pose) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    let committed = false;
    try {
      await onPersistCanvas();
      let { canvas } = await fetchCanvas(accessToken, canvasId);
      let elements = (canvas.content as any).elements ?? [];
      let original = elements.find((e: any) => e.id === selected.id && !e.isDeleted);
      let boardElement = elements.find((e: any) => e.id === board.elementId && !e.isDeleted);
      if (!original || !boardElement) throw new Error("图片或目标画板已变化，请重新选择。");
      if (original.locked || boardElement.locked) throw new Error("请先解锁图片和画板。");
      if (await ensureImportableSource(original, selected, canvas.projectId)) {
        ({ canvas } = await fetchCanvas(accessToken, canvasId));
        elements = (canvas.content as any).elements ?? [];
        original = elements.find((e: any) => e.id === selected.id && !e.isDeleted);
        boardElement = elements.find((e: any) => e.id === board.elementId && !e.isDeleted);
        if (!original || !boardElement) throw new Error("图片或目标画板在资产固化后发生变化，请重新选择。");
        if (original.locked || boardElement.locked) throw new Error("请先解锁图片和画板。");
      }
      const design = await designApi.getDesign(accessToken, board.designId);
      const key = JSON.stringify([selected.id, board.designId, mode, dropPose ?? null]);
      if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() };
      attempt.current.body ??= {
        request_id: attempt.current.requestId, design_id: board.designId, expected_design_revision: design.revision,
        canvas_id: canvasId, source_element_id: original.id, expected_source_element_version: original.version,
        board_element_id: board.elementId, expected_board_element_version: boardElement.version,
        mode, placement: mode === "adopt" || dropPose ? { kind: "preserve", ...(dropPose ? { scene_pose: dropPose } : {}) } : { kind: "fit" },
      };
      const result = await importCanvasImageToDesign(accessToken, attempt.current.body);
      committed = true;
      let previewPending = false;
      try { await queuePreview(board.designId, result.design_revision); } catch { previewPending = true; }
      const undoRequestId = crypto.randomUUID();
      undoAttempt.current = null;
      setUndo({ operationId: result.operation_id, undoRequestId, designId: board.designId, boardId: board.elementId, objectId: result.object_id, source: original, mode: "copy" });
      let removedVersion: number | undefined;
      if (mode === "adopt") {
        // The layer must exist durably before the canvas instance may disappear.
        const live = api.getSceneElements().find((e: any) => e.id === original.id && !e.isDeleted);
        if (!live || live.version !== original.version) throw new Error("图层已加入，但原图刚刚发生变化，已保留原图。请检查后手动处理。");
        replaceElement(api, original.id, { isDeleted: true });
        try { await onPersistCanvas(); }
        catch (cause) { replaceElement(api, original.id, { isDeleted: false }); throw cause; }
        removedVersion = api.getSceneElementsIncludingDeleted().find((e: any) => e.id === original.id)?.version;
      }
      setUndo({ operationId: result.operation_id, undoRequestId, designId: board.designId, boardId: board.elementId, objectId: result.object_id, source: original, mode, ...(removedVersion ? { removedVersion } : {}) });
      attempt.current = null; setDrop(null); setSource(null); onClose();
      await refresh();
      api.updateScene({ appState: { selectedElementIds: { [board.elementId]: true } } });
      setNotice((mode === "adopt" ? "已按当前位置加入画板图层" : "已添加独立图片图层，画布原图保留") + (previewPending ? "；预览暂未更新，可进入画板查看图层。" : ""));
    } catch (cause) {
      if (!committed && wasRejected(cause)) attempt.current = null;
      setError(`${committed ? "图层已加入；界面同步未完成，请刷新查看，不要重复添加。" : "未确认加入成功，原图保留。"}${cause instanceof Error ? cause.message : "请重试同一操作。"}`);
    } finally { busyRef.current = false; setBusy(false); setHighlight(null); }
  }, [accessToken, canvasId, api, onPersistCanvas, onCanvasRevisionChange, refresh, onClose, queuePreview, ensureImportableSource]);

  const undoImport = async () => {
    if (!undo || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      const design = await designApi.getDesign(accessToken, undo.designId);
      const layer = design.scene.objects.find(object => object.objectId === undo.objectId);
      if (layer && layer.objectVersion !== 1) throw new Error("图层已继续编辑，请在画板内撤销或删除，原图状态未改变。");
      // Restore the original first: an interrupted undo may duplicate, never lose it.
      if (undo.mode === "adopt") {
        const current = api.getSceneElementsIncludingDeleted().find((e: any) => e.id === undo.source.id);
        if (!current || (current.isDeleted ? current.version !== undo.removedVersion : current.version !== undo.restoredVersion)) throw new Error("原图状态已变化，不能自动撤销。");
        if (current.isDeleted) {
          replaceElement(api, current.id, { isDeleted: false });
          await onPersistCanvas();
          const restoredVersion = api.getSceneElements().find((e: any) => e.id === current.id)?.version;
          setUndo(value => value ? { ...value, restoredVersion } : value);
        }
      }
      undoAttempt.current ??= {
        idempotency_key: undo.undoRequestId, expected_design_revision: design.revision, expected_object_version: 1,
      };
      const result = await undoCanvasImageImport(accessToken, undo.designId, undo.operationId, undoAttempt.current);
      await queuePreview(undo.designId, result.design_revision).catch(() => undefined);
      undoAttempt.current = null;
      setUndo(null); setNotice("已撤销加入画板"); await refresh();
    } catch (cause) { if (wasRejected(cause)) undoAttempt.current = null; setError(cause instanceof Error ? cause.message : "撤销未完成，请重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const createAndAdd = async () => {
    if (!source || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    let target: ImageBoardTarget | undefined;
    try {
      await onPersistCanvas();
      const { canvas } = await fetchCanvas(accessToken, canvasId);
      createAttempt.current ??= { requestId: crypto.randomUUID(), elementId: crypto.randomUUID() };
      const width = Math.max(1, Math.min(32768, Math.round(source.originalWidth ?? source.width)));
      const height = Math.max(1, Math.min(32768, Math.round(source.originalHeight ?? source.height)));
      const node = { x: source.x + source.width + 80, y: source.y, width: source.width, height: source.width * height / width };
      createAttempt.current.body ??= { request_id: createAttempt.current.requestId, canvas_id: canvasId,
        expected_canvas_revision: canvas.revision, canvas_element_id: createAttempt.current.elementId, width, height, background: null, node };
      const result = await designApi.createDesign(accessToken, createAttempt.current.body);
      target = { ...node, elementId: result.canvas_element_id, designId: result.design_id, name: "新画板" };
      onCanvasRevisionChange(result.canvas_revision); await refresh(); createAttempt.current = null;
    } catch (cause) { if (wasRejected(cause)) createAttempt.current = null; setError(cause instanceof Error ? cause.message : "创建画板失败，原图保留。"); }
    finally { busyRef.current = false; setBusy(false); }
    if (target) await perform(target, "copy", source);
  };

  useEffect(() => {
    if (!api) return;
    const down = (event: PointerEvent) => {
      if (busyRef.current || event.button !== 0 || !(event.target instanceof Element)
        || !event.target.closest('[data-testid="canvas-editor"]') || event.target.closest('button,input,textarea,[role="dialog"]')) return;
      const selected = sourceRef.current;
      if (!selected) return;
      const original = api.getSceneElements().find((e: any) => e.id === selected.id && !e.isDeleted && !e.locked);
      if (original) dragRef.current = { original: { ...original }, image: { ...selected } };
    };
    const moved = () => {
      const started = dragRef.current;
      if (!started) return null;
      const current = api.getSceneElements().find((e: any) => e.id === started.original.id && !e.isDeleted);
      if (!current || current.width !== started.original.width || current.height !== started.original.height || current.angle !== started.original.angle
        || Math.hypot(current.x - started.original.x, current.y - started.original.y) < 5) return null;
      return { ...started.image, ...poseOf(current) };
    };
    const move = () => { const current = moved(); if (current) setHighlight(boardsOf(api).find(b => !b.locked && boardContainsImageCenter(b, current)) ?? null); };
    const up = () => {
      const saved = dragRef.current;
      if (!saved) return;
      const current = moved(); dragRef.current = null; setHighlight(null);
      if (!current || busyRef.current) return;
      const targets = boardsOf(api).filter(b => !b.locked && boardContainsImageCenter(b, current));
      if (!targets.length) return;
      if (targets.length === 1 && boardContainsImageCenter(targets[0]!, saved.image)) {
        setSource(current);
        void perform(targets[0]!, "adopt", current);
        return;
      }
      // Restore the canvas original, then import a copy at the explicit drop pose.
      replaceElement(api, saved.original.id, poseOf(saved.original));
      setSource(saved.image); setDrop({ source: saved.image, pose: poseOf(current) }); setBoards(targets);
      if (targets.length === 1) void perform(targets[0]!, "copy", saved.image, poseOf(current));
    };
    window.addEventListener("pointerdown", down, true); window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [api, perform]);

  const state = api?.getAppState() ?? {}; const zoom = state.zoom?.value ?? 1;
  return <>
    {highlight && <div aria-hidden="true" className="pointer-events-none fixed z-[105] border-2 border-blue-500 bg-blue-500/10" style={{ left: (highlight.x + (state.scrollX ?? 0)) * zoom, top: (highlight.y + (state.scrollY ?? 0)) * zoom, width: highlight.width * zoom, height: highlight.height * zoom, transform: `rotate(${highlight.angle ?? 0}rad)` }}><span className="absolute -top-7 rounded bg-blue-600 px-2 py-1 text-xs text-white">松开以添加图层</span></div>}
    {(open || drop) && source && <ImageBoardPicker image={source} boards={boards} busy={busy} {...(error ? { error } : {})}
      onHighlight={setHighlight} onCreate={() => void createAndAdd()} onClose={() => { if (!busyRef.current) { setDrop(null); setSource(null); onClose(); } }}
      onChoose={(board, mode) => void perform(board, drop ? "copy" : mode, source, drop?.pose)} />}
    {(notice || error || undo) && !(open || drop) && <div role="status" className="absolute left-4 top-16 z-[110] max-w-md rounded-xl border bg-background p-3 text-xs shadow-lg">
      <p>{error ?? notice}</p><div className="mt-2 flex gap-3">
      {undo && <><button disabled={busy} onClick={() => void undoImport()} className="underline">撤销加入</button><button onClick={() => onOpenDesign?.({ designId: undo.designId, canvasElementId: undo.boardId, initialObjectId: undo.objectId })} className="underline">编辑画板图层</button></>}
      <button disabled={busy} onClick={() => { setNotice(undefined); setError(undefined); setUndo(null); }}>关闭</button></div>
    </div>}
  </>;
}
