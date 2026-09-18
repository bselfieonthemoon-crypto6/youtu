"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, X } from "lucide-react";
import { clampMapPosition, MAP_HEIGHT, MAP_WIDTH, mapPointToScroll, minimapLayout, type MapElement, type MapRect } from "../lib/canvas-minimap";

type MapApi = {
  getSceneElements: () => MapElement[];
  getAppState: () => { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number }; selectedElementIds?: Record<string, boolean> };
  onChange: (callback: () => void) => (() => void);
  updateScene: (value: { appState: { scrollX: number; scrollY: number }; captureUpdate: "NONE" }) => void;
};

export function CanvasMinimap({ api, anchor, onClose }: { api: MapApi; anchor: HTMLElement | null; onClose: () => void }) {
  const [position, setPosition] = useState(() => {
    const rect = anchor?.getBoundingClientRect();
    return clampMapPosition(rect?.left ?? 16, (rect?.top ?? window.innerHeight - 52) - 224, window.innerWidth, window.innerHeight);
  });
  const [scene, setScene] = useState(() => ({ elements: api.getSceneElements(), state: api.getAppState() }));
  const move = useRef<{ id: number; x: number; y: number } | null>(null);
  const navigating = useRef<{ id: number; layout: ReturnType<typeof minimapLayout> } | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScene({ elements: api.getSceneElements(), state: api.getAppState() });
      });
    };
    update();
    const unsubscribe = api.onChange(update);
    return () => { unsubscribe?.(); cancelAnimationFrame(frame); };
  }, [api]);
  useEffect(() => {
    const resize = () => setPosition(p => clampMapPosition(p.x, p.y, window.innerWidth, window.innerHeight));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const zoom = Math.max(0.01, scene.state.zoom.value);
  const viewport: MapRect = { x: -scene.state.scrollX, y: -scene.state.scrollY, width: scene.state.width / zoom, height: scene.state.height / zoom };
  const layout = navigating.current?.layout ?? minimapLayout(scene.elements, viewport);
  const project = (rect: MapRect) => ({ x: rect.x * layout.scale + layout.offsetX, y: rect.y * layout.scale + layout.offsetY, width: Math.max(2, rect.width * layout.scale), height: Math.max(2, rect.height * layout.scale) });
  const navigate = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = { x: Math.max(0, Math.min(MAP_WIDTH, (event.clientX - rect.left) * MAP_WIDTH / rect.width)), y: Math.max(0, Math.min(MAP_HEIGHT, (event.clientY - rect.top) * MAP_HEIGHT / rect.height)) };
    api.updateScene({ appState: mapPointToScroll(point, navigating.current?.layout ?? layout, viewport), captureUpdate: "NONE" });
  };
  const endNavigation = () => { navigating.current = null; setScene({ elements: api.getSceneElements(), state: api.getAppState() }); };
  return createPortal(
    <section aria-label="画布小地图" style={{ left: position.x, top: position.y }}
      className="fixed z-40 w-60 max-w-[calc(100vw-16px)] select-none rounded-2xl border border-border bg-card/95 p-2 shadow-lg backdrop-blur-lg"
      onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
      onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex flex-1 touch-none cursor-grab items-center gap-2 px-1 py-1 text-xs text-muted-foreground active:cursor-grabbing"
          aria-label="拖动小地图窗口"
          onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); move.current = { id: e.pointerId, x: e.clientX - position.x, y: e.clientY - position.y }; }}
          onPointerMove={e => { if (move.current?.id === e.pointerId) setPosition(clampMapPosition(e.clientX - move.current.x, e.clientY - move.current.y, window.innerWidth, window.innerHeight)); }}
          onPointerUp={() => { move.current = null; }} onPointerCancel={() => { move.current = null; }} onLostPointerCapture={() => { move.current = null; }}>
          <GripHorizontal className="size-3.5" />小地图
        </div>
        <button type="button" aria-label="关闭小地图" className="rounded-full p-1 text-muted-foreground hover:bg-muted" onClick={onClose}><X className="size-3.5" /></button>
      </div>
      <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} aria-label="小地图导航" role="application" tabIndex={0}
        className="block w-full touch-none cursor-crosshair rounded-lg bg-muted/50 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); navigating.current = { id: e.pointerId, layout }; e.currentTarget.setPointerCapture(e.pointerId); navigate(e); }}
        onPointerMove={e => { if (navigating.current?.id === e.pointerId) navigate(e); }}
        onPointerUp={endNavigation} onPointerCancel={endNavigation} onLostPointerCapture={endNavigation}
        onKeyDown={e => {
          const directions: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
          const direction = directions[e.key];
          if (!direction) return;
          e.preventDefault();
          api.updateScene({ appState: { scrollX: scene.state.scrollX + direction[0] * viewport.width / 5, scrollY: scene.state.scrollY + direction[1] * viewport.height / 5 }, captureUpdate: "NONE" });
        }}>
        {layout.blocks.map(block => <rect key={block.id} data-minimap-block={block.id} {...project(block)} rx="1"
          fill={scene.state.selectedElementIds?.[block.id] ? "#3b82f6" : block.board ? "#a78bfa" : "#94a3b8"} fillOpacity="0.65" />)}
        <rect {...project(viewport)} data-testid="minimap-viewport" fill="#3b82f6" fillOpacity="0.06" stroke="#3b82f6" strokeWidth="1.5" pointerEvents="none" />
        {!layout.blocks.length && <text x={MAP_WIDTH / 2} y={MAP_HEIGHT / 2} textAnchor="middle" className="fill-muted-foreground text-[11px]">画布暂无内容</text>}
      </svg>
      <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">点击 / 拖动定位 · 蓝框为当前视野</p>
    </section>, document.body,
  );
}
