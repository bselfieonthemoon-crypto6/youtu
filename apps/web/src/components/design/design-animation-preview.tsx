"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import { getVisibleAnimatedObjects } from "../../lib/design-animation-evaluation";
import type { FabricDesignSurfaceProps } from "./fabric-design-surface";
import { ANIMATION_CONTROL_EVENT, ANIMATION_STATUS_EVENT } from "../../lib/design-animation-events";

/** Read-only rendering copy: never animates the editable Fabric instance. */
export function DesignAnimationPreview({ scene, resolveAsset, pauseSignal, onReady, autoPlay = true, viewportPadding = 0 }: Pick<FabricDesignSurfaceProps, "scene" | "resolveAsset"> & {
  viewportPadding?: number;
  autoPlay?: boolean;
  pauseSignal: number; onReady: (ready: boolean) => void;
}) {
  const output = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const resolver = useRef(resolveAsset); resolver.current = resolveAsset;
  const sceneJson = JSON.stringify(scene);
  const animations = JSON.stringify(scene?.objects.map(o => [o.objectId, o.animation ?? null]));
  const enabled = Boolean(scene && getVisibleAnimatedObjects(scene.objects).length);
  useEffect(() => { setPlaying(autoPlay); }, [animations, autoPlay]);
  useEffect(() => {
    const ids = scene?.objects.map(o => o.objectId) ?? [];
    const status = () => window.dispatchEvent(new CustomEvent(ANIMATION_STATUS_EVENT, { detail: { ids, playing: enabled && playing } }));
    const control = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!ids.includes(detail?.objectId)) return;
      if (detail.action === "query") status();
      else setPlaying(value => !value);
    };
    window.addEventListener(ANIMATION_CONTROL_EVENT, control); status();
    return () => window.removeEventListener(ANIMATION_CONTROL_EVENT, control);
  }, [animations, playing, enabled]);
  useEffect(() => { if (pauseSignal) setPlaying(false); }, [pauseSignal]);
  useEffect(() => {
    if (!enabled || (!playing && autoPlay) || !sceneJson) { onReady(false); setReady(false); return; }
    let cancelled = false, frame = 0;
    let dispose: (() => Promise<void>) | undefined;
    const release = async () => {
      const cleanup = dispose;
      dispose = undefined;
      await cleanup?.();
    };
    onReady(false); setReady(false); setError("");
    async function start() {
      const [{ Canvas }, { FabricObjectEditor }] = await Promise.all([import("fabric"), import("./fabric-object-editor")]);
      if (cancelled) return;
      const snapshot = JSON.parse(sceneJson!);
      const canvas = new Canvas(document.createElement("canvas"), { enableRetinaScaling: false, selection: false,
        backgroundColor: snapshot.canvas.background ?? "rgba(0,0,0,0)" });
      const editor = new FabricObjectEditor(canvas, { readOnly: true, topLeftOrigin: true,
        viewportPadding,
        logicalWidth: snapshot.canvas.width, logicalHeight: snapshot.canvas.height, maxBackingPixels: 1024 * 1024 });
      dispose = async () => { editor.dispose(); await canvas.dispose(); };
      await editor.loadScene(snapshot, object => {
        if (!resolver.current) throw new Error("图片资源暂不可用");
        return resolver.current(object);
      });
      const assets = await editor.waitForImages();
      if (assets.missingAssetObjectIds.length) throw new Error("图片未加载完成");
      if (cancelled) return;
      const target = output.current;
      if (!target) return;
      target.width = canvas.getWidth(); target.height = canvas.getHeight();
      const context = target.getContext("2d");
      if (!context) throw new Error("预览画布不可用");
      const began = performance.now(); let last = -Infinity;
      const draw = (now: number) => {
        if (cancelled) return;
        if (!document.hidden && now - last >= 1000 / 30) {
          if (playing) editor.applyAnimationFrame(now - began);
          canvas.renderAll();
          context.clearRect(0, 0, target.width, target.height);
          context.drawImage(canvas.getElement(), 0, 0);
          onReady(true); setReady(true); last = now;
        }
        if (playing) frame = requestAnimationFrame(draw);
      };
      draw(began);
    }
    const loading = start().catch(async cause => {
      try { await release(); } catch { /* Preserve the original rendering error. */ }
      if (!cancelled) { setError(`预览失败：${cause instanceof Error ? cause.message : "请重试"}`); setPlaying(false); onReady(false); }
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); onReady(false); void loading.then(release).catch(() => undefined); };
  }, [enabled, playing, sceneJson, onReady, autoPlay, viewportPadding]);
  if (!enabled) return null;
  return <>
    <canvas ref={output} data-testid="design-animation-preview" className="pointer-events-none absolute" style={{left:`${-100*viewportPadding/(scene?.canvas.width || 1)}%`,top:`${-100*viewportPadding/(scene?.canvas.height || 1)}%`,width:`${100+200*viewportPadding/(scene?.canvas.width || 1)}%`,height:`${100+200*viewportPadding/(scene?.canvas.height || 1)}%`, visibility: (playing || !autoPlay) && ready && !error ? "visible" : "hidden" }} />
    <button type="button" className="pointer-events-auto absolute bottom-1 left-1 z-30 flex aspect-square items-center justify-center rounded bg-background/90 p-0.5 shadow" style={{ width: "min(22px, 15%)" }} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setPlaying(v => !v); }} aria-label={playing ? "暂停动画预览" : "播放动画预览"} title={error || (playing ? "暂停" : "播放")}>
      {playing ? <Pause className="h-full w-full" /> : <Play className="h-full w-full" />}
    </button>
  </>;
}
