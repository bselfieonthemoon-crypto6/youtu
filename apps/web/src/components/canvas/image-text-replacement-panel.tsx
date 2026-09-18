"use client";

import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SelectedCanvasImage } from "./image-toolbar-types";

type TextRow = { id: string; original: string; value: string };

export function ImageTextReplacementPanel({
  image,
  screenBounds,
  onRecognize,
  onApply,
  onCancel,
}: {
  image: SelectedCanvasImage;
  screenBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth?: number;
  };
  onRecognize: () => Promise<string[]>;
  onApply: (
    replacements: Array<{ original: string; replacement: string }>,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<TextRow[]>([]);
  const [recognizing, setRecognizing] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognizeRequestGenerationRef = useRef(0);
  const activeImageGenerationRef = useRef("");
  const onRecognizeRef = useRef(onRecognize);
  onRecognizeRef.current = onRecognize;
  const imageGeneration = [
    image.id,
    image.fileId,
    image.assetId ?? "",
    image.storageUrl ?? "",
  ].join("\0");

  const load = useCallback((requestedImageGeneration: string) => {
    const requestGeneration = ++recognizeRequestGenerationRef.current;
    activeImageGenerationRef.current = requestedImageGeneration;
    setRecognizing(true);
    setError(null);
    setRows([]);
    void onRecognizeRef
      .current()
      .then((texts) => {
        if (
          recognizeRequestGenerationRef.current !== requestGeneration ||
          activeImageGenerationRef.current !== requestedImageGeneration
        )
          return;
        const lines = texts.flatMap((text) => text.split(/\r?\n/)).filter((text) => text.trim());
        setRows(
          (lines.length > 0 ? lines : [""]).map((text) => ({
            id: crypto.randomUUID(),
            original: text,
            value: "",
          })),
        );
      })
      .catch((cause) => {
        if (
          recognizeRequestGenerationRef.current !== requestGeneration ||
          activeImageGenerationRef.current !== requestedImageGeneration
        )
          return;
        setError(
          cause instanceof Error ? cause.message : "图片文字识别失败，请重试。",
        );
      })
      .finally(() => {
        if (
          recognizeRequestGenerationRef.current === requestGeneration &&
          activeImageGenerationRef.current === requestedImageGeneration
        ) {
          setRecognizing(false);
        }
      });
  }, []);

  useEffect(() => {
    load(imageGeneration);
    return () => {
      recognizeRequestGenerationRef.current += 1;
      activeImageGenerationRef.current = "";
    };
  }, [imageGeneration, load]);

  const replacements = useMemo(
    () =>
      rows
        .map((row) => ({
          original: row.original.trim(),
          replacement: row.value.trim(),
        }))
        .filter((row) => row.replacement && row.original !== row.replacement),
    [rows],
  );

  const viewportWidth = Math.min(
    typeof window === "undefined" ? 1024 : window.innerWidth,
    screenBounds.viewportWidth ?? Number.POSITIVE_INFINITY,
  );
  const panelWidth = Math.min(272, viewportWidth - 24);
  const fitsRight =
    screenBounds.x + screenBounds.width + panelWidth + 28 <= viewportWidth;
  const left = fitsRight
    ? screenBounds.x + screenBounds.width + 16
    : Math.max(12, screenBounds.x - panelWidth - 16);
  const windowHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const top = Math.max(12, Math.min(windowHeight - 310, screenBounds.y));

  const apply = async () => {
    if (replacements.length === 0 || applying) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(replacements);
      setApplying(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "文字替换失败，请重试。",
      );
      setApplying(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="替换图片文字"
      className="fixed z-[100] overflow-y-auto rounded-2xl border border-border bg-background p-3 shadow-xl"
      style={{ left, top, width: panelWidth, maxHeight: Math.max(120, windowHeight - top - 12) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2">
        <h3 className="text-sm font-semibold">替换图片文字</h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          对照识别原文填写替换文字，留空则保持不变
        </p>
      </div>
      {(image.dataUrl || image.storageUrl) && (
        <img src={image.dataUrl || image.storageUrl} alt="待替换文字的原图"
          className="mb-3 max-h-32 w-full rounded-lg object-contain" />
      )}
      {recognizing ? (
        <div className="flex h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          正在识别文字…
        </div>
      ) : error ? (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => load(imageGeneration)}
          >
            重新识别
          </button>
        </div>
      ) : (
        <div
          data-replacement-rows
          className="grid min-w-0 max-w-full max-h-48 gap-1.5 overflow-x-hidden overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {rows.map((row) => (
            <div key={row.id} className="min-w-0 max-w-full rounded-lg border border-border p-2">
              <div className="mb-1 text-[11px] text-muted-foreground">识别原文</div>
              <p className="mb-2 whitespace-pre-wrap break-words text-sm select-text">
                {row.original || "未识别到原文，可手动添加文字"}
              </p>
              <div className="flex min-w-0 gap-1.5">
              <input
                aria-label={
                  row.original ? `替换 ${row.original}` : "新增替换文字"
                }
                value={row.value}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.id === row.id
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
                className="min-w-0 flex-1 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40"
                placeholder="输入替换后的文字"
              />
              <button
                type="button"
                aria-label="删除文字"
                onClick={() =>
                  setRows((current) =>
                    current.filter((item) => item.id !== row.id),
                  )
                }
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              >
                <Trash2 className="size-4" />
              </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setRows((current) => [
                ...current,
                { id: crypto.randomUUID(), original: "", value: "" },
              ])
            }
            className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-border py-2 text-xs text-muted-foreground hover:bg-muted"
          >
            <Plus className="size-3.5" />
            添加文字
          </button>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-border px-3 py-1.5 text-xs"
        >
          取消
        </button>
        <button
          type="button"
          disabled={
            recognizing || applying || !!error || replacements.length === 0
          }
          onClick={() => void apply()}
          className="flex-1 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-40"
        >
          应用
        </button>
      </div>
    </div>
  );
}
