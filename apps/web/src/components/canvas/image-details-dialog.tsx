"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import type { SelectedCanvasImage } from "./image-toolbar-types";

export function ImageDetailsDialog({ image, open, onOpenChange }: {
  image: SelectedCanvasImage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rows = [
    ["名称", image.title ?? "未命名图片"],
    ["显示尺寸", `${Math.round(image.width)} × ${Math.round(image.height)}`],
    ["原始尺寸", image.originalWidth && image.originalHeight ? `${image.originalWidth} × ${image.originalHeight}` : "未知"],
    ["格式", image.mimeType],
    ["创建时间", image.created ? new Date(image.created).toLocaleString("zh-CN") : "未知"],
    ["生成模型", image.model ?? "未知"],
    ["提示词", image.prompt ?? "未知"],
    ["元素 ID", image.id],
    ["资源 ID", image.assetId ?? "未关联资源"],
    ["任务 ID", image.sourceJobId ?? "未知"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>图片详细信息</DialogTitle></DialogHeader>
        <div className="overflow-hidden rounded-xl border border-border">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[88px_1fr] gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
              <span className="text-muted-foreground">{label}</span>
              {label === "提示词" && image.prompt ? (
                <details key={`${image.id}:${open}`} className="group min-w-0 text-foreground">
                  <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                    <span className="group-open:hidden">展开提示词</span>
                    <span className="hidden group-open:inline">收起提示词</span>
                  </summary>
                  <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words pr-2">{value}</p>
                </details>
              ) : <span className="min-w-0 break-words text-foreground">{value}</span>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
