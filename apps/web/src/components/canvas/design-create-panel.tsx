"use client";

import type { DesignTemplateDto } from "@loomic/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { DESIGN_SIZE_PRESETS } from "../../lib/canvas-design";
import { fetchAssetBlob } from "../../lib/canvas-elements";
import { createDesignResourceApiClient } from "../../lib/design-resource-api";

export type BlankDesignInput = {
  requestId: string;
  width: number;
  height: number;
  background: string | null;
  templateId?: string;
};

type DesignCreatePanelProps = {
  onClose: () => void;
  onCreate: (input: BlankDesignInput) => Promise<void>;
  accessToken?: string;
};

const MAX_DESIGN_DIMENSION = 32_768;

export function DesignCreatePanel({
  onClose,
  onCreate,
  accessToken,
}: DesignCreatePanelProps) {
  const [mode, setMode] = useState<"blank" | "template">("blank");
  const [width, setWidth] = useState("1080");
  const [height, setHeight] = useState("1080");
  const [transparent, setTransparent] = useState(false);
  const [background, setBackground] = useState("#ffffff");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attemptIdRef = useRef<string | null>(null);
  const [templates, setTemplates] = useState<DesignTemplateDto[]>([]);
  const [selectedTemplate, setSelectedTemplate] =
    useState<DesignTemplateDto | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    const client = createDesignResourceApiClient();
    void client
      .listTemplates(accessToken, { limit: 12 }, controller.signal)
      .then((page) => setTemplates(page.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, [accessToken]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const resetAttempt = useCallback(() => {
    attemptIdRef.current = null;
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (mode === "template" && !selectedTemplate) {
      setError("请先选择一个模板");
      return;
    }
    const parsedWidth = selectedTemplate?.width ?? Number(width);
    const parsedHeight = selectedTemplate?.height ?? Number(height);
    if (
      !Number.isInteger(parsedWidth) ||
      !Number.isInteger(parsedHeight) ||
      parsedWidth < 1 ||
      parsedHeight < 1 ||
      parsedWidth > MAX_DESIGN_DIMENSION ||
      parsedHeight > MAX_DESIGN_DIMENSION
    ) {
      setError(`宽高必须是 1–${MAX_DESIGN_DIMENSION} 的整数像素`);
      return;
    }

    const requestId = attemptIdRef.current ?? crypto.randomUUID();
    attemptIdRef.current = requestId;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        requestId,
        width: parsedWidth,
        height: parsedHeight,
        background: transparent ? null : background,
        ...(selectedTemplate ? { templateId: selectedTemplate.id } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建设计失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }, [
    background,
    height,
    mode,
    onCreate,
    selectedTemplate,
    transparent,
    width,
  ]);

  return (
    <form
      aria-label="创建空白设计"
      className="w-[360px] rounded-2xl border border-border bg-card p-4 shadow-card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">创建设计</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          关闭
        </button>
      </div>

      {templates.length > 0 && (
        <div className="mb-3 grid grid-cols-2 rounded-lg bg-muted p-1">
          <button
            type="button"
            aria-pressed={mode === "blank"}
            className={`rounded-md py-1.5 text-xs ${mode === "blank" ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
            onClick={() => {
              setMode("blank");
              setSelectedTemplate(null);
              resetAttempt();
            }}
          >
            自定义尺寸
          </button>
          <button
            type="button"
            aria-pressed={mode === "template"}
            className={`rounded-md py-1.5 text-xs ${mode === "template" ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
            onClick={() => {
              setMode("template");
              resetAttempt();
            }}
          >
            模板
          </button>
        </div>
      )}

      {mode === "template" ? (
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              aria-pressed={selectedTemplate?.id === template.id}
              className={`overflow-hidden rounded-lg border text-left ${selectedTemplate?.id === template.id ? "ring-2 ring-foreground" : ""}`}
              onClick={() => {
                setSelectedTemplate(template);
                resetAttempt();
              }}
            >
              <TemplatePreview
                template={template}
                accessToken={accessToken ?? ""}
              />
              <span className="block truncate px-2 pt-1.5 text-xs font-medium">
                {template.name}
              </span>
              <span className="block px-2 pb-2 text-[10px] text-muted-foreground">
                {template.width} × {template.height} px
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {DESIGN_SIZE_PRESETS.map((preset) => (
              <button
                key={`${preset.width}x${preset.height}`}
                type="button"
                onClick={() => {
                  setWidth(String(preset.width));
                  setHeight(String(preset.height));
                  resetAttempt();
                }}
                className="rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-muted"
              >
                <span className="block text-foreground">{preset.label}</span>
                <span className="text-muted-foreground">
                  {preset.width} × {preset.height} px
                </span>
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">
              宽度
              <span className="mt-1 flex items-center rounded-lg border border-border bg-background px-2">
                <input
                  aria-label="设计宽度"
                  inputMode="numeric"
                  value={width}
                  onChange={(event) => {
                    setWidth(event.target.value);
                    resetAttempt();
                  }}
                  className="h-9 min-w-0 flex-1 bg-transparent text-foreground outline-none"
                />
                <span>px</span>
              </span>
            </label>
            <label className="text-xs text-muted-foreground">
              高度
              <span className="mt-1 flex items-center rounded-lg border border-border bg-background px-2">
                <input
                  aria-label="设计高度"
                  inputMode="numeric"
                  value={height}
                  onChange={(event) => {
                    setHeight(event.target.value);
                    resetAttempt();
                  }}
                  className="h-9 min-w-0 flex-1 bg-transparent text-foreground outline-none"
                />
                <span>px</span>
              </span>
            </label>
          </div>

          <div className="mt-3 flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={transparent}
                onChange={(event) => {
                  setTransparent(event.target.checked);
                  resetAttempt();
                }}
              />
              透明背景
            </label>
            <input
              aria-label="背景颜色"
              type="color"
              value={background}
              disabled={transparent}
              onChange={(event) => {
                setBackground(event.target.value);
                resetAttempt();
              }}
              className="h-7 w-10 disabled:opacity-40"
            />
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="mt-3 h-9 w-full rounded-lg bg-foreground text-sm text-background disabled:opacity-50"
      >
        {submitting
          ? "正在创建…"
          : mode === "template"
            ? "使用模板创建"
            : "创建设计"}
      </button>
    </form>
  );
}

function TemplatePreview({
  template,
  accessToken,
}: {
  template: DesignTemplateDto;
  accessToken: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!template.preview_asset_object_id || !accessToken) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetchAssetBlob(accessToken, template.preview_asset_object_id, {
      preview: true,
      signal: controller.signal,
    })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accessToken, template.preview_asset_object_id]);
  return url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="aspect-video w-full object-cover"
    />
  ) : (
    <span className="block aspect-video bg-muted" aria-hidden />
  );
}
