"use client";

import { useEffect, useRef, useState } from "react";
import type { PublishedSkillPreview, SkillDetail } from "@loomic/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SkillMetadata } from "@/components/skills/skill-metadata";
import { skillErrorMessage } from "@/lib/skills-client";

export function SkillDetailDialog({ skill, open, onOpenChange, onInstall, onUninstall, onDelete, onEdit, canDelete = false, loading = false, error, onRetry, busy = false, cover = null, examples = [] }: {
  skill: SkillDetail | null; open: boolean; onOpenChange: (open: boolean) => void;
  onInstall: (id: string) => Promise<void>; onUninstall: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>; onEdit?: (() => void) | undefined; canDelete?: boolean;
  loading?: boolean; error?: string | null; onRetry?: () => void; busy?: boolean;
  /** Published images for this skill, from the platform catalog. */
  cover?: PublishedSkillPreview | null;
  examples?: readonly PublishedSkillPreview[];
}) {
  const [action, setAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lock = useRef(false);
  useEffect(() => { setActionError(null); setConfirmDelete(false); }, [open, skill?.id]);
  const run = async (label: string, operation: () => Promise<void>) => {
    if (lock.current || busy) return;
    lock.current = true; setAction(label); setActionError(null);
    try { await operation(); }
    catch (cause) { setActionError(skillErrorMessage(cause, "操作失败，状态未更新，请重试。")); }
    finally { lock.current = false; setAction(null); }
  };
  const disabled = busy || action !== null;
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current && !busy) onOpenChange(next); }}>
    <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{skill?.name ?? "技能详情"}</DialogTitle><DialogDescription>{skill?.description ?? "查看工作说明、依赖要求和参考文件。"}</DialogDescription></DialogHeader>
      {loading ? <p role="status">正在加载技能详情…</p> : error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" onClick={onRetry}>重试详情</Button></div> : skill ? <>
        {cover || examples.length ? (
          <section aria-label="技能效果图" data-testid="skill-detail-gallery" className="space-y-3">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover.imageUrl} alt={cover.caption ? `${skill.name}：${cover.caption}` : `${skill.name} 效果图`}
                className="max-h-72 w-full rounded-lg border border-border bg-muted/40 object-contain" />
            ) : null}
            {examples.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {examples.map(example => (
                  <li key={example.id} className="rounded-lg border border-border p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={example.imageUrl} alt={example.caption ? `${skill.name} 示例：${example.caption}` : `${skill.name} 示例`}
                      loading="lazy" className="h-40 w-full rounded bg-muted/40 object-contain" />
                    {example.caption ? <p className="mt-2 text-xs text-muted-foreground">{example.caption}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted-foreground">效果图由平台维护，仅作能力示意，不代表你的实际生成结果。</p>
          </section>
        ) : null}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-muted-foreground">安装状态</span><p>{skill.installed ? `已安装 · ${skill.enabled ? "已启用" : "已停用"}` : "未安装"}</p></div>
          <div><span className="text-muted-foreground">来源</span><p>{skill.source === "system" ? "官方" : skill.source === "community" ? "社区" : "自定义"}</p></div>
          <div><span className="text-muted-foreground">作者</span><p>{skill.author || "未填写"}</p></div>
          <div><span className="text-muted-foreground">版本</span><p>v{skill.version}</p></div>
          <div><span className="text-muted-foreground">技能许可证</span><p>{skill.license || "未声明，不代表可任意再分发"}</p></div>
          {skill.sourceUrl && /^https?:\/\//i.test(skill.sourceUrl) && <div><span className="text-muted-foreground">源文件地址</span><p><a href={skill.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">查看来源</a></p></div>}
        </div>
        <div className="rounded-lg border border-border p-3"><SkillMetadata skill={skill} /></div>
        <section aria-label="技能文件" className="space-y-2"><h3 className="text-sm font-medium">技能文件</h3>
          <details open className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-mono text-xs">SKILL.md</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{skill.skillContent || "（正文为空）"}</pre></details>
          {(skill.files ?? []).filter((file) => file.filePath !== "SKILL.md").map((file) => {
            const isImage = /^image\//i.test(file.mimeType);
            return <details key={file.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer break-all font-mono text-xs">{file.filePath}</summary>{isImage
              // Image references are stored as base64 text for preview; they are
              // intentionally not given to the agent.
              ? <img src={`data:${file.mimeType};base64,${file.content}`} alt={file.filePath} className="mt-2 max-h-72 w-auto rounded border border-border object-contain" />
              : <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{file.content || "（空文件）"}</pre>}</details>;
          })}
        </section>
        {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        <DialogFooter className="flex-wrap">
          {canDelete && onDelete && (confirmDelete ? <div className="mr-auto flex flex-wrap items-center gap-2"><span className="text-xs text-destructive">删除技能及其附属文件？此操作不可撤销。</span><Button size="xs" variant="destructive" disabled={disabled} onClick={() => { void run("删除", () => onDelete(skill.id)); }}>确认删除</Button><Button size="xs" variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(false)}>取消删除</Button></div> : <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirmDelete(true)}>删除技能</Button>)}
          {onEdit && <Button size="sm" variant="outline" disabled={disabled} onClick={onEdit}>编辑技能</Button>}
          <Button size="sm" variant={skill.installed ? "outline" : "default"} disabled={disabled} onClick={() => { void run(skill.installed ? "卸载" : "安装", () => skill.installed ? onUninstall(skill.id) : onInstall(skill.id)); }}>{action ? `${action}中…` : skill.installed ? "卸载技能" : "安装技能"}</Button>
        </DialogFooter>
      </> : null}
    </DialogContent>
  </Dialog>;
}
