"use client";

import { Copy, ExternalLink } from "lucide-react";
import { createPortal } from "react-dom";

export type SelectedCanvasDesign = {
  designId: string;
  canvasElementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  screenBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth?: number;
  };
};

export function DesignSelectionToolbar({
  design,
  copying,
  onOpen,
  onCopy,
}: {
  design: SelectedCanvasDesign;
  copying: boolean;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const windowWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportWidth = Math.min(
    windowWidth,
    design.screenBounds.viewportWidth ?? windowWidth,
  );
  const toolbarWidth = 196;
  const left = Math.max(
    12,
    Math.min(
      viewportWidth - toolbarWidth - 12,
      design.screenBounds.x + design.screenBounds.width / 2 - toolbarWidth / 2,
    ),
  );
  const top =
    design.screenBounds.y >= 64
      ? design.screenBounds.y - 52
      : design.screenBounds.y + design.screenBounds.height + 12;

  return createPortal(
    <div
      aria-label="设计节点工具栏"
      className="fixed z-[9] flex items-center rounded-xl border border-border bg-background/95 p-1 shadow-xl backdrop-blur"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-muted"
      >
        <ExternalLink className="size-4" />
        打开设计
      </button>
      <button
        type="button"
        disabled={copying}
        onClick={onCopy}
        className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-muted disabled:opacity-50"
      >
        <Copy className="size-4" />
        {copying ? "复制中…" : "复制设计"}
      </button>
    </div>,
    document.body,
  );
}
