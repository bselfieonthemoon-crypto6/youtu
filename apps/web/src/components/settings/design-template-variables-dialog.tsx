"use client";

import type {
  DesignTemplateDetailDto,
  DesignTemplateVariable,
} from "@loomic/shared";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type DraftVariable = {
  key: string;
  label: string;
  type: "text" | "image" | "color" | "font";
  objectId: string;
  property: "text" | "asset_object_id" | "fill" | "stroke" | "font_face_id";
  required: boolean;
  defaultPrimary: string;
  defaultSecondary: string;
};

export function DesignTemplateVariablesDialog({
  detail,
  busy,
  error,
  onSave,
  onCancel,
}: {
  detail: DesignTemplateDetailDto;
  busy?: boolean;
  error?: string | null;
  onSave: (variables: DesignTemplateVariable[]) => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<DraftVariable[]>(() =>
    detail.template.variables.map(toDraft),
  );
  const update = (index: number, patch: Partial<DraftVariable>) =>
    setDrafts((current) =>
      current.map((draft, candidate) =>
        candidate === index ? normalizeDraft({ ...draft, ...patch }) : draft,
      ),
    );
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/30 p-4">
      <dialog
        open
        aria-labelledby="template-variables-title"
        className="m-0 flex max-h-[calc(100vh-48px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-float"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="template-variables-title" className="truncate font-medium">
              模板变量 · {detail.template.name}
            </h2>
            <p className="text-xs text-muted-foreground">
              绑定模板内对象属性；保存使用 revision CAS。
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="关闭模板变量"
            onClick={onCancel}
          >
            <X />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-3">
            {drafts.map((draft, index) => (
              <fieldset
                key={`${index}:${draft.key}`}
                className="grid gap-2 rounded-xl border p-3 sm:grid-cols-2 lg:grid-cols-4"
              >
                <legend className="px-1 text-xs text-muted-foreground">
                  变量 {index + 1}
                </legend>
                <Field label="Key">
                  <input
                    value={draft.key}
                    onChange={(event) =>
                      update(index, { key: event.currentTarget.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="显示名称">
                  <input
                    value={draft.label}
                    onChange={(event) =>
                      update(index, { label: event.currentTarget.value })
                    }
                    className={inputClass}
                  />
                </Field>
                <Field label="类型">
                  <select
                    value={draft.type}
                    onChange={(event) =>
                      update(index, {
                        type: event.currentTarget
                          .value as DraftVariable["type"],
                      })
                    }
                    className={inputClass}
                  >
                    <option value="text">文字</option>
                    <option value="image">图片</option>
                    <option value="color">颜色</option>
                    <option value="font">字体</option>
                  </select>
                </Field>
                <Field label="目标属性">
                  <select
                    value={draft.property}
                    onChange={(event) =>
                      update(index, {
                        property: event.currentTarget
                          .value as DraftVariable["property"],
                      })
                    }
                    className={inputClass}
                  >
                    {propertiesFor(draft.type).map((property) => (
                      <option key={property} value={property}>
                        {property}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="目标对象">
                  <select
                    value={draft.objectId}
                    onChange={(event) =>
                      update(index, { objectId: event.currentTarget.value })
                    }
                    className={inputClass}
                  >
                    <option value="">选择对象</option>
                    {compatibleObjects(detail, draft.type, draft.property).map(
                      (object) => (
                        <option key={object.objectId} value={object.objectId}>
                          {object.name || object.type} ·{" "}
                          {object.objectId.slice(0, 8)}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
                <Field
                  label={
                    draft.type === "font"
                      ? "默认 Face ID"
                      : draft.type === "image"
                        ? "默认资产 ID"
                        : "默认值（可空）"
                  }
                >
                  <input
                    type={draft.type === "color" ? "color" : "text"}
                    value={draft.defaultPrimary}
                    onChange={(event) =>
                      update(index, {
                        defaultPrimary: event.currentTarget.value,
                      })
                    }
                    className={inputClass}
                  />
                </Field>
                {(draft.type === "image" || draft.type === "font") && (
                  <Field
                    label={
                      draft.type === "image"
                        ? "默认资源 ID（可空）"
                        : "默认字体名称"
                    }
                  >
                    <input
                      value={draft.defaultSecondary}
                      onChange={(event) =>
                        update(index, {
                          defaultSecondary: event.currentTarget.value,
                        })
                      }
                      className={inputClass}
                    />
                  </Field>
                )}
                <div className="flex items-end justify-between gap-2">
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.required}
                      onChange={(event) =>
                        update(index, { required: event.currentTarget.checked })
                      }
                    />
                    必填
                  </label>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`删除变量 ${index + 1}`}
                    onClick={() =>
                      setDrafts((current) =>
                        current.filter((_, candidate) => candidate !== index),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDrafts((current) => [...current, emptyDraft(detail)])
              }
            >
              <Plus />
              添加变量
            </Button>
          </div>
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
            disabled={busy}
            onClick={() => onSave(drafts.map(toVariable))}
          >
            保存变量
          </Button>
        </footer>
      </dialog>
    </div>
  );
}

const inputClass = "h-9 min-w-0 rounded-lg border bg-background px-2 text-sm";

function Field({
  label,
  children,
}: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-1 text-xs">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

function propertiesFor(
  type: DraftVariable["type"],
): DraftVariable["property"][] {
  if (type === "text") return ["text"];
  if (type === "image") return ["asset_object_id"];
  if (type === "font") return ["font_face_id"];
  return ["fill", "stroke"];
}

function normalizeDraft(draft: DraftVariable): DraftVariable {
  const allowed = propertiesFor(draft.type);
  return allowed.includes(draft.property)
    ? draft
    : { ...draft, property: allowed[0] ?? "text" };
}

function compatibleObjects(
  detail: DesignTemplateDetailDto,
  type: DraftVariable["type"],
  property: DraftVariable["property"],
) {
  return detail.scene.objects.filter((object) => {
    if (type === "text" || type === "font")
      return object.type === "text" || object.type === "textbox";
    if (type === "image") return object.type === "image";
    return property === "fill" ? "fill" in object : "stroke" in object;
  });
}

function emptyDraft(detail: DesignTemplateDetailDto): DraftVariable {
  const firstText = detail.scene.objects.find(
    (object) => object.type === "text" || object.type === "textbox",
  );
  return {
    key: `variable_${detail.template.variables.length + 1}`,
    label: "新变量",
    type: "text",
    objectId: firstText?.objectId ?? "",
    property: "text",
    required: false,
    defaultPrimary: "",
    defaultSecondary: "",
  };
}

function toDraft(variable: DesignTemplateVariable): DraftVariable {
  const base = {
    key: variable.key,
    label: variable.label,
    type: variable.type,
    objectId: variable.target.object_id,
    property: variable.target.property,
    required: variable.required,
  };
  if (variable.type === "text" || variable.type === "color") {
    return {
      ...base,
      defaultPrimary: variable.default_value ?? "",
      defaultSecondary: "",
    };
  }
  if (variable.type === "image") {
    return {
      ...base,
      defaultPrimary: variable.default_value?.asset_object_id ?? "",
      defaultSecondary: variable.default_value?.resource_id ?? "",
    };
  }
  return {
    ...base,
    defaultPrimary: variable.default_value?.font_face_id ?? "",
    defaultSecondary: variable.default_value?.font_family ?? "",
  };
}

function toVariable(draft: DraftVariable): DesignTemplateVariable {
  const base = {
    key: draft.key.trim(),
    label: draft.label.trim(),
    required: draft.required,
  };
  if (draft.type === "text")
    return {
      ...base,
      type: "text",
      target: { object_id: draft.objectId, property: "text" },
      ...(draft.defaultPrimary ? { default_value: draft.defaultPrimary } : {}),
    };
  if (draft.type === "color")
    return {
      ...base,
      type: "color",
      target: {
        object_id: draft.objectId,
        property: draft.property === "stroke" ? "stroke" : "fill",
      },
      ...(draft.defaultPrimary ? { default_value: draft.defaultPrimary } : {}),
    };
  if (draft.type === "image")
    return {
      ...base,
      type: "image",
      target: { object_id: draft.objectId, property: "asset_object_id" },
      ...(draft.defaultPrimary
        ? {
            default_value: {
              asset_object_id: draft.defaultPrimary,
              resource_id: draft.defaultSecondary || null,
            },
          }
        : {}),
    };
  return {
    ...base,
    type: "font",
    target: { object_id: draft.objectId, property: "font_face_id" },
    ...(draft.defaultPrimary && draft.defaultSecondary
      ? {
          default_value: {
            font_face_id: draft.defaultPrimary,
            font_family: draft.defaultSecondary,
          },
        }
      : {}),
  };
}
