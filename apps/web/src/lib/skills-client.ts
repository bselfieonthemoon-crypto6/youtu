import type { SkillListItem } from "@loomic/shared";
export { isSafeSkillFilePath } from "@loomic/shared";
import { ApiAuthError, fetchSkills, fetchWorkspaceSkills } from "@/lib/server-api";

const pending = new Map<string, Promise<{ skills: SkillListItem[] }>>();
const CHANGE_EVENT = "loomic:skills-changed";

/** Share in-flight reads only; never persist credentials or reuse a stale installation list. */
export function readSkills(token: string, scope: "catalog" | "workspace") {
  const key = `${scope}:${token}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (scope === "catalog" ? fetchSkills(token) : fetchWorkspaceSkills(token))
    .finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export function notifySkillsChanged() {
  pending.clear();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeSkillsChanged(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function mergeSkillInstallation(catalog: SkillListItem[], workspace: SkillListItem[]) {
  const installed = new Map(workspace.map((skill) => [skill.id, skill]));
  const merged = catalog.map((skill) => {
    const current = installed.get(skill.id);
    installed.delete(skill.id);
    return current
      ? { ...skill, ...current, installed: true, enabled: current.enabled === true }
      : { ...skill, installed: false, enabled: false };
  });
  return [...merged, ...Array.from(installed.values(), (skill) => ({
    ...skill, installed: true, enabled: skill.enabled === true,
  }))];
}

export function skillErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiAuthError) return "登录已失效，请重新登录后重试。";
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    skill_forbidden: "没有管理权限。安装和启停需要工作区管理员权限，自定义技能仅创建者可修改。",
    skill_not_found: "技能不存在、已删除或当前账户无权访问，请刷新列表。",
    skill_invalid_package: "技能包无效，请检查正文、附属文件路径、重复文件和大小限制。",
    skill_conflict: "技能或文件路径存在冲突，请刷新后检查重复内容。",
    skill_save_failed: "完整技能包保存失败，请稍后重试；当前输入已保留。",
  };
  if (messages[code]) return messages[code];
  if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)) return error.message;
  return fallback;
}

export const SKILL_CATEGORY_LABELS = {
  design: "设计", generation: "生成", code: "代码", data: "数据", writing: "写作", custom: "自定义",
} as const;
