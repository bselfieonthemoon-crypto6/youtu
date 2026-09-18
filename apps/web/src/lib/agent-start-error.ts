import { agentContextErrorMessage } from "./agent-run-error";

export function agentStartErrorMessage(error: unknown): string {
  const context = agentContextErrorMessage(error);
  if (context) return context;
  const message = error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    "Canvas not found or access denied":
      "无法访问当前画布，请刷新页面确认登录状态后重试。",
    "Session not found or access denied":
      "当前对话已失效或无权访问，请新建对话后重试。",
    "The selected text model is not available in this workspace.":
      "当前选择的 Agent 模型不可用，请切换为自动或已启用的模型。",
    "Failed to persist agent run": "Agent 任务保存失败，请稍后重试。",
    "Workspace model execution is unavailable":
      "当前工作区模型尚未配置完整，请检查模型设置。",
    "Workspace model execution could not be prepared":
      "无法准备当前模型，请检查模型配置后重试。",
  };
  return (
    known[message] ??
    (/^[\u3400-\u9fff]/u.test(message)
      ? message
      : "Agent 暂时无法启动，请检查连接后重试；若已有生成任务，请先查看任务状态。")
  );
}
