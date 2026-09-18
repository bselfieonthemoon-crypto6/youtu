/** Safe, static recovery guidance; never expose provider bodies or raw context. */
export const CONTEXT_ERROR_MESSAGES = {
  agent_context_budget_exceeded: "当前任务的信息量超过模型的安全上下文预算，已暂停后续处理。请缩小本次修改范围，或选择已验证的大上下文模型后继续；已有生成任务请先查看状态，避免重复提交。",
  agent_context_summary_failed: "长对话整理未成功，本次处理已停止，没有使用不完整摘要继续执行。请重新继续当前任务；若已有图片生成任务，请先查看状态，避免重复生成。",
  agent_context_conflict: "要求或上下文刚刚发生了变化，旧处理已停止。请按最新要求继续；已提交的生成任务不会自动重试。",
  agent_context_commit_conflict: "要求或上下文刚刚发生了变化，旧整理结果没有覆盖新内容。请按最新要求继续；已有生成任务请先查看状态。",
  agent_context_task_superseded: "任务已被新的要求替代，旧处理已停止。请按最新要求继续，避免重复提交已有生成任务。",
  agent_context_profile_invalid: "当前模型的上下文能力配置无效，暂时无法继续。请管理员检查模型设置，或选择其他已验证的可用模型后继续。",
  agent_context_profile_unavailable: "暂时无法读取当前模型的上下文能力配置。请管理员检查模型设置后再继续；系统没有自动切换模型或重试生成。",
  agent_context_persistence_failed: "暂时无法保存或读取任务上下文，本次处理已停止。请检查连接后继续；已有生成任务请先查看状态，避免重复提交。",
  agent_context_payload_invalid: "任务上下文的数据或大小不符合保存要求，本次处理已停止。请缩小本次任务范围后继续；如仍失败，请联系管理员检查配置。",
  agent_context_source_missing: "无法找到这次任务需要的原始消息或资料。请补充相关要求或重新选择资料后继续，系统不会根据缺失来源猜测执行。",
  agent_context_scope_forbidden: "当前账号已无权访问这段任务上下文。请确认登录账号和项目权限后继续。",
  agent_context_task_forbidden: "当前账号已无权访问这项任务。请确认登录账号和项目权限后继续。",
  agent_context_forbidden: "当前账号已无权访问这段任务上下文。请确认登录账号和项目权限后继续。",
} as const;

export type ContextErrorCode = keyof typeof CONTEXT_ERROR_MESSAGES;

export function contextErrorForClient(error: unknown): { code: ContextErrorCode; message: string } | null {
  const seen = new Set<unknown>();
  let current = error;
  // Wrappers can form cycles. Inspect only known codes and a bounded cause chain.
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current);
    const record = typeof current === "object" ? current as Record<string, unknown> : null;
    const code = record?.code;
    const message = record?.message ?? (typeof current === "string" ? current : null);
    const reason = typeof code === "string" && Object.hasOwn(CONTEXT_ERROR_MESSAGES, code) ? code
      : typeof message === "string" && Object.hasOwn(CONTEXT_ERROR_MESSAGES, message) ? message : null;
    if (reason) return { code: reason as ContextErrorCode, message: CONTEXT_ERROR_MESSAGES[reason as ContextErrorCode] };
    current = record?.cause;
  }
  return null;
}
