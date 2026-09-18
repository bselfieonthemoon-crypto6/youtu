"use client";

import type { DesignObject } from "@loomic/shared";
import {
  Copy,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Replace,
  Trash2,
  Ungroup,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { UpdateFabricObjectPatch } from "./fabric-object-editor";
import { ANIMATION_CONTROL_EVENT, ANIMATION_STATUS_EVENT } from "../../lib/design-animation-events";

export type DesignPropertiesActions = {
  updateObject: (objectId: string, patch: UpdateFabricObjectPatch) => void;
  removeSelection: () => void;
  flip: (axis: "horizontal" | "vertical") => void;
  align: (
    alignment:
      | "left"
      | "horizontal_center"
      | "right"
      | "top"
      | "vertical_center"
      | "bottom",
  ) => void;
  distribute: (direction: "horizontal" | "vertical") => void;
  group: () => void;
  ungroup: () => void;
  cloneSelection?: () => void;
  requestReplaceAsset?: () => void;
};

type TextFieldDraftEntry = {
  value: string;
  committed: boolean;
};

type TextFieldDraftStore = {
  objectId: string;
  entries: Map<string, TextFieldDraftEntry>;
};

const TextFieldDraftContext = createContext<TextFieldDraftStore | null>(null);

function ProportionalScale({object, actions}: {object: DesignObject; actions: DesignPropertiesActions}) {
  const base = useRef({width: object.width, height: object.height});
  const applied = useRef(base.current);
  const [percent, setPercent] = useState(100);
  useEffect(() => {
    // Manual resizing or undo establishes a new baseline; our own updates do not compound.
    if (Math.abs(object.width - applied.current.width) > 0.01 || Math.abs(object.height - applied.current.height) > 0.01) {
      base.current = {width: object.width, height: object.height};
      applied.current = base.current;
      setPercent(100);
    }
  }, [object.width, object.height]);
  return <label className="col-span-2 grid gap-2 rounded-lg border p-2 text-xs">
    <span className="flex justify-between"><span>等比缩放</span><span>{percent}%</span></span>
    <input aria-label="对象等比缩放" type="range" min={10} max={300} step={1}
      value={percent} disabled={object.locked} className="w-full accent-primary"
      onChange={event => {
        const next = Number(event.currentTarget.value);
        const dimensions = {width: base.current.width * next / 100, height: base.current.height * next / 100};
        applied.current = dimensions;
        setPercent(next);
        actions.updateObject(object.objectId, dimensions);
      }} />
    <span className="text-muted-foreground">以当前尺寸为 100%，保持宽高比例</span>
  </label>;
}

export function DesignPropertiesPanel({
  selectedObjects,
  actions,
}: {
  selectedObjects: readonly DesignObject[];
  actions: DesignPropertiesActions;
}) {
  const textFieldDraftsRef = useRef(new Map<string, TextFieldDraftEntry>());
  const selected =
    selectedObjects.length === 1 ? selectedObjects[0] : undefined;
  return (
    <section className="shrink-0 border-b p-3" aria-label="对象属性">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted-foreground">对象属性</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除所选对象"
          title="删除"
          disabled={selectedObjects.length === 0}
          onClick={actions.removeSelection}
        >
          <Trash2 />
        </Button>
      </div>
      {selected ? (
        <TextFieldDraftContext.Provider
          value={{
            objectId: selected.objectId,
            entries: textFieldDraftsRef.current,
          }}
        >
          <SingleObjectProperties
            key={selected.objectId}
            object={selected}
            actions={actions}
          />
        </TextFieldDraftContext.Provider>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">
          {selectedObjects.length > 1
            ? `已选择 ${selectedObjects.length} 个对象`
            : "选择一个对象后可编辑属性"}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        <SmallAction
          label="左对齐"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("left")}
        />
        <SmallAction
          label="水平居中"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("horizontal_center")}
        />
        <SmallAction
          label="右对齐"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("right")}
        />
        <SmallAction
          label="顶对齐"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("top")}
        />
        <SmallAction
          label="垂直居中"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("vertical_center")}
        />
        <SmallAction
          label="底对齐"
          disabled={selectedObjects.length < 2}
          onClick={() => actions.align("bottom")}
        />
        <SmallAction
          label="水平分布"
          disabled={selectedObjects.length < 3}
          onClick={() => actions.distribute("horizontal")}
        />
        <SmallAction
          label="垂直分布"
          disabled={selectedObjects.length < 3}
          onClick={() => actions.distribute("vertical")}
        />
      </div>
      <div className="mt-2 flex gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="复制所选对象"
          disabled={selectedObjects.length === 0 || !actions.cloneSelection}
          onClick={actions.cloneSelection}
        >
          <Copy />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="替换所选图片"
          disabled={
            (selected?.type !== "image" && selected?.type !== "svg") ||
            !actions.requestReplaceAsset
          }
          onClick={actions.requestReplaceAsset}
        >
          <Replace />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedObjects.length < 2}
          onClick={actions.group}
        >
          <Group />
          组合
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selected?.type !== "group"}
          onClick={actions.ungroup}
        >
          <Ungroup />
          解组
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="水平翻转"
          disabled={selectedObjects.length === 0}
          onClick={() => actions.flip("horizontal")}
        >
          <FlipHorizontal2 />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="垂直翻转"
          disabled={selectedObjects.length === 0}
          onClick={() => actions.flip("vertical")}
        >
          <FlipVertical2 />
        </Button>
      </div>
    </section>
  );
}

function SingleObjectProperties({
  object,
  actions,
}: { object: DesignObject; actions: DesignPropertiesActions }) {
  const [draft, setDraft] = useState(() => draftFor(object));
  useEffect(() => setDraft(draftFor(object)), [object]);
  const updateShadow = (
    patch: Partial<{
      color: string;
      blur: number;
      offsetX: number;
      offsetY: number;
      opacity: number;
    }>,
  ) => {
    const current =
      "shadow" in object && object.shadow
        ? object.shadow
        : {
            color: "#000000",
            blur: 12,
            offsetX: 0,
            offsetY: 4,
            opacity: 0.25,
          };
    actions.updateObject(object.objectId, {
      shadow: { ...current, ...patch },
    });
  };
  const commitNumber = (
    key: "x" | "y" | "width" | "height" | "rotation" | "opacity",
    rawValue: string,
  ) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return setDraft(draftFor(object));
    if ((key === "width" || key === "height") && value <= 0)
      return setDraft(draftFor(object));
    if (key === "opacity" && (value < 0 || value > 100))
      return setDraft(draftFor(object));
    actions.updateObject(object.objectId, {
      [key]: key === "opacity" ? value / 100 : value,
    });
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <TextField
        label="名称"
        value={draft.name}
        className="col-span-2"
        onChange={(name) => setDraft((v) => ({ ...v, name }))}
        onCommit={(value) =>
          value.trim() &&
          actions.updateObject(object.objectId, { name: value.trim() })
        }
      />
      {(["x", "y", "width", "height", "rotation", "opacity"] as const).map(
        (key) => (
          <TextField
            key={key}
            label={
              {
                x: "X",
                y: "Y",
                width: "宽",
                height: "高",
                rotation: "角度",
                opacity: "透明度 %",
              }[key]
            }
            value={draft[key]}
            type="number"
            onChange={(value) => setDraft((v) => ({ ...v, [key]: value }))}
            onCommit={(value) => commitNumber(key, value)}
          />
        ),
      )}
      <ProportionalScale object={object} actions={actions} />
      <AnimationProperties object={object} actions={actions} />
      {(object.type === "text" || object.type === "textbox") && (
        <>
          <TextField
            label="文字"
            value={draft.text}
            className="col-span-2"
            onChange={(text) => setDraft((v) => ({ ...v, text }))}
            onCommit={(value) =>
              actions.updateObject(object.objectId, { text: value })
            }
          />
          <TextField
            label="字体"
            value={draft.fontFamily}
            onChange={(fontFamily) => setDraft((v) => ({ ...v, fontFamily }))}
            onCommit={(value) =>
              value.trim() &&
              actions.updateObject(object.objectId, {
                fontFamily: value.trim(),
              })
            }
          />
          <TextField
            label="字号"
            value={draft.fontSize}
            type="number"
            onChange={(fontSize) => setDraft((v) => ({ ...v, fontSize }))}
            onCommit={(value) =>
              Number(value) > 0 &&
              actions.updateObject(object.objectId, {
                fontSize: Number(value),
              })
            }
          />
          <TextField
            label="字重"
            value={draft.fontWeight}
            onChange={(fontWeight) =>
              setDraft((value) => ({ ...value, fontWeight }))
            }
            onCommit={(value) =>
              value.trim() &&
              actions.updateObject(object.objectId, {
                fontWeight: /^\d+$/.test(value) ? Number(value) : value,
              })
            }
          />
          <label className="grid gap-1 text-xs">
            字形
            <select
              className="h-8 rounded-md border bg-background px-2"
              value={draft.fontStyle}
              onChange={(event) => {
                const fontStyle = event.currentTarget.value as
                  | "normal"
                  | "italic"
                  | "oblique";
                setDraft((value) => ({ ...value, fontStyle }));
                actions.updateObject(object.objectId, { fontStyle });
              }}
            >
              <option value="normal">常规</option>
              <option value="italic">斜体</option>
              <option value="oblique">倾斜</option>
            </select>
          </label>
          <TextField
            label="行高"
            type="number"
            value={draft.lineHeight}
            onChange={(lineHeight) =>
              setDraft((value) => ({ ...value, lineHeight }))
            }
            onCommit={(value) =>
              Number(value) > 0 &&
              actions.updateObject(object.objectId, {
                lineHeight: Number(value),
              })
            }
          />
          <TextField
            label="字间距"
            type="number"
            value={draft.charSpacing}
            onChange={(charSpacing) =>
              setDraft((value) => ({ ...value, charSpacing }))
            }
            onCommit={(value) =>
              Number.isFinite(Number(value)) &&
              actions.updateObject(object.objectId, {
                charSpacing: Number(value),
              })
            }
          />
          <label className="grid gap-1 text-xs">
            对齐
            <select
              className="h-8 rounded-md border bg-background px-2"
              value={draft.textAlign}
              onChange={(event) => {
                const textAlign = event.currentTarget.value as
                  | "left"
                  | "center"
                  | "right"
                  | "justify";
                setDraft((v) => ({ ...v, textAlign }));
                actions.updateObject(object.objectId, { textAlign });
              }}
            >
              <option value="left">左</option>
              <option value="center">中</option>
              <option value="right">右</option>
              <option value="justify">两端</option>
            </select>
          </label>
        </>
      )}
      {"fill" in object && (
        <label className="grid gap-1 text-xs">
          填充色
          <input
            type="color"
            aria-label="对象填充色"
            className="h-8 w-full rounded-md border bg-background p-1"
            value={draft.fillColor}
            onChange={(event) => {
              const fillColor = event.currentTarget.value;
              setDraft((value) => ({ ...value, fillColor }));
              actions.updateObject(object.objectId, {
                fill: { kind: "solid", color: fillColor },
              });
            }}
          />
        </label>
      )}
      {(object.type === "image" || "stroke" in object) && (
        <>
          <label className="grid gap-1 text-xs">
            描边色
            <input
              type="color"
              aria-label="对象描边色"
              className="h-8 w-full rounded-md border bg-background p-1"
              value={draft.strokeColor}
              onChange={(event) => {
                const strokeColor = event.currentTarget.value;
                setDraft((value) => ({ ...value, strokeColor }));
                actions.updateObject(object.objectId, {
                  stroke: { kind: "solid", color: strokeColor },
                });
              }}
            />
          </label>
          <TextField
            label="描边宽度"
            type="number"
            value={draft.strokeWidth}
            onChange={(strokeWidth) =>
              setDraft((value) => ({ ...value, strokeWidth }))
            }
            onCommit={(value) =>
              Number(value) >= 0 &&
              actions.updateObject(object.objectId, {
                strokeWidth: Number(value),
              })
            }
          />
          <label className="col-span-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.shadow}
              onChange={(event) => {
                const shadow = event.currentTarget.checked;
                setDraft((value) => ({ ...value, shadow }));
                actions.updateObject(object.objectId, {
                  shadow: shadow
                    ? {
                        color: "#000000",
                        blur: 12,
                        offsetX: 0,
                        offsetY: 4,
                        opacity: 0.25,
                      }
                    : null,
                });
              }}
            />
            阴影
          </label>
          {draft.shadow && (
            <>
              <label className="grid gap-1 text-xs">
                阴影色
                <input
                  type="color"
                  aria-label="阴影色"
                  className="h-8 w-full rounded-md border bg-background p-1"
                  value={draft.shadowColor}
                  onChange={(event) => {
                    const shadowColor = event.currentTarget.value;
                    setDraft((value) => ({ ...value, shadowColor }));
                    updateShadow({ color: shadowColor });
                  }}
                />
              </label>
              {(
                [
                  ["shadowBlur", "阴影模糊", "blur"],
                  ["shadowOffsetX", "阴影 X", "offsetX"],
                  ["shadowOffsetY", "阴影 Y", "offsetY"],
                  ["shadowOpacity", "阴影透明度 %", "opacity"],
                ] as const
              ).map(([draftKey, label, shadowKey]) => (
                <TextField
                  key={draftKey}
                  label={label}
                  type="number"
                  value={draft[draftKey]}
                  onChange={(value) =>
                    setDraft((current) => ({ ...current, [draftKey]: value }))
                  }
                  onCommit={(rawValue) => {
                    const value = Number(rawValue);
                    if (!Number.isFinite(value)) return;
                    if (shadowKey === "blur" && value < 0) return;
                    if (shadowKey === "opacity" && (value < 0 || value > 100))
                      return;
                    updateShadow({
                      [shadowKey]:
                        shadowKey === "opacity" ? value / 100 : value,
                    });
                  }}
                />
              ))}
            </>
          )}
        </>
      )}
      {object.type === "image" && (
        <>
          <label className="col-span-2 grid gap-1 text-xs">
            图片适应
            <select
              className="h-8 rounded-md border bg-background px-2"
              value={draft.fit}
              onChange={(event) => {
                const fit = event.currentTarget.value as
                  | "contain"
                  | "cover"
                  | "fill"
                  | "original";
                setDraft((v) => ({ ...v, fit }));
                actions.updateObject(object.objectId, { fit });
              }}
            >
              <option value="contain">完整显示</option>
              <option value="cover">铺满裁切</option>
              <option value="fill">拉伸</option>
              <option value="original">原始尺寸</option>
            </select>
          </label>
          <ImageAdvancedProperties object={object} actions={actions} />
        </>
      )}
    </div>
  );
}

function AnimationProperties({
  object,
  actions,
}: {
  object: DesignObject;
  actions: DesignPropertiesActions;
}) {
  const animation = object.animation;
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const status = (event: Event) => { const detail = (event as CustomEvent).detail;
      if (detail?.ids?.includes(object.objectId)) setPlaying(detail.playing === true); };
    window.addEventListener(ANIMATION_STATUS_EVENT, status);
    window.dispatchEvent(new CustomEvent(ANIMATION_CONTROL_EVENT, { detail: { objectId: object.objectId, action: "query" } }));
    return () => window.removeEventListener(ANIMATION_STATUS_EVENT, status);
  }, [object.objectId]);
  const [type, setType] = useState<"" | "float" | "scale">(
    animation?.type ?? "",
  );
  const [durationSeconds, setDurationSeconds] = useState(
    String((animation?.durationMs ?? 2000) / 1000),
  );
  const [amount, setAmount] = useState(String(animation?.amount ?? 10));

  useEffect(() => {
    setType(animation?.type ?? "");
    setDurationSeconds(String((animation?.durationMs ?? 2000) / 1000));
    setAmount(String(animation?.amount ?? 10));
  }, [animation]);

  const commit = (next: {
    type?: "float" | "scale";
    durationSeconds?: string;
    amount?: string;
  }) => {
    const nextType = next.type ?? type;
    if (!nextType) return;
    const durationMs = Math.min(
      10_000,
      Math.max(
        500,
        Math.round(Number(next.durationSeconds ?? durationSeconds) * 1000),
      ),
    );
    const nextAmount = Math.min(
      100,
      Math.max(1, Math.round(Number(next.amount ?? amount))),
    );
    if (!Number.isFinite(durationMs) || !Number.isFinite(nextAmount)) return;
    actions.updateObject(object.objectId, {
      animation: { type: nextType, durationMs, amount: nextAmount },
    });
  };

  return (
    <div className="col-span-2 grid grid-cols-2 gap-2 rounded-lg border p-2">
      <label className="col-span-2 grid gap-1 text-xs">
        动画
        <select
          aria-label="动画"
          className="h-8 rounded-md border bg-background px-2"
          value={type}
          onChange={(event) => {
            const nextType = event.currentTarget.value as
              | ""
              | "float"
              | "scale";
            setType(nextType);
            if (!nextType) {
              actions.updateObject(object.objectId, { animation: null });
              return;
            }
            commit({ type: nextType });
          }}
        >
          <option value="">无</option>
          <option value="float">上下浮动</option>
          <option value="scale">放大缩小</option>
        </select>
      </label>
      {type && (
        <>
          <label className="grid gap-1 text-xs">
            时长（秒）
            <input
              aria-label="动画时长（秒）"
              className="h-8 min-w-0 rounded-md border bg-background px-2"
              type="number"
              min={0.5}
              max={10}
              step={0.1}
              value={durationSeconds}
              onChange={(event) =>
                setDurationSeconds(event.currentTarget.value)
              }
              onBlur={() => commit({ durationSeconds })}
            />
          </label>
          <label className="grid gap-1 text-xs">
            {type === "float" ? "幅度（像素）" : "幅度（%）"}
            <input
              aria-label={
                type === "float" ? "动画幅度（像素）" : "动画幅度（%）"
              }
              className="h-8 min-w-0 rounded-md border bg-background px-2"
              type="number"
              min={1}
              max={100}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.currentTarget.value)}
              onBlur={() => commit({ amount })}
            />
          </label>
          <p className="col-span-2 text-[11px] text-muted-foreground">
            <button type="button" className="mb-2 rounded border px-3 py-1 text-foreground" onClick={() => window.dispatchEvent(new CustomEvent(ANIMATION_CONTROL_EVENT, { detail: { objectId: object.objectId, action: "toggle" } }))}>{playing ? "暂停" : "播放"}</button>
            <br />可实时预览；退出编辑后也可在画布播放。静态导出不受影响。
          </p>
        </>
      )}
    </div>
  );
}

function ImageAdvancedProperties({
  object,
  actions,
}: {
  object: Extract<DesignObject, { type: "image" }>;
  actions: DesignPropertiesActions;
}) {
  const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const updateCrop = (
    key: "x" | "y" | "width" | "height",
    rawValue: number,
  ) => {
    const next = { ...crop };
    if (key === "x") next.x = Math.min(Math.max(rawValue, 0), 1 - next.width);
    if (key === "y") next.y = Math.min(Math.max(rawValue, 0), 1 - next.height);
    if (key === "width")
      next.width = Math.min(Math.max(rawValue, 0.01), 1 - next.x);
    if (key === "height")
      next.height = Math.min(Math.max(rawValue, 0.01), 1 - next.y);
    actions.updateObject(object.objectId, { crop: next });
  };
  const updateFilter = (
    key: "brightness" | "contrast" | "saturation" | "blur",
    value: number,
  ) =>
    actions.updateObject(object.objectId, {
      filters: { ...(object.filters ?? {}), [key]: value },
    });
  return (
    <div className="col-span-2 grid grid-cols-2 gap-2 rounded-lg border p-2">
      <div className="col-span-2 flex items-center justify-between">
        <span className="text-xs font-medium">图片高级编辑</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            actions.updateObject(object.objectId, {
              crop: null,
              mask: null,
              filters: null,
            })
          }
        >
          重置效果
        </Button>
      </div>
      {(["x", "y", "width", "height"] as const).map((key) => (
        <NormalizedCropField
          key={key}
          label={
            {
              x: "裁剪 X %",
              y: "裁剪 Y %",
              width: "裁剪宽 %",
              height: "裁剪高 %",
            }[key]
          }
          value={crop[key]}
          positive={key === "width" || key === "height"}
          onCommit={(value) => updateCrop(key, value)}
        />
      ))}
      <label className="col-span-2 grid gap-1 text-xs">
        蒙版
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={object.mask?.shape ?? "none"}
          onChange={(event) => {
            const shape = event.currentTarget.value;
            actions.updateObject(object.objectId, {
              mask:
                shape === "none"
                  ? null
                  : {
                      shape: shape as "rect" | "ellipse" | "rounded_rect",
                      x: 0,
                      y: 0,
                      width: 1,
                      height: 1,
                      ...(shape === "rounded_rect" ? { radius: 0.12 } : {}),
                    },
            });
          }}
        >
          <option value="none">无蒙版</option>
          <option value="rect">矩形</option>
          <option value="rounded_rect">圆角矩形</option>
          <option value="ellipse">椭圆</option>
        </select>
      </label>
      <EffectRange
        label="亮度"
        min={-1}
        max={1}
        value={object.filters?.brightness ?? 0}
        onChange={(value) => updateFilter("brightness", value)}
      />
      <EffectRange
        label="对比度"
        min={-1}
        max={1}
        value={object.filters?.contrast ?? 0}
        onChange={(value) => updateFilter("contrast", value)}
      />
      <EffectRange
        label="饱和度"
        min={-1}
        max={1}
        value={object.filters?.saturation ?? 0}
        onChange={(value) => updateFilter("saturation", value)}
      />
      <EffectRange
        label="模糊"
        min={0}
        max={1}
        value={object.filters?.blur ?? 0}
        onChange={(value) => updateFilter("blur", value)}
      />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={object.filters?.grayscale ?? false}
          onChange={(event) =>
            actions.updateObject(object.objectId, {
              filters: {
                ...(object.filters ?? {}),
                grayscale: event.currentTarget.checked,
              },
            })
          }
        />
        黑白
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={object.filters?.sepia ?? false}
          onChange={(event) =>
            actions.updateObject(object.objectId, {
              filters: {
                ...(object.filters ?? {}),
                sepia: event.currentTarget.checked,
              },
            })
          }
        />
        复古
      </label>
    </div>
  );
}

function EffectRange({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);
  useEffect(() => {
    setDraft(value);
    lastCommitted.current = value;
  }, [value]);
  const commit = () => {
    if (draft === lastCommitted.current) return;
    lastCommitted.current = draft;
    onChange(draft);
  };
  return (
    <label className="grid gap-1 text-xs">
      <span className="flex justify-between">
        {label}
        <span>{draft.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={draft}
        onChange={(event) => setDraft(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

function NormalizedCropField({
  label,
  value,
  positive,
  onCommit,
}: {
  label: string;
  value: number;
  positive: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100)));
  useEffect(() => setDraft(String(Math.round(value * 100))), [value]);
  return (
    <label className="grid gap-1 text-xs">
      {label}
      <input
        type="number"
        min={positive ? 1 : 0}
        max={100}
        step={1}
        className="h-8 min-w-0 rounded-md border bg-background px-2"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          const parsed = Number(draft);
          if (!Number.isFinite(parsed)) {
            setDraft(String(Math.round(value * 100)));
            return;
          }
          onCommit(parsed / 100);
        }}
        onKeyDown={(event) =>
          event.key === "Enter" && event.currentTarget.blur()
        }
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  onCommit,
  type = "text",
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  type?: "text" | "number";
  className?: string;
}) {
  const draftStore = useContext(TextFieldDraftContext);
  const cacheKey = draftStore ? `${draftStore.objectId}:${label}` : null;
  const cachedDraft = cacheKey ? draftStore?.entries.get(cacheKey) : undefined;
  const [inputValue, setInputValue] = useState(
    () => cachedDraft?.value ?? value,
  );
  const focusedRef = useRef(false);
  const dirtyRef = useRef(false);
  const committedByEnterRef = useRef(false);
  const pendingCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    const cached = cacheKey ? draftStore?.entries.get(cacheKey) : undefined;
    if (cached) {
      if (cached.committed && value === cached.value) {
        draftStore?.entries.delete(cacheKey as string);
        dirtyRef.current = false;
        lastCommittedValueRef.current = value;
        setInputValue(value);
        return;
      }
      dirtyRef.current = true;
      if (inputValue !== cached.value) setInputValue(cached.value);
      return;
    }
    if (focusedRef.current) return;
    if (dirtyRef.current && value !== inputValue) return;
    dirtyRef.current = false;
    lastCommittedValueRef.current = value;
    setInputValue(value);
  }, [cacheKey, draftStore, inputValue, value]);

  const commit = (nextValue: string) => {
    if (pendingCommitRef.current) {
      clearTimeout(pendingCommitRef.current);
      pendingCommitRef.current = null;
    }
    if (lastCommittedValueRef.current === nextValue) return;
    lastCommittedValueRef.current = nextValue;
    if (cacheKey) {
      draftStore?.entries.set(cacheKey, {
        value: nextValue,
        committed: true,
      });
    }
    onCommit(nextValue);
  };

  const scheduleCommit = (nextValue: string) => {
    if (pendingCommitRef.current) clearTimeout(pendingCommitRef.current);
    pendingCommitRef.current = setTimeout(() => {
      pendingCommitRef.current = null;
      commit(nextValue);
    }, 200);
  };

  return (
    <label className={`grid gap-1 text-xs ${className}`}>
      {label}
      <input
        type={type}
        value={inputValue}
        className="h-8 min-w-0 rounded-md border bg-background px-2"
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          dirtyRef.current = true;
          if (cacheKey) {
            draftStore?.entries.set(cacheKey, {
              value: nextValue,
              committed: false,
            });
          }
          setInputValue(nextValue);
          onChange(nextValue);
          scheduleCommit(nextValue);
        }}
        onBlur={(event) => {
          focusedRef.current = false;
          if (committedByEnterRef.current) {
            committedByEnterRef.current = false;
            return;
          }
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          committedByEnterRef.current = true;
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function SmallAction({
  label,
  disabled,
  onClick,
}: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function draftFor(object: DesignObject) {
  return {
    name: object.name ?? "",
    x: String(Math.round(object.x * 100) / 100),
    y: String(Math.round(object.y * 100) / 100),
    width: String(Math.round(object.width * 100) / 100),
    height: String(Math.round(object.height * 100) / 100),
    rotation: String(Math.round(object.rotation * 100) / 100),
    opacity: String(Math.round(object.opacity * 100)),
    text:
      object.type === "text" || object.type === "textbox" ? object.text : "",
    fontFamily:
      object.type === "text" || object.type === "textbox"
        ? object.fontFamily
        : "",
    fontSize:
      object.type === "text" || object.type === "textbox"
        ? String(object.fontSize)
        : "",
    fontWeight:
      object.type === "text" || object.type === "textbox"
        ? String(object.fontWeight)
        : "400",
    fontStyle:
      object.type === "text" || object.type === "textbox"
        ? object.fontStyle
        : ("normal" as const),
    lineHeight:
      object.type === "text" || object.type === "textbox"
        ? String(object.lineHeight)
        : "1.2",
    charSpacing:
      object.type === "text" || object.type === "textbox"
        ? String(object.charSpacing)
        : "0",
    textAlign:
      object.type === "text" || object.type === "textbox"
        ? object.textAlign
        : ("left" as const),
    fit: object.type === "image" ? object.fit : ("contain" as const),
    fillColor: "fill" in object ? paintColor(object.fill) : "#ffffff",
    strokeColor: "stroke" in object ? paintColor(object.stroke) : "#111111",
    strokeWidth: "strokeWidth" in object ? String(object.strokeWidth) : "0",
    shadow: "shadow" in object && Boolean(object.shadow),
    shadowColor:
      "shadow" in object && object.shadow ? object.shadow.color : "#000000",
    shadowBlur:
      "shadow" in object && object.shadow ? String(object.shadow.blur) : "12",
    shadowOffsetX:
      "shadow" in object && object.shadow ? String(object.shadow.offsetX) : "0",
    shadowOffsetY:
      "shadow" in object && object.shadow ? String(object.shadow.offsetY) : "4",
    shadowOpacity:
      "shadow" in object && object.shadow
        ? String(Math.round(object.shadow.opacity * 100))
        : "25",
  };
}

function paintColor(
  paint: { kind: string; color?: string } | null | undefined,
): string {
  return paint?.kind === "solid" && /^#[0-9a-f]{6}$/i.test(paint.color ?? "")
    ? (paint.color ?? "#000000")
    : "#000000";
}
