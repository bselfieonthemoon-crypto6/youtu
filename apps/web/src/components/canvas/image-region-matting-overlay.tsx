"use client";

import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, MousePointer2, X } from "lucide-react";

import type { NormalizedImageRegion } from "../../lib/canvas-image-crop";

// Keep the drag in image-relative coordinates. Screen pixels become stale as
// soon as the canvas is zoomed or panned, while normalized points continue to
// describe the same part of the image.
type Point = { x: number; y: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundNormalized(value: number) {
  return Number(value.toFixed(6));
}

function screenPixel(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function normalizedRegion(start: Point, end: Point): NormalizedImageRegion {
  return {
    x: roundNormalized(Math.min(start.x, end.x)),
    y: roundNormalized(Math.min(start.y, end.y)),
    width: roundNormalized(Math.abs(end.x - start.x)),
    height: roundNormalized(Math.abs(end.y - start.y)),
  };
}

export function ImageRegionMattingOverlay({
  bounds,
  angle = 0,
  hint = "拖动框选想要的元素",
  selectedHint = "已框选，确认后开始抠图",
  confirmLabel = "确认抠图",
  note,
  error,
  disabled = false,
  onCancel,
  onConfirm,
}: {
  bounds: { x: number; y: number; width: number; height: number };
  angle?: number;
  /** Copy shown before a box exists. */
  hint?: string;
  /** Copy shown once a usable box exists. */
  selectedHint?: string;
  confirmLabel?: string;
  /** Cost or scope disclosure, e.g. the quoted paid calls. */
  note?: string;
  /** Blocks confirmation without discarding the drawn box. */
  error?: string;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: (region: NormalizedImageRegion) => void;
}) {
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && start && end) {
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        if (width * bounds.width >= 12 && height * bounds.height >= 12) {
          onConfirm(normalizedRegion(start, end));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bounds.height, bounds.width, end, onCancel, onConfirm, start]);

  const toLocalPoint = (clientX: number, clientY: number): Point => {
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

  const selection = useMemo(() => {
    if (!start || !end) return null;
    return normalizedRegion(start, end);
  }, [end, start]);
  const canConfirm = Boolean(
    selection && selection.width * bounds.width >= 12 && selection.height * bounds.height >= 12,
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toLocalPoint(event.clientX, event.clientY);
    setStart(point);
    setEnd(point);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    setEnd(toLocalPoint(event.clientX, event.clientY));
  };

  const confirm = () => {
    if (!selection || !canConfirm || disabled) return;
    onConfirm(normalizedRegion(start!, end!));
  };

  const panelLeft = clamp(bounds.x + bounds.width / 2 - 170, 12, window.innerWidth - 352);
  const panelTop = clamp(bounds.y + bounds.height + 12, 12, window.innerHeight - 58);

  return (
    <div className="pointer-events-none fixed inset-0 z-[110]">
      <div
        className="pointer-events-auto fixed overflow-hidden ring-2 ring-primary/80 cursor-crosshair touch-none"
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
          transform: `rotate(${angle}rad)`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="pointer-events-none absolute inset-0 bg-black/20" />
        {selection && (
          <div
            className="pointer-events-none absolute border-2 border-white bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.3)]"
            style={{
              left: screenPixel(selection.x * bounds.width),
              top: screenPixel(selection.y * bounds.height),
              width: screenPixel(selection.width * bounds.width),
              height: screenPixel(selection.height * bounds.height),
            }}
          >
            <span className="absolute -left-1 -top-1 size-2 rounded-full border border-primary bg-white" />
            <span className="absolute -right-1 -top-1 size-2 rounded-full border border-primary bg-white" />
            <span className="absolute -bottom-1 -left-1 size-2 rounded-full border border-primary bg-white" />
            <span className="absolute -bottom-1 -right-1 size-2 rounded-full border border-primary bg-white" />
          </div>
        )}
      </div>

      <div
        className="pointer-events-auto fixed flex h-11 items-center gap-2 rounded-xl border border-border bg-background/95 px-2 shadow-xl backdrop-blur"
        style={{ left: panelLeft, top: panelTop }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <MousePointer2 className="size-3.5" />
          {canConfirm ? selectedHint : hint}
        </span>
        {note && <span className="px-1 text-[11px] text-muted-foreground">{note}</span>}
        {error && <span role="alert" className="px-1 text-[11px] text-destructive">{error}</span>}
        <button type="button" onClick={onCancel} className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs hover:bg-muted">
          <X className="size-3.5" />取消
        </button>
        <button type="button" disabled={!canConfirm || disabled} onClick={confirm} className="flex h-8 items-center gap-1 rounded-lg bg-foreground px-3 text-xs text-background disabled:cursor-not-allowed disabled:opacity-40">
          <Check className="size-3.5" />{confirmLabel}
        </button>
      </div>
    </div>
  );
}
