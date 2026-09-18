"use client";

import Link from "next/link";
import { useWorkspaceSkills } from "@/hooks/use-workspace-skills";

const CHAT_SKILL_SLUGS = new Set([
  "logo-design",
  "campaign-design",
  "product-visual",
  "creative-directions",
]);

export function skillInvitation(skillName: string): string {
  return `请使用「${skillName}」技能协助我。`;
}

export function ChatSkills({ onSelectSkill, accessToken }: { onSelectSkill: (invitation: string) => void; accessToken?: string }) {
  const { skills, loading, error, reload } = useWorkspaceSkills(accessToken);
  const enabled = skills.filter((skill) =>
    skill.installed === true &&
    skill.enabled === true &&
    CHAT_SKILL_SLUGS.has(skill.slug),
  );
  return <div className="flex h-full flex-col items-center justify-center gap-4 px-4 py-6 text-center">
    <p className="text-sm font-semibold text-foreground">当前启用的技能</p>
    {loading ? <p role="status" className="text-xs text-muted-foreground">正在读取技能状态…</p>
      : error ? <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p><button type="button" onClick={() => { void reload(); }} className="underline">重试技能列表</button></div>
      : enabled.length ? <>
        <p className="max-w-80 text-xs text-muted-foreground">选择技能会将可编辑的技能邀请写入输入框；确认内容后再发送。</p>
        <div className="flex max-w-96 flex-wrap justify-center gap-2">{enabled.map((skill) => {
          const unavailable = !skill.readiness || skill.readiness.status === "unavailable";
          return <button key={skill.id} type="button" disabled={unavailable}
            title={skill.name}
            onClick={() => onSelectSkill(skillInvitation(skill.name))}
            className="max-w-full rounded-xl border border-border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-muted disabled:opacity-50">
            <span className="block truncate font-medium">{skill.name}</span>
          </button>;
        })}</div>
      </> : <p className="max-w-80 text-xs text-muted-foreground">暂无已启用技能。你仍可直接描述任务，或前往技能页安装和启用工作方法。</p>}
    <Link href="/skills" className="text-xs text-muted-foreground underline">管理技能</Link>
  </div>;
}
