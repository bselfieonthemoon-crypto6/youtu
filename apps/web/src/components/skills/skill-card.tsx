"use client";

import type { SkillListItem } from "@loomic/shared";
import { Button } from "@/components/ui/button";
import { SkillMetadata } from "@/components/skills/skill-metadata";
import { SKILL_CATEGORY_LABELS } from "@/lib/skills-client";

/**
 * A platform-admin-published cover, when one exists. The image is optional by
 * design: most skills have none, and the card must look deliberate either way.
 * `exampleCount` is a hint, not a promise — the gallery lives in the detail dialog.
 */
export function SkillCard({ skill, onToggle, onClick, onInstall, busy = false, coverUrl = null, exampleCount = 0 }: {
  skill: SkillListItem;
  onToggle: (id: string, enabled: boolean) => void;
  onClick: (skill: SkillListItem) => void;
  onInstall?: (id: string) => void;
  busy?: boolean;
  coverUrl?: string | null;
  exampleCount?: number;
}) {
  const installed = skill.installed === true;
  return <article aria-label={skill.name} data-skill-id={skill.id} className="overflow-hidden rounded-xl border border-border bg-card">
    {coverUrl ? (
      <button type="button" onClick={() => onClick(skill)} aria-label={`查看 ${skill.name} 的效果图`}
        className="block w-full border-b border-border bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={coverUrl} alt={`${skill.name} 效果图`} loading="lazy"
          className="h-40 w-full object-cover" />
      </button>
    ) : null}
    <div className="p-4">
    <div className="mb-2 flex items-start justify-between gap-3">
      <div className="min-w-0"><p className="mb-1 text-[11px] text-muted-foreground">{SKILL_CATEGORY_LABELS[skill.category]} · {skill.source === "system" ? "官方" : skill.source === "community" ? "社区" : "自定义"}</p>
        <button type="button" onClick={() => onClick(skill)} className="text-left text-sm font-medium text-foreground hover:underline">{skill.name}</button></div>
      {installed ? <button type="button" role="switch" aria-label={`启用 ${skill.name}`} aria-checked={skill.enabled === true} disabled={busy} onClick={() => onToggle(skill.id, skill.enabled !== true)} className="shrink-0 rounded-full border border-border px-3 py-1 text-xs disabled:opacity-50">{busy ? "更新中…" : skill.enabled ? "已启用" : "已停用"}</button>
        : <Button size="xs" disabled={busy || !onInstall} onClick={() => onInstall?.(skill.id)}>{busy ? "安装中…" : "安装"}</Button>}
    </div>
    <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
    <SkillMetadata skill={skill} compact />
    <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
      <span>{installed ? "已安装" : "未安装"} · v{skill.version}{exampleCount > 0 ? ` · ${exampleCount} 张示例` : ""}</span>
      <Button size="xs" variant="ghost" onClick={() => onClick(skill)}>查看详情</Button>
    </div>
    </div>
  </article>;
}
