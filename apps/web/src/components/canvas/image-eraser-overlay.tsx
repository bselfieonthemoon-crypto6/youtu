"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Eraser, Paintbrush, Redo2, RotateCcw, Sparkles, Trash2, Undo2, X } from "lucide-react";

import type { NormalizedErasePoint, NormalizedEraseStroke } from "../../lib/image-eraser";

export type ImageEraseMode = "transparent" | "smart";
type MaskBrushMode = "add" | "subtract";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function strokeCoversPoint(
  stroke: NormalizedEraseStroke,
  x: number,
  y: number,
  bounds: { width: number; height: number },
) {
  const radius = stroke.radius * Math.min(bounds.width, bounds.height);
  const points = stroke.points;
  if (!points.length) return false;
  const pointDistance = (from: NormalizedErasePoint, to: NormalizedErasePoint) => Math.hypot(
    (from.x - to.x) * bounds.width,
    (from.y - to.y) * bounds.height,
  );
  const sample = { x, y };
  if (points.length === 1) return pointDistance(points[0]!, sample) <= radius;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const segmentX = (end.x - start.x) * bounds.width;
    const segmentY = (end.y - start.y) * bounds.height;
    const lengthSquared = segmentX ** 2 + segmentY ** 2;
    const projectionNumerator = (x - start.x) * bounds.width * segmentX
      + (y - start.y) * bounds.height * segmentY;
    const projected = lengthSquared === 0 ? 0 : clamp(
      projectionNumerator / lengthSquared,
      0,
      1,
    );
    if (pointDistance({ x: start.x + (end.x - start.x) * projected, y: start.y + (end.y - start.y) * projected }, sample) <= radius) return true;
  }
  return false;
}

/** Mirrors the preview canvas compositing at a small resolution to reject fully erased masks. */
function hasVisibleMask(strokes: NormalizedEraseStroke[], bounds: { width: number; height: number }) {
  const probes: NormalizedErasePoint[] = [];
  const resolution = 64;
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) probes.push({ x: (column + 0.5) / resolution, y: (row + 0.5) / resolution });
  }
  for (const stroke of strokes) {
    if (stroke.operation !== "subtract") probes.push(...stroke.points);
  }
  return probes.some((probe) => {
    let alpha = 0;
    for (const stroke of strokes) {
      if (!strokeCoversPoint(stroke, probe.x, probe.y, bounds)) continue;
      alpha = stroke.operation === "subtract" ? 0 : alpha + (1 - alpha) * 0.62;
    }
    return alpha > 0.01;
  });
}

export function ImageEraserOverlay({
  bounds,
  angle = 0,
  onCancel,
  onConfirm,
  repaint = false,
  busy = false,
  locked = false,
  lockNote = "上一次提交结果未确认：选区与描述已锁定为原请求，点击「重试原请求」原样重试，不会重复扣费。",
  replayLabel = "重试原请求",
  error,
}: {
  bounds: { x: number; y: number; width: number; height: number };
  angle?: number;
  onCancel: () => void;
  /** The optional prompt is supplied by the canvas repaint experience. */
  onConfirm: (mode: ImageEraseMode, strokes: NormalizedEraseStroke[], prompt?: string) => void;
  /** Enables the canvas repaint panel. Omit to retain the legacy eraser UI. */
  repaint?: boolean;
  /** Parent-controlled submission state; the panel keeps its draft while this changes. */
  busy?: boolean;
  /**
   * The parent already owns this exact request (an unconfirmed submission, or a
   * job whose outcome is unknown). Editing the mask or the description would
   * silently submit — or silently discard — something other than what the user
   * sees, so the panel becomes read-only and the button replays the request.
   */
  locked?: boolean;
  /** Read-only banner copy; the two recovery states explain different actions. */
  lockNote?: string;
  /** Label of the replay button while `locked`. */
  replayLabel?: string;
  /** Parent-controlled repaint failure message. */
  error?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<ImageEraseMode>("transparent");
  const [brushSize, setBrushSize] = useState(36);
  const [brushMode, setBrushMode] = useState<MaskBrushMode>("add");
  const [strokes, setStrokes] = useState<NormalizedEraseStroke[]>([]);
  const [redoStack, setRedoStack] = useState<NormalizedEraseStroke[]>([]);
  const [prompt, setPrompt] = useState("");
  const [hasEffectiveMask, setHasEffectiveMask] = useState(false);
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
    setHasEffectiveMask(hasVisibleMask(strokes, bounds));
  }, [bounds, strokes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable)) return;
        if (busy) return;
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
  }, [busy, onCancel]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || busy || locked) return;
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

  const panelWidth = Math.min(repaint ? 560 : 680, Math.max(240, window.innerWidth - 24));
  const panelLeft = clamp(bounds.x + bounds.width / 2 - panelWidth / 2, 12, window.innerWidth - panelWidth - 12);
  // The read-only banner adds a line next to the failure message; keep the
  // placement estimate in step so the panel is not pushed off screen.
  const panelHeight = repaint ? (locked ? 172 : 154) : 58;
  const belowTop = bounds.y + bounds.height + 12;
  const panelTop = clamp(belowTop + panelHeight <= window.innerHeight ? belowTop : bounds.y - panelHeight - 12, 12, Math.max(12, window.innerHeight - panelHeight - 12));
  const canSubmitRepaint = !busy && prompt.trim().length > 0 && hasEffectiveMask;

  const undo = () => setStrokes((current) => {
    const last = current.at(-1);
    if (!last) return current;
    setRedoStack((redo) => [...redo, last]);
    return current.slice(0, -1);
  });
  const redo = () => setRedoStack((current) => {
    const last = current.at(-1);
    if (!last) return current;
    setStrokes((value) => [...value, last]);
    return current.slice(0, -1);
  });
  const clear = () => {
    setStrokes([]);
    setRedoStack([]);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-[110]">
      <canvas
        ref={canvasRef}
        aria-label={repaint ? "局部重绘涂抹区域" : "橡皮涂抹区域"}
        className={`fixed touch-none ring-2 ring-primary/70 ${locked ? "pointer-events-none cursor-not-allowed" : "pointer-events-auto cursor-crosshair"}`}
        style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, transform: `rotate(${angle}rad)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onContextMenu={(event) => event.preventDefault()}
      />
      {repaint ? <div
        className="pointer-events-auto fixed rounded-xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur"
        style={{ left: panelLeft, top: panelTop, width: panelWidth, maxWidth: "calc(100vw - 24px)" }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <textarea
            aria-label="修改要求"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy || locked}
            placeholder="描述要如何重绘选中的内容…"
            className="min-h-14 flex-1 resize-none rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
          />
          <button type="button" aria-label="移除选中内容" disabled={busy || locked} onClick={() => setPrompt("移除涂抹区域内的内容并自然补全背景")} className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs hover:bg-muted" title="快速填写移除已涂抹内容的重绘要求">
            <Trash2 className="size-3.5" />移除选中内容
          </button>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <div className="flex shrink-0 rounded-lg bg-muted p-0.5">
            <button type="button" aria-label="添加涂抹" aria-pressed={brushMode === "add"} disabled={busy || locked} onClick={() => setBrushMode("add")} className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs ${brushMode === "add" ? "bg-background shadow-sm" : "text-muted-foreground"}`}><Paintbrush className="size-3.5" />添加</button>
            <button type="button" aria-label="减少涂抹" aria-pressed={brushMode === "subtract"} disabled={busy || locked} onClick={() => setBrushMode("subtract")} className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs ${brushMode === "subtract" ? "bg-background shadow-sm" : "text-muted-foreground"}`}><Eraser className="size-3.5" />减少</button>
          </div>
          <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">大小<input aria-label="重绘画笔大小" disabled={busy || locked} type="range" min="8" max="120" step="2" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} className="min-w-10 flex-1" /><span className="w-6 text-right tabular-nums">{brushSize}</span></label>
          <button type="button" aria-label="撤销涂抹" disabled={busy || locked || !strokes.length} onClick={undo} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><Undo2 className="size-4" /></button>
          <button type="button" aria-label="重做涂抹" disabled={busy || locked || !redoStack.length} onClick={redo} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><Redo2 className="size-4" /></button>
          <button type="button" aria-label="清除涂抹" disabled={busy || locked || !strokes.length} onClick={clear} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><RotateCcw className="size-4" /></button>
          <button type="button" aria-label="取消重绘" disabled={busy} onClick={onCancel} className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs hover:bg-muted disabled:opacity-30"><X className="size-3.5" />取消</button>
          <button type="button" disabled={!canSubmitRepaint} onClick={() => onConfirm("smart", strokes, prompt.trim())} className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-foreground px-3 text-xs text-background disabled:opacity-40"><Sparkles className="size-3.5" />{busy ? "重绘中…" : locked ? replayLabel : "开始重绘"}</button>
        </div>
        {locked ? <p className="mt-1 text-xs text-amber-600">{lockNote}</p> : null}
        {error ? <p role="alert" className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div> : <div
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
        <button type="button" aria-label="撤销擦除" disabled={!strokes.length} onClick={undo} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><Undo2 className="size-4" /></button>
        <button type="button" aria-label="重做擦除" disabled={!redoStack.length} onClick={redo} className="flex size-8 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-30"><RotateCcw className="size-4 scale-x-[-1]" /></button>
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
      </div>}
    </div>
  );
}
