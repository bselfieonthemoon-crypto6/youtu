"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Plus, X } from "lucide-react";
import type { SkillCategory, SkillDetail } from "@loomic/shared";
import { skillCreateRequestSchema } from "@loomic/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSafeSkillFilePath, SKILL_CATEGORY_LABELS, skillErrorMessage } from "@/lib/skills-client";

export type SkillFormData = {
  name: string; description: string; category: SkillCategory; skillContent: string;
  files: Array<{ filePath: string; content: string }>;
};

const TEMPLATE = `# 技能名称

## 适用场景
说明用户在什么任务中需要这个技能。

## 输入与约束
- 指定目标画板、素材和必须保留的内容。
- 缺少必要信息时先提问，不猜测用户意图。

## 工作步骤
1. 整理交付目标和验收标准。
2. 使用当前可用工具完成任务；缺少工具或模型时明确告知。
3. 检查产物，不把保存成功当作设计效果通过。

## 交付与确认
- 列出交付文件、修改内容和未完成事项。
- 生成付费素材或改变任务范围前，等待用户确认。
`;

export function CreateSkillDialog({ open, onOpenChange, onSubmit, skill }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  onSubmit: (data: SkillFormData) => Promise<void>;
  skill?: SkillDetail | null;
}) {
  const [form, setForm] = useState<SkillFormData>({ name: "", description: "", category: "custom", skillContent: "", files: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    if (!open) return;
    setForm({ name: skill?.name ?? "", description: skill?.description ?? "", category: skill?.category ?? "custom",
      skillContent: skill?.skillContent ?? "", files: skill?.files?.filter((file) => file.filePath !== "SKILL.md")
        .map(({ filePath, content }) => ({ filePath, content })) ?? [] });
    setError(null);
  }, [open, skill]);

  const update = <K extends keyof SkillFormData>(key: K, value: SkillFormData[K]) => setForm((current) => ({ ...current, [key]: value }));
  const close = (next: boolean) => { if (!locked.current) onOpenChange(next); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked.current) return;
    if (!form.name.trim() || !form.description.trim() || !form.skillContent.trim()) {
      setError("请填写名称、描述和 SKILL.md 内容。"); return;
    }
    const files = form.files.map((file) => ({ ...file, filePath: file.filePath.trim() }));
    if (files.some((file) => !isSafeSkillFilePath(file.filePath))) {
      setError("附属文件路径须位于 scripts/、references/ 或 assets/，不能包含空目录、上级目录或绝对路径。"); return;
    }
    if (new Set(files.map((file) => file.filePath.toLowerCase())).size !== files.length) {
      setError("附属文件路径不能重复。"); return;
    }
    const payload = { ...form, name: form.name.trim(), description: form.description.trim(), files };
    if (!skillCreateRequestSchema.safeParse(payload).success) {
      setError("请检查内容大小：正文最多 256 KiB，附属文件最多 64 个、每个 2 MiB，合计 8 MiB；文本不能包含空字符。"); return;
    }
    locked.current = true; setSubmitting(true); setError(null);
    try {
      await onSubmit(payload);
      onOpenChange(false);
    } catch (cause) {
      setError(skillErrorMessage(cause, skill ? "保存失败，内容已保留，请重试。" : "创建失败，内容已保留，请重试。"));
    } finally { locked.current = false; setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{skill ? "编辑自定义技能" : "添加自定义技能"}</DialogTitle>
          <DialogDescription>保存可复用的工作说明与参考文件。技能不会自动安装模型、运行附带脚本或授予额外操作权限。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={submitting} className="space-y-4 disabled:opacity-70">
            <div className="space-y-1.5"><Label htmlFor="skill-name">名称</Label>
              <Input id="skill-name" value={form.name} onChange={(event) => update("name", event.target.value)} maxLength={200} placeholder="例如：品牌宣传图检查" /></div>
            <div className="space-y-1.5"><Label htmlFor="skill-category">分类</Label>
              <select id="skill-category" value={form.category} onChange={(event) => update("category", event.target.value as SkillCategory)} className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm">
                {Object.entries(SKILL_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            <div className="space-y-1.5"><Label htmlFor="skill-desc">描述</Label>
              <textarea id="skill-desc" rows={2} value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={2000} className="w-full rounded-lg border border-input bg-transparent p-2 text-sm" /></div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between"><Label htmlFor="skill-content">SKILL.md 内容</Label>
                <Button type="button" variant="ghost" size="xs" disabled={!!form.skillContent.trim()} onClick={() => update("skillContent", TEMPLATE)}><FileText className="size-3" />使用模板</Button></div>
              <textarea id="skill-content" rows={10} value={form.skillContent} onChange={(event) => update("skillContent", event.target.value)} className="w-full rounded-lg border border-input bg-secondary p-3 font-mono text-xs leading-relaxed" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">附属文件（可选）</span>
                <Button type="button" variant="outline" size="xs" onClick={() => update("files", [...form.files, { filePath: "", content: "" }])}><Plus className="size-3" />添加文件</Button></div>
              <p className="text-xs text-muted-foreground">仅编辑文本内容；附属脚本仅供查看，不会执行。</p>
              {form.files.map((file, index) => (
                <div key={index} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex gap-2"><Input aria-label={`文件 ${index + 1} 路径`} value={file.filePath} placeholder="references/验收标准.md" onChange={(event) => update("files", form.files.map((entry, row) => row === index ? { ...entry, filePath: event.target.value } : entry))} />
                    <Button type="button" variant="ghost" size="sm" aria-label={`删除文件 ${index + 1}`} onClick={() => update("files", form.files.filter((_, row) => row !== index))}><X className="size-4" /></Button></div>
                  <textarea aria-label={`文件 ${index + 1} 内容`} rows={4} value={file.content} onChange={(event) => update("files", form.files.map((entry, row) => row === index ? { ...entry, content: event.target.value } : entry))} className="w-full rounded-lg border border-input bg-secondary p-2 font-mono text-xs" />
                </div>
              ))}
            </div>
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => close(false)}>取消</Button>
            <Button type="submit" disabled={submitting}>{submitting ? "保存中…" : skill ? "保存修改" : "创建并安装"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
