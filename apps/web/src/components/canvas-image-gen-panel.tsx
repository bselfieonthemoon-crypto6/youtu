"use client";

import { useCallback, useRef, useState } from "react";

import type { ImageArtifact } from "@loomic/shared";

import { generateImageDirect } from "../lib/server-api";
import { insertImageOnCanvas } from "../lib/canvas-elements";
import { useGenerationErrorHandler } from "../hooks/use-generation-error-handler";

type CanvasImageGenPanelProps = {
  accessToken: string;
  excalidrawApi: any;
  onClose: () => void;
};

export function CanvasImageGenPanel({
  accessToken,
  excalidrawApi,
  onClose,
}: CanvasImageGenPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [preparedPrompt, setPreparedPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const { handleGenerationError } = useGenerationErrorHandler();

  const handleGenerate = useCallback(async () => {
    if (!preparedPrompt || loading) return;
    setLoading(true);
    setError(null);

    try {
      const result = await generateImageDirect(accessTokenRef.current, preparedPrompt);

      if (excalidrawApi) {
        const artifact: ImageArtifact = {
          type: "image",
          url: result.url,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
        };
        await insertImageOnCanvas(excalidrawApi, artifact);
      }

      setPrompt("");
      setPreparedPrompt(null);
    } catch (err) {
      const handled = handleGenerationError(err);
      if (!handled) {
        setError(err instanceof Error ? err.message : "Generation failed");
      }
    } finally {
      setLoading(false);
    }
  }, [preparedPrompt, loading, excalidrawApi, handleGenerationError]);

  const prepareGeneration = useCallback(() => {
    const description = prompt.trim();
    if (!description || loading) return;
    setPreparedPrompt(description);
    setError(null);
  }, [prompt, loading]);

  return (
    <div className="w-80 rounded-xl bg-card shadow-xl border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">AI Image</h3>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setPreparedPrompt(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            prepareGeneration();
          }
        }}
        placeholder="Describe the image you want to create..."
        className="w-full h-20 resize-none rounded-lg border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        disabled={loading}
      />

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {preparedPrompt ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-foreground">
          <p className="text-xs leading-5">准备生成一张这样的图片：</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
            {preparedPrompt}
          </p>
          <p className="mt-2 text-xs font-medium">是否确认生成？</p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPreparedPrompt(null)}
              disabled={loading}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs disabled:opacity-50"
            >
              返回修改
            </button>
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={loading}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              {loading ? "生成中…" : "确认生成"}
            </button>
          </div>
        </div>
      ) : null}

      {!preparedPrompt ? (
        <button
          onClick={prepareGeneration}
          disabled={!prompt.trim() || loading}
          className="mt-3 w-full rounded-lg bg-foreground text-background py-2 text-sm font-medium transition-opacity disabled:opacity-40 hover:opacity-90"
        >
          查看生成描述
        </button>
      ) : null}
    </div>
  );
}
