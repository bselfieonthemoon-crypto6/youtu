"use client";

import { ArrowDown, ArrowUp, Pin, PinOff } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { IMAGE_TOOLBAR_ACTIONS, type ImageToolbarPreferences } from "../../hooks/use-image-toolbar-preferences";
import type { ImageToolbarActionId } from "./image-toolbar-types";

export function ImageToolbarCustomizeDialog({ open, value, onOpenChange, onSave, onReset }: {
  open: boolean;
  value: ImageToolbarPreferences;
  onOpenChange: (open: boolean) => void;
  onSave: (value: ImageToolbarPreferences) => void;
  onReset: () => void;
}) {
  const move = (id: ImageToolbarActionId, delta: number) => {
    const index = value.pinned.indexOf(id);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= value.pinned.length) return;
    const pinned = [...value.pinned];
    [pinned[index], pinned[target]] = [pinned[target]!, pinned[index]!];
    onSave({ ...value, pinned });
  };
  const toggle = (id: ImageToolbarActionId) => {
    const pinned = value.pinned.includes(id)
      ? value.pinned.filter((item) => item !== id)
      : [...value.pinned, id].slice(0, 7);
    onSave({ ...value, pinned });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>自定义图片工具栏</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">最多固定 7 项。未固定的功能仍可从“更多”中使用。</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {IMAGE_TOOLBAR_ACTIONS.map((item) => {
            const pinned = value.pinned.includes(item.id);
            return (
              <div key={item.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${item.available ? "border-border" : "border-border/50 opacity-45"}`}>
                <button type="button" disabled={!item.available} onClick={() => toggle(item.id)} className="flex flex-1 items-center gap-2 text-left text-sm">
                  {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
                  {item.label}{!item.available ? "（后续版本）" : ""}
                </button>
                {pinned && <>
                  <button type="button" aria-label="上移" onClick={() => move(item.id, -1)}><ArrowUp className="size-3.5" /></button>
                  <button type="button" aria-label="下移" onClick={() => move(item.id, 1)}><ArrowDown className="size-3.5" /></button>
                </>}
              </div>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.showLabels} onChange={(event) => onSave({ ...value, showLabels: event.target.checked })} />
          显示工具名称
        </label>
        <DialogFooter className="flex-row justify-between">
          <button type="button" onClick={onReset} className="rounded-lg border border-border px-3 py-2 text-sm">重置</button>
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg bg-foreground px-4 py-2 text-sm text-background">完成</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
