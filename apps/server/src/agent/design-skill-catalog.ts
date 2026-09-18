/**
 * Compact always-on Skill catalog for the run instructions. It exists so a weak
 * model can pick the right guide without first calling list_skills. The catalog
 * is selection metadata only: it is not "loaded", grants no authority and never
 * authorizes execution or billing.
 *
 * Each line leads with the selection signal — the Skill's `whenToUse`, or its
 * `description` for third-party / older packages that predate the field —
 * because that is what the model chooses on. The body still only loads through
 * use_skill/compose_skills.
 */
import { readSkillRuntimeMetadata } from "@loomic/shared";

export type CatalogSkill = {
  name: string;
  displayName?: string;
  description: string;
  readiness?: { status?: string } | undefined;
  /** Raw `metadata` from the package manifest; `metadata.loomic.whenToUse` is the selection signal. */
  metadata?: unknown;
};

const DEFAULT_CATALOG_LIMIT = 30;

/**
 * Hard budget for the whole serialized catalog, in UTF-8 bytes. This text is
 * reprinted in EVERY turn's instructions, so its cost must not grow with the
 * number of installed packages: once the budget is exhausted the remaining
 * lines are dropped (the model can still discover them via list_skills), and
 * the catalog never grows past this bound no matter how verbose a package is.
 */
export const SKILL_CATALOG_MAX_BYTES = 6144;

/**
 * Per-skill selection text bound, in characters. `whenToUse` is contract-capped
 * at 400 characters and a `description` can be longer still, so every line is
 * truncated before it is measured against the catalog budget.
 */
export const SKILL_CATALOG_SELECTION_MAX_CHARS = 160;

const TRUNCATION_SUFFIX = "…";

/** Collapse the newlines some manifests embed so one Skill can never forge extra catalog lines. */
function selectionText(skill: CatalogSkill): string {
  const whenToUse = readSkillRuntimeMetadata(skill.metadata)?.whenToUse;
  const source = (whenToUse?.trim() || skill.description).replace(/\s+/g, " ").trim();
  if (source.length <= SKILL_CATALOG_SELECTION_MAX_CHARS) return source;
  return `${source.slice(0, SKILL_CATALOG_SELECTION_MAX_CHARS - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function formatEnabledSkillCatalog(skills: readonly CatalogSkill[], limit = DEFAULT_CATALOG_LIMIT): string {
  const header = [
    "【本轮已启用技能目录｜按意图选择主技能】",
    "目录只用于选择；选中后仍需 use_skill/compose_skills 读取正文才算已加载。目录不等于已读，也不构成执行授权、费用许可或权限。",
  ];
  const usable = skills
    .filter(skill => skill.readiness?.status !== "unavailable")
    .filter(skill => typeof skill.name === "string" && skill.name.trim() && typeof skill.description === "string")
    .slice(0, Math.max(0, limit));
  if (!usable.length) return "";
  const lines: string[] = [];
  // `header` bytes plus one separator byte per line, so the measured size is the
  // size of the string actually handed to the model.
  let used = utf8Bytes(header.join("\n"));
  for (const skill of usable) {
    const label = skill.displayName && skill.displayName !== skill.name ? `（${skill.displayName}）` : "";
    const line = `- ${skill.name}${label}: ${selectionText(skill)}`;
    const cost = utf8Bytes(line) + 1;
    if (used + cost > SKILL_CATALOG_MAX_BYTES) break;
    used += cost;
    lines.push(line);
  }
  if (!lines.length) return "";
  return [...header, ...lines].join("\n");
}
