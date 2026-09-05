"use client";

import { memo } from "react";

export const GeneratingOverlay = memo(function GeneratingOverlay({
  id,
  screenX,
  screenY,
  screenW,
  screenH,
  model,
  label,
  status,
}: {
  id: string;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  model?: string;
  label?: string;
  status?: "generating" | "error";
}) {
  return (
    <div
      key={id}
      data-canvas-generating-overlay={id}
      className="pointer-events-none absolute overflow-hidden rounded-lg"
      style={{
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        // Above the Excalidraw content, below canvas controls and every app
        // panel. Because this is no longer portaled, the canvas container also
        // clips it at the chat/sidebar boundary exactly like an image node.
        zIndex: 5,
      }}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted">
        <svg
          className="h-12 w-12 text-muted-foreground/40"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
        </svg>
        {model && (
          <span className="mt-2 rounded-full bg-foreground/5 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {model.split("/").pop()?.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}
          </span>
        )}
        <span className={`mt-1 text-[11px] ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {status === "error" ? "生成失败" : label ?? "Generating..."}
        </span>
      </div>
      {status !== "error" && (
        <div className="absolute inset-0 animate-shimmer-scan">
          <div
            className="h-full w-1/2"
            style={{
              background: "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)",
            }}
          />
        </div>
      )}
    </div>
  );
});
