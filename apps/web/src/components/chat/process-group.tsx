"use client";

import React from "react";

/**
 * One collapsed row for the steps that are not part of the conversation: tool
 * runs, submitted-but-pending jobs and their cost receipts.
 *
 * The transcript then reads as the user's words plus the media that was actually
 * delivered, while the process stays one click away instead of filling the chat.
 * Anything the user must see or act on — a pending confirmation, delivered media,
 * a failure — never enters this group (see `isProcessOnlyToolBlock`).
 */
export const ProcessGroup = React.memo(function ProcessGroup({
  count,
  open,
  running = false,
  onToggle,
  children,
}: {
  /** Number of steps inside, shown next to the label. */
  count: number;
  open: boolean;
  /** A grouped step is still executing, so the row keeps a live affordance. */
  running?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`过程 · ${count} 项`}
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        <svg
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
        >
          <path d="m6 3 5 5-5 5" />
        </svg>
        <span>{running ? "正在处理…" : "过程"}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground/60">
          {count} 项
        </span>
        {running ? (
          <span
            aria-hidden="true"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground"
          />
        ) : null}
      </button>
      {open ? <div className="space-y-3 border-l border-border/70 pl-3">{children}</div> : null}
    </section>
  );
});
