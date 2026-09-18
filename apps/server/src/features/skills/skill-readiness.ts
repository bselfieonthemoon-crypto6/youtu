import { readSkillRuntimeMetadata, type SkillReadiness, type SkillRuntimeMetadata } from "@loomic/shared";
import { NATIVE_DESIGN_MUTATION_TOOL_NAMES } from "../../agent/mastra-tool-policy.js";
import type { WorkspaceModelCatalogEntry } from "../providers/workspace-model-catalog-service.js";

export type SkillDependencyModel = {
  id: string;
  upstreamModelId: string;
  modality: string;
  capabilities: readonly string[];
};

/** Actual server tool names. Context-dependent tools are checked again per run. */
export const DESIGN_SKILL_PLATFORM_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "ls", "glob", "grep", "write_todos",
  "inspect_canvas", "manipulate_canvas", "screenshot_canvas",
  "inspect_design", "get_design_objects", "manipulate_design", "export_design",
  "search_design_resources", "apply_design_template", "get_brand_kit", "list_designs",
  "generate_image", "edit_image", "confirm_image_generation", "get_image_proposal",
  "update_design_brief", "verify_design_result",
  "search_prompt_library", "get_prompt_library_entry", "compose_skills", "list_skills", "use_skill",
]);

export function catalogDependencyModels(entries: WorkspaceModelCatalogEntry[]): SkillDependencyModel[] {
  return entries.map(({ model, upstreamModelId }) => ({
    id: model.id, upstreamModelId, modality: model.modality, capabilities: model.capabilities,
  }));
}

export function skillCatalogTools(runtime: string | undefined): ReadonlySet<string> {
  if (runtime?.trim().toLowerCase() !== "mastra") return DESIGN_SKILL_PLATFORM_TOOLS;
  return new Set([...DESIGN_SKILL_PLATFORM_TOOLS].filter(name =>
    !NATIVE_DESIGN_MUTATION_TOOL_NAMES.has(name) && !["confirm_image_generation", "get_image_proposal"].includes(name)));
}

/** Catalog readiness is only a ceiling. A scoped run may expose fewer tools. */
export function restrictSkillReadinessToTools(metadataValue: unknown, readiness: SkillReadiness | undefined, tools: ReadonlySet<string>): SkillReadiness | undefined {
  const metadata = readSkillRuntimeMetadata(metadataValue);
  if (!metadata) return readiness;
  const missing = metadata.requiredTools.filter(name => !tools.has(name));
  if (!missing.length) return readiness;
  return {
    status: "unavailable", models: readiness?.models ?? [],
    reasons: [...(readiness?.reasons ?? []), `本轮任务未开放必需工具：${missing.join("、")}。不能扩大当前任务范围来执行技能。`],
  };
}

export function evaluateSkillReadiness(input: {
  metadata: unknown;
  content?: unknown;
  models: readonly SkillDependencyModel[];
  tools?: ReadonlySet<string>;
  catalogUnavailable?: boolean;
}): SkillReadiness {
  if (typeof input.content !== "string" || !input.content.trim())
    return { status: "unavailable", reasons: ["技能正文为空，不能执行。"], models: [] };
  const metadata = readSkillRuntimeMetadata(input.metadata);
  if (!metadata) return {
    status: "limited", reasons: ["未声明有效的工具及模型依赖；使用前需检查正文和运行环境。"], models: [],
  };
  if (input.catalogUnavailable) return {
    status: "unavailable", reasons: ["模型配置暂时无法读取，请重试；未将未知状态视为可用。"], models: [],
  };
  const tools = input.tools ?? DESIGN_SKILL_PLATFORM_TOOLS;
  const reasons: string[] = [];
  const selected: SkillReadiness["models"] = [];
  let unavailable = false;
  let limited = false;
  for (const name of metadata.requiredTools) {
    if (!tools.has(name)) {
      unavailable = true;
      reasons.push(`当前环境没有必需工具：${name}`);
    }
  }
  for (const requirement of metadata.models) {
    const candidates = input.models.filter(model => matchesRole(model, requirement.role) &&
      (!requirement.exactIds || requirement.exactIds.includes(model.upstreamModelId)));
    const model = requirement.preferredIds.map(id => candidates.find(candidate => candidate.upstreamModelId === id))
      .find(candidate => candidate !== undefined) ?? candidates[0];
    if (model) selected.push({ role: requirement.role, modelId: model.id, upstreamModelId: model.upstreamModelId });
    else {
      unavailable ||= requirement.required;
      limited ||= !requirement.required;
      const label = { planner: "规划模型", vision: "视觉模型", image: "图片模型" }[requirement.role];
      reasons.push(`缺少${requirement.required ? "必需" : "可选"}${label}${requirement.exactIds ? `（${requirement.exactIds.join(" / ")}）` : ""}${requirement.required ? "。" : "，对应步骤不可用。"}`);
    }
  }
  if (metadata.execution === "guidance") {
    reasons.push("此技能提供指导与规划，不能自动执行其未接入的处理步骤。");
  }
  if (metadata.limitations.length) reasons.push(...metadata.limitations);
  return { status: unavailable ? "unavailable" : limited ? "limited" : "ready", reasons, models: selected };
}

function matchesRole(model: SkillDependencyModel, role: SkillRuntimeMetadata["models"][number]["role"]) {
  if (role === "image") return model.modality === "image" && model.capabilities.includes("image_generation");
  return model.modality === "text" && (role === "planner" ? model.capabilities.includes("text") : model.capabilities.includes("vision_input"));
}
