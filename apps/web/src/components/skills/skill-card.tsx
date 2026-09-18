"use client";

import type { SkillListItem } from "@loomic/shared";
import { Button } from "@/components/ui/button";
import { SkillMetadata } from "@/components/skills/skill-metadata";
import { SKILL_CATEGORY_LABELS } from "@/lib/skills-client";

export function SkillCard({ skill, onToggle, onClick, onInstall, busy = false }: {
  skill: SkillListItem;
  onToggle: (id: string, enabled: boolean) => void;
  onClick: (skill: SkillListItem) => void;
  onInstall?: (id: string) => void;
  busy?: boolean;
}) {
  const installed = skill.installed === true;
  return <article aria-label={skill.name} data-skill-id={skill.id} className="rounded-xl border border-border bg-card p-4">
    <div className="mb-2 flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="mb-1 text-[11px] text-muted-foreground">{SKILL_CATEGORY_LABELS[skill.category]} · {skill.source === "system" ? "官方" : skill.source === "community" ? "社区" : "自定义"}</p>
        <button type="button" onClick={() => onClick(skill)} className="text-left text-sm font-medium text-foreground hover:underline">{skill.name}</button></div>
      {installed ? <button type="button" role="switch" aria-label={`启用 ${skill.name}`} aria-checked={skill.enabled === true} disabled={busy} onClick={() => onToggle(skill.id, skill.enabled !== true)} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs disabled:opacity-50">{busy ? "更新中…" : skill.enabled ? "已启用" : "已停用"}</button>
        : <Button size="xs" disabled={busy || !onInstall} onClick={() => onInstall?.(skill.id)}>{busy ? "安装中…" : "安装"}</Button>}
    </div>
    <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
    <SkillMetadata skill={skill} compact />
    <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground"><span>{installed ? "已安装" : "未安装"} · v{skill.version}</span><Button size="xs" variant="ghost" onClick={() => onClick(skill)}>查看详情</Button></div>
  </article>;
}
