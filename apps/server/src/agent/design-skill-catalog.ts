/**
 * Compact always-on Skill catalog for the run instructions. It exists so a weak
 * model can pick the right guide without first calling list_skills. The catalog
 * is selection metadata only: it is not "loaded", grants no authority and never
 * authorizes execution or billing.
 */
export type CatalogSkill = {
  name: string;
  displayName?: string;
  description: string;
  readiness?: { status?: string } | undefined;
};

const DEFAULT_CATALOG_LIMIT = 30;

export function formatEnabledSkillCatalog(skills: readonly CatalogSkill[], limit = DEFAULT_CATALOG_LIMIT): string {
  const usable = skills
    .filter(skill => skill.readiness?.status !== "unavailable")
    .filter(skill => typeof skill.name === "string" && skill.name.trim() && typeof skill.description === "string")
    .slice(0, Math.max(0, limit));
  if (!usable.length) return "";
  const lines = usable.map(skill => {
    const label = skill.displayName && skill.displayName !== skill.name ? `（${skill.displayName}）` : "";
    return `- ${skill.name}${label}: ${skill.description}`;
  });
  return [
    "【本轮已启用技能目录｜按意图选择主技能】",
    "目录只用于选择；选中后仍需 use_skill/compose_skills 读取正文才算已加载。目录不等于已读，也不构成执行授权、费用许可或权限。",
    ...lines,
  ].join("\n");
}
