"use client";

import { useEffect, useRef, useState } from "react";

export function ImageCropResolutionPanel({
  bounds,
  width,
  height,
  onCancel,
  onSave,
}: {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth?: number;
  };
  width: number;
  height: number;
  onCancel: () => void;
  onSave: (width: number, height: number) => void | Promise<void>;
}) {
  const [draftWidth, setDraftWidth] = useState(String(width));
  const [draftHeight, setDraftHeight] = useState(String(height));
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => setDraftWidth(String(width)), [width]);
  useEffect(() => setDraftHeight(String(height)), [height]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const viewportWidth = Math.min(
    typeof window === "undefined" ? 1024 : window.innerWidth,
    bounds.viewportWidth ?? Number.POSITIVE_INFINITY,
  );
  const windowHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const panelWidth = Math.min(330, viewportWidth - 24);
  const left = Math.max(
    12,
    Math.min(
      viewportWidth - panelWidth - 12,
      bounds.x + bounds.width / 2 - panelWidth / 2,
    ),
  );
  const below = bounds.y + bounds.height + 12;
  const top = below + 64 <= windowHeight ? below : Math.max(12, bounds.y - 60);
  const parsedWidth = Math.max(1, Number.parseInt(draftWidth, 10) || width);
  const parsedHeight = Math.max(1, Number.parseInt(draftHeight, 10) || height);
  const save = async () => {
    if (savePendingRef.current) return;
    savePendingRef.current = true;
    setSaving(true);
    try {
      await onSave(parsedWidth, parsedHeight);
    } finally {
      savePendingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <div
      className="fixed z-[102] flex items-center gap-2 rounded-xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur"
      style={{ left, top, width: panelWidth }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="shrink-0 text-xs font-medium">分辨率</span>
      <label className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-muted/40 px-2">
        <span className="mr-1 text-[10px] text-muted-foreground">W</span>
        <input
          aria-label="裁剪宽度"
          inputMode="numeric"
          value={draftWidth}
          disabled={saving}
          onChange={(event) =>
            setDraftWidth(event.target.value.replace(/\D/g, ""))
          }
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs outline-none"
        />
      </label>
      <span className="text-xs text-muted-foreground">×</span>
      <label className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-muted/40 px-2">
        <span className="mr-1 text-[10px] text-muted-foreground">H</span>
        <input
          aria-label="裁剪高度"
          inputMode="numeric"
          value={draftHeight}
          disabled={saving}
          onChange={(event) =>
            setDraftHeight(event.target.value.replace(/\D/g, ""))
          }
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs outline-none"
        />
      </label>
      <span className="shrink-0 text-[10px] text-muted-foreground">px</span>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs"
      >
        取消
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="shrink-0 rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background disabled:opacity-40"
      >
        {saving ? "保存中…" : "保存"}
      </button>
    </div>
  );
}
