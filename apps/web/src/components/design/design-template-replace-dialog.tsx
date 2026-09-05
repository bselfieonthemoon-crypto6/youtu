"use client";

import type {
  DesignTemplateDetailDto,
  DesignTemplateReplacePreviewRequest,
  DesignTemplateReplacePreviewResponse,
} from "@loomic/shared";
import { Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type Binding = DesignTemplateReplacePreviewRequest["bindings"][number];

export function DesignTemplateReplaceDialog({
  detail,
  preview,
  bindings,
  busy,
  error,
  onBindingsChange,
  onPreview,
  onApply,
  onCancel,
}: {
  detail: DesignTemplateDetailDto;
  preview: DesignTemplateReplacePreviewResponse | null;
  bindings: readonly Binding[];
  busy?: boolean;
  error?: string | null;
  onBindingsChange: (bindings: Binding[]) => void;
  onPreview: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const update = (next: Binding) => {
    onBindingsChange([
      ...bindings.filter((binding) => binding.key !== next.key),
      next,
    ]);
  };
  return (
    <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/30 p-4">
      <dialog
        open
        aria-labelledby="design-template-replace-title"
        className="m-0 flex max-h-[calc(100vh-64px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-float"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <Sparkles className="size-4" />
          <div className="min-w-0 flex-1">
            <h2
              id="design-template-replace-title"
              className="truncate font-medium"
            >
              智能替换 · {detail.template.name}
            </h2>
            <p className="text-xs text-muted-foreground">
              先预览服务端计算的差异，再显式确认应用。
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="关闭智能替换"
            onClick={onCancel}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_280px]">
          <section>
            <h3 className="text-sm font-medium">变量值</h3>
            <div className="mt-2 grid gap-3">
              {detail.template.variables.length === 0 && (
                <p className="rounded-lg border p-3 text-sm text-muted-foreground">
                  此模板尚未定义可替换变量。
                </p>
              )}
              {detail.template.variables.map((variable) => (
                <VariableBindingField
                  key={variable.key}
                  variable={variable}
                  {...(() => {
                    const binding = bindings.find(
                      (item) => item.key === variable.key,
                    );
                    return binding ? { binding } : {};
                  })()}
                  suggested={
                    preview?.differences.find(
                      (difference) => difference.variable_key === variable.key,
                    )?.after
                  }
                  unresolved={Boolean(
                    preview?.unresolved_keys.includes(variable.key),
                  )}
                  onChange={update}
                />
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-medium">变更预览</h3>
            {!preview ? (
              <p className="mt-2 rounded-lg border p-3 text-xs text-muted-foreground">
                点击“重新预览”获取权威 diff。
              </p>
            ) : (
              <div className="mt-2 grid gap-2">
                {preview.unresolved_keys.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                  >
                    缺少必填变量：{preview.unresolved_keys.join("、")}
                  </div>
                )}
                {preview.differences.map((difference) => (
                  <article
                    key={`${difference.object_id}:${difference.property}`}
                    className="rounded-lg border p-2 text-xs"
                  >
                    <div className="flex justify-between gap-2">
                      <strong>{difference.variable_key}</strong>
                      <span className="text-muted-foreground">
                        {sourceLabel(difference.source)}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-muted-foreground">
                      {readable(difference.before)} →{" "}
                      {readable(difference.after)}
                    </p>
                  </article>
                ))}
                {preview.differences.length === 0 &&
                  preview.unresolved_keys.length === 0 && (
                    <p className="rounded-lg border p-3 text-xs text-muted-foreground">
                      当前变量不会产生内容变化。
                    </p>
                  )}
              </div>
            )}
          </section>
        </div>
        {error && (
          <p
            role="alert"
            className="border-t px-4 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <footer className="flex justify-end gap-2 border-t px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onPreview}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            重新预览
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              !preview ||
              preview.unresolved_keys.length > 0 ||
              preview.commands.length === 0
            }
            onClick={onApply}
          >
            确认应用替换
          </Button>
        </footer>
      </dialog>
    </div>
  );
}

function VariableBindingField({
  variable,
  binding,
  suggested,
  unresolved,
  onChange,
}: {
  variable: DesignTemplateDetailDto["template"]["variables"][number];
  binding?: Binding;
  suggested: unknown;
  unresolved?: boolean;
  onChange: (binding: Binding) => void;
}) {
  const fallback = binding?.value ?? suggested ?? variable.default_value;
  return (
    <fieldset
      className={`rounded-xl border p-3 ${unresolved ? "border-destructive/50" : ""}`}
    >
      <legend className="px-1 text-sm font-medium">
        {variable.label}{" "}
        {variable.required && <span className="text-destructive">*</span>}
      </legend>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {variable.key} · {typeLabel(variable.type)} · {variable.target.property}
      </p>
      {variable.type === "text" && (
        <textarea
          aria-label={`${variable.label}文本`}
          value={typeof fallback === "string" ? fallback : ""}
          className="min-h-20 w-full rounded-lg border bg-background p-2 text-sm"
          onChange={(event) =>
            onChange({
              key: variable.key,
              type: "text",
              value: event.currentTarget.value,
            })
          }
        />
      )}
      {variable.type === "color" && (
        <input
          aria-label={`${variable.label}颜色`}
          type="color"
          value={typeof fallback === "string" ? fallback : "#000000"}
          className="h-10 w-full rounded-lg border bg-background p-1"
          onChange={(event) =>
            onChange({
              key: variable.key,
              type: "color",
              value: event.currentTarget.value,
            })
          }
        />
      )}
      {variable.type === "image" && (
        <div className="grid gap-2">
          <input
            aria-label={`${variable.label}资产 ID`}
            value={readRecordString(fallback, "asset_object_id")}
            placeholder="asset_object_id"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            onChange={(event) =>
              onChange({
                key: variable.key,
                type: "image",
                value: {
                  asset_object_id: event.currentTarget.value,
                  resource_id:
                    readRecordString(fallback, "resource_id") || null,
                },
              })
            }
          />
          <input
            aria-label={`${variable.label}资源 ID`}
            value={readRecordString(fallback, "resource_id")}
            placeholder="resource_id（可选）"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            onChange={(event) =>
              onChange({
                key: variable.key,
                type: "image",
                value: {
                  asset_object_id: readRecordString(
                    fallback,
                    "asset_object_id",
                  ),
                  resource_id: event.currentTarget.value || null,
                },
              })
            }
          />
        </div>
      )}
      {variable.type === "font" && (
        <div className="grid gap-2">
          <input
            aria-label={`${variable.label}字体 Face ID`}
            value={readRecordString(fallback, "font_face_id")}
            placeholder="font_face_id"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            onChange={(event) =>
              onChange({
                key: variable.key,
                type: "font",
                value: {
                  font_face_id: event.currentTarget.value,
                  font_family: readRecordString(fallback, "font_family"),
                },
              })
            }
          />
          <input
            aria-label={`${variable.label}字体名称`}
            value={readRecordString(fallback, "font_family")}
            placeholder="字体家族名称"
            className="h-9 rounded-lg border bg-background px-2 text-sm"
            onChange={(event) =>
              onChange({
                key: variable.key,
                type: "font",
                value: {
                  font_face_id: readRecordString(fallback, "font_face_id"),
                  font_family: event.currentTarget.value,
                },
              })
            }
          />
        </div>
      )}
    </fieldset>
  );
}

function readRecordString(value: unknown, key: string) {
  return value &&
    typeof value === "object" &&
    key in value &&
    typeof value[key as keyof typeof value] === "string"
    ? String(value[key as keyof typeof value])
    : "";
}

function typeLabel(type: string) {
  return (
    { text: "文字", image: "图片", color: "颜色", font: "字体" }[type] ?? type
  );
}

function sourceLabel(source: "binding" | "smart" | "default") {
  if (source === "binding") return "手动值";
  if (source === "smart") return "智能匹配";
  return "模板默认值";
}

function readable(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
