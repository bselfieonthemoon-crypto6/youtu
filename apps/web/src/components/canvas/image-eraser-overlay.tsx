"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Eraser, RotateCcw, Sparkles, Undo2, X } from "lucide-react";

import type { NormalizedErasePoint, NormalizedEraseStroke } from "../../lib/image-eraser";

export type ImageEraseMode = "transparent" | "smart";
type MaskBrushMode = "add" | "subtract";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ImageEraserOverlay({
  bounds,
  angle = 0,
  onCancel,
  onConfirm,
}: {
  bounds: { x: number; y: number; width: number; height: number };
  angle?: number;
  onCancel: () => void;
  onConfirm: (mode: ImageEraseMode, strokes: NormalizedEraseStroke[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<ImageEraseMode>("transparent");
  const [brushSize, setBrushSize] = useState(36);
  const [brushMode, setBrushMode] = useState<MaskBrushMode>("add");
  const [strokes, setStrokes] = useState<NormalizedEraseStroke[]>([]);
  const [redoStack, setRedoStack] = useState<NormalizedEraseStroke[]>([]);
  const activePointerRef = useRef<number | null>(null);

  const toLocalPoint = (clientX: number, clientY: number): NormalizedErasePoint => {
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return {
      x: clamp((cosine * dx + sine * dy + bounds.width / 2) / bounds.width, 0, 1),
      y: clamp((-sine * dx + cosine * dy + bounds.height / 2) / bounds.height, 0, 1),
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, bounds.width, bounds.height);
    context.lineCap = "round";
    context.lineJoin = "round";
    const shorterEdge = Math.min(bounds.width, bounds.height);
    for (const stroke of strokes) {
      if (!stroke.points.length) continue;
      const subtracting = stroke.operation === "subtract";
      context.globalCompositeOperation = subtracting ? "destination-out" : "source-over";
      // destination-out uses the brush alpha as its erasing strength. Keep the
      // subtract brush fully opaque so one pass removes the mask completely.
      context.strokeStyle = subtracting ? "rgba(0, 0, 0, 1)" : "rgba(239, 68, 68, 0.62)";
      context.fillStyle = subtracting ? "rgba(0, 0, 0, 1)" : "rgba(239, 68, 68, 0.62)";
      const radius = Math.max(1, stroke.radius * shorterEdge);
      if (stroke.points.length === 1) {
        const point = stroke.points[0]!;
        context.beginPath();
        context.arc(point.x * bounds.width, point.y * bounds.height, radius, 0, Math.PI * 2);
        context.fill();
        continue;
      }
      context.lineWidth = radius * 2;
      context.beginPath();
      context.moveTo(stroke.points[0]!.x * bounds.width, stroke.points[0]!.y * bounds.height);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x * bounds.width, point.y * bounds.height);
      context.stroke();
    }
    context.globalCompositeOperation = "source-over";
  }, [bounds.height, bounds.width, strokes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setStrokes((current) => {
          const last = current.at(-1);
          if (!last) return current;
          setRedoStack((redo) => [...redo, last]);
          return current.slice(0, -1);
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    const radius = brushSize / 2 / Math.max(1, Math.min(bounds.width, bounds.height));
    setStrokes((current) => [...current, {
      points: [toLocalPoint(event.clientX, event.clientY)],
      radius,
      ...(brushMode === "subtract" ? { operation: "subtract" as const } : {}),
    }]);
    setRedoStack([]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = toLocalPoint(event.clientX, event.clientY);
    setStrokes((current) => {
      const active = current.at(-1);
      if (!active) return current;
      const previous = active.points.at(-1)!;
      const pixelDistance = Math.hypot(
        (point.x - previous.x) * bounds.width,
        (point.y - previous.y) * bounds.height,
      );
      if (pixelDistance < 1.5) return current;
      return [...current.slice(0, -1), { ...active, points: [...active.points, point] }];
    });
  };

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const panelWidth = Math.min(680, window.innerWidth - 24);
  const panelLeft = clamp(bounds.x + bounds.width / 2 - panelWidth / 2, 12, window.innerWidth - panelWidth - 12);
  const panelTop = clamp(bounds.y + bounds.height + 12, 12, window.innerHeight - 58);

  return (
    <div className="pointer-events-none fixed inset-0 z-[110]">
      <canvas
        ref={canvasRef}
        aria-label="橡皮涂抹区域"
        className="pointer-events-auto fixed cursor-crosshair touch-none ring-2 ring-primary/70"
        style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, transform: `rotate(${angle}rad)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        className="pointer-events-auto fixed flex h-11 items-center gap-1.5 rounded-xl border border-border bg-background/95 px-2 shadow-xl backdrop-blur"
        style={{ left: panelLeft, top: panelTop, width: panelWidth }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex rounded-lg bg-muted p-0.5">
          <button type="button" onClick={() => setMode("transparent")} className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs ${mode === "transparent" ? "bg-background shadow-sm" : "text-muted-foreground"}`}><Eraser className="size-3.5" />透明擦除</button>
          <button type="button" onClick={() => setMode("smart")} className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs ${mode === "smart" ? "bg-background shadow-sm" : "text-muted-foreground"}`}><Sparkles className="size-3.5" />智能修复</button>
        </div>
        <label className="flex min-w-28 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          粗细
          <input aria-label="橡皮粗细" type="range" min="8" max="120" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="min-w-16 flex-1" />
          <span className="w-7 text-right tabular-nums">{brushSize}</span>
        </label>
        <button type="button" aria-label="撤销擦除" disabled={!strokes.length} onClick={() => setStrokes((current) => { const last = current.at(-1); if (!last) return current; setRedoStack((redo) => [...redo, last]); return current.slice(0, -1); })} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><Undo2 className="size-4" /></button>
        <button type="button" aria-label="重做擦除" disabled={!redoStack.length} onClick={() => setRedoStack((current) => { const last = current.at(-1); if (!last) return current; setStrokes((value) => [...value, last]); return current.slice(0, -1); })} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><RotateCcw className="size-4 scale-x-[-1]" /></button>
        <button
          type="button"
          aria-label="删除涂抹"
          aria-pressed={brushMode === "subtract"}
          onClick={() => setBrushMode((current) => current === "add" ? "subtract" : "add")}
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${brushMode === "subtract" ? "bg-destructive/10 text-destructive ring-1 ring-destructive/30" : "hover:bg-muted"}`}
          title="开启后，在红色涂抹区域上涂画可恢复遮罩"
        >
          <Eraser className="size-4" />
        </button>
        <button type="button" onClick={onCancel} className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs hover:bg-muted"><X className="size-3.5" />取消</button>
        <button type="button" disabled={!strokes.length} onClick={() => onConfirm(mode, strokes)} className="flex h-8 items-center gap-1 rounded-lg bg-foreground px-3 text-xs text-background disabled:opacity-40"><Check className="size-3.5" />应用</button>
      </div>
    </div>
  );
}
