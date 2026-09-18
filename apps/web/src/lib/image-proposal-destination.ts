export function imageProposalDestination(details: unknown): string {
  if (!details || typeof details !== "object" || !("target" in details)) return "未记录（建议重新生成方案确认位置）";
  const target = details.target as { kind?: string; design_id?: string; placement?: { replace_object_id?: string; role?: string } } | null;
  return target?.kind === "design"
    ? `设计画板 ${target.design_id ?? ""} · ${target.placement?.replace_object_id ? "替换现有" : "新增"}${target.placement?.role === "background" ? "背景图层" : "图片图层"}`
    : "无限画布 · 新增图片，保留原图，不修改画板";
}
