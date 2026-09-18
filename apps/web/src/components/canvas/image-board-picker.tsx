"use client";

import { useEffect } from "react";
import type { SelectedCanvasImage } from "./image-toolbar-types";
import {
  classifyImageBoardPlacement,
  type ImageBoardTarget,
  type ImageBoardRelation,
} from "../../lib/image-board-placement";

export type { ImageBoardTarget } from "../../lib/image-board-placement";

export type ImageBoardPickerProps = {
  image: SelectedCanvasImage;
  boards: ImageBoardTarget[];
  busy: boolean;
  error?: string;
  onChoose: (board: ImageBoardTarget, mode: "copy" | "adopt") => void;
  onCreate: () => void;
  onClose: () => void;
  onHighlight: (board: ImageBoardTarget | null) => void;
};

function actionFor(relation: ImageBoardRelation) {
  if (relation === "fully-contained") return { mode: "adopt" as const, label: "加入此画板", description: "保留图片当前位置" };
  if (relation === "center-inside") return { mode: "copy" as const, label: "复制并适配", description: "图片超出边界，加入会改变可见范围" };
  return { mode: "copy" as const, label: "添加到画板", description: "复制图片并按画板尺寸适配" };
}

/** Explicit board target picker for an image selected on the infinite canvas. */
export function ImageBoardPicker({ image, boards, busy, error, onChoose, onCreate, onClose, onHighlight }: ImageBoardPickerProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      onHighlight(null);
    };
  }, [busy, onClose, onHighlight]);

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="选择图片目标画板"
      className="fixed inset-x-4 bottom-4 z-[110] mx-auto max-w-lg rounded-2xl border border-border bg-background p-4 shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[420px]"
      onPointerLeave={() => onHighlight(null)}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">添加图片到设计画板</h2>
          <p className="mt-1 text-xs text-muted-foreground">选择目标后才会执行，不会自动复制图片。</p>
        </div>
        <button type="button" aria-label="关闭" disabled={busy} onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">×</button>
      </div>

      {error ? <p role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto" aria-label="可选画板">
        {boards.map((board) => {
          const relation = classifyImageBoardPlacement(board, image);
          const action = actionFor(relation);
          return (
            <div
              key={board.elementId}
              className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 transition-colors hover:border-primary/50 hover:bg-muted/40"
              onPointerEnter={() => onHighlight(board)}
              onFocus={() => onHighlight(board)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{board.name || "未命名画板"}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">画板显示范围 · {action.description}</p>
              </div>
              {board.locked ? <span className="text-[11px] text-muted-foreground">已锁定</span> : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onChoose(board, action.mode)}
                  className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "处理中…" : action.label}
                </button>
              )}
            </div>
          );
        })}
        {boards.length === 0 ? <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">还没有可用画板。先创建一个设计画板。</p> : null}
      </div>

      <div className="mt-3 flex justify-between gap-2 border-t border-border pt-3">
        <button type="button" disabled={busy} onClick={onCreate} className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">新建画板</button>
        <button type="button" disabled={busy} onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50">取消</button>
      </div>
    </section>
  );
}

export default ImageBoardPicker;
