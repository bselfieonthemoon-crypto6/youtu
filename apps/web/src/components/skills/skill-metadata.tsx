import { readSkillRuntimeMetadata, type SkillListItem } from "@loomic/shared";

const ROLE_LABELS = { planner: "任务规划模型", vision: "视觉理解模型", image: "图片生成模型" } as const;
const EXECUTION_LABELS = { native: "原生画板编辑", image: "图片生成", hybrid: "原生编辑与图片生成", guidance: "工作方法指导" } as const;
const OUTPUT_LABELS: Record<string, string> = {
  "native-design": "可编辑设计", "design-brief": "设计需求说明", "design-review": "设计评审报告",
  "raster-image": "图片素材", "image-prompt": "生图提示词", "transparent-png": "透明 PNG",
  "layer-plan": "分层处理方案", "exported-image": "导出图片", "raster-export": "导出图片",
  "operation-guidance": "操作指导", "native-layer-edit": "原生图层编辑", copy: "设计文案",
  design: "可编辑设计", artboard: "可编辑画板", editable_design: "可编辑设计", native_scene: "原生画板",
  editable_artboard: "可编辑画板", image: "图片", png: "PNG 图片", transparent_png: "透明 PNG",
  svg: "SVG 矢量图", logo: "Logo", poster: "宣传图", carousel: "轮播图", text: "文字说明",
  brief: "需求说明", design_brief: "设计需求说明", report: "检查报告", checklist: "检查清单",
  palette: "配色方案", brand_kit: "品牌资料", mask: "蒙版", layers: "分层素材", image_asset: "图片素材",
};

export function skillReadinessLabel(skill: SkillListItem) {
  return skill.readiness?.status === "ready" ? (readSkillRuntimeMetadata(skill.metadata)?.execution === "guidance" ? "可用 · 指导类" : "配置就绪") : skill.readiness?.status === "limited" ? "部分依赖缺失"
    : skill.readiness?.status === "unavailable" ? "当前不可用" : "尚未检测";
}

export function SkillMetadata({ skill, compact = false }: { skill: SkillListItem; compact?: boolean }) {
  const runtime = readSkillRuntimeMetadata(skill.metadata);
  // General limits have their own full section. Keep actionable dependency
  // failures and guidance-only status here without repeating the package text.
  const statusReasons = (skill.readiness?.reasons ?? []).filter((reason) => !runtime?.limitations.includes(reason));
  return <div className="space-y-2 text-xs text-muted-foreground">
    <p><span className="font-medium text-foreground">能力状态：</span>{skillReadinessLabel(skill)}</p>
    {statusReasons.length ? <ul className="list-disc space-y-1 pl-4">{(compact ? statusReasons.slice(0, 1) : statusReasons).map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    {runtime ? <>
      <p><span className="font-medium text-foreground">执行方式：</span>{EXECUTION_LABELS[runtime.execution]}</p>
      <p><span className="font-medium text-foreground">产物：</span>{runtime.outputKinds.map((kind) => OUTPUT_LABELS[kind] ?? kind).join("、") || "未声明"}</p>
      {compact ? <p><span className="font-medium text-foreground">模型要求：</span>{runtime.models.map((model) => `${ROLE_LABELS[model.role]}（${model.required ? "必需" : "可选"}）`).join("、") || "未声明"}</p> : <>
        <section aria-label="模型要求" className="space-y-1"><h3 className="font-medium text-foreground">模型要求</h3>
          {runtime.models.length ? runtime.models.map((model, index) => <div key={index} className="rounded-md bg-muted/50 p-2">
            <p>{ROLE_LABELS[model.role]} · {model.required ? "必需" : "可选"}</p>
            {model.exactIds?.length ? <p className="break-words">限定型号：{model.exactIds.join("、")}</p> : null}
            <p className="break-words">偏好型号：{model.preferredIds.join("、") || "无指定偏好"}</p>
          </div>) : <p>未声明模型依赖。</p>}
          <p>偏好型号不等于当前已配置，也不保证调用成功。</p>
        </section>
        {!!skill.readiness?.models.length && <section aria-label="当前匹配模型"><h3 className="font-medium text-foreground">当前匹配模型</h3>{skill.readiness.models.map((model, index) => <p key={index} className="break-words">{ROLE_LABELS[model.role]}：{model.modelId}（上游：{model.upstreamModelId}）</p>)}</section>}
        <section aria-label="工具依赖"><h3 className="font-medium text-foreground">工具依赖</h3><p className="break-words">必需：{runtime.requiredTools.join("、") || "无"}</p><p className="break-words">可选：{runtime.optionalTools.join("、") || "无"}</p></section>
        <section aria-label="技能限制"><h3 className="font-medium text-foreground">限制与注意事项</h3>{runtime.limitations.length ? <ul className="list-disc space-y-1 pl-4">{runtime.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>未声明额外限制，仍需遵守当前工具与操作授权。</p>}</section>
        <section aria-label="来源与许可"><h3 className="font-medium text-foreground">参考来源与许可</h3>{runtime.sources.length ? <ul className="space-y-2">{runtime.sources.map((source, index) => <li key={index}><a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">{source.title}</a><p>{source.relation === "inspired-by" ? "方法参考（不是源码集成）" : "改编来源"} · {source.license || "未声明许可"}</p></li>)}</ul> : <p>未提供参考来源。</p>}</section>
      </>}
    </> : <p>未声明模型、工具与产物要求。仅按当前可用能力使用，不能据此认定依赖已满足。</p>}
  </div>;
}
