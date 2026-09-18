/**
 * Sanitize error messages before sending to the frontend.
 * Logs full error detail server-side, returns user-friendly message.
 */
import { contextErrorForClient } from "./context-error.js";

function providerQuotaErrorForClient(error: unknown): { code: string; message: string } | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current);
    const record = typeof current === "object" ? current as Record<string, unknown> : null;
    const message = record?.message ?? (typeof current === "string" ? current : "");
    if (record?.code === "insufficient_quota" || (typeof message === "string" && (
      /\binsufficient_quota\b/i.test(message)
      || /\bquota\b[\s\S]*\bpreConsumedQuota\b[\s\S]*\bnot enough\b/i.test(message)
    ))) {
      return {
        code: "provider_quota_insufficient",
        message: "模型服务的可用额度不足，本次请求已停止。请联系管理员检查第三方额度后继续；对话和已有图片会保留，请勿重复提交生成。",
      };
    }
    current = record?.cause;
  }
  return null;
}

/** A malformed tool declaration cannot recover by resubmitting the same request. */
function toolSchemaErrorForClient(error: unknown): { code: string; message: string } | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current);
    const record = typeof current === "object" ? current as Record<string, unknown> : null;
    const message = record?.message ?? (typeof current === "string" ? current : "");
    if (record?.code === "provider_tool_schema_unsupported" || (typeof message === "string" && (
      /invalid (?:json payload|schema)[\s\S]*(?:function_declarations|tools\[|function.*parameters)/i.test(message)
      || /invalid schema for function/i.test(message)
    ))) {
      return { code: "tool_schema_incompatible", message: "当前模型不兼容这次任务的工具参数格式，任务已停止。请联系管理员检查模型适配后再继续；已有生成任务请先查看状态，避免重复提交。" };
    }
    current = record?.cause;
  }
  return null;
}

/** Keep the existing stream error enum; detailed reasons live in details. */
export function sanitizeRunErrorForClient(error: unknown): {
  code: "run_failed"; message: string; details?: { reasonCode: string; automaticRetry: false };
} {
  const context = contextErrorForClient(error) ?? toolSchemaErrorForClient(error) ?? providerQuotaErrorForClient(error);
  return context
    ? { code: "run_failed", message: context.message, details: { reasonCode: context.code, automaticRetry: false } }
    : { code: "run_failed", message: sanitizeErrorForClient(error) };
}

const PROVIDER_PATTERN =
  /google|vertex|openai|replicate|langchain|gaxios|undici|fetch failed/i;
const DB_PATTERN =
  /supabase|postgres|pgmq|database|relation|column|constraint/i;
const AUTH_PATTERN =
  /jwt|token|unauthorized|forbidden|credential|service.account/i;
const INFRA_PATTERN =
  /econnrefused|econnreset|etimedout|dns|socket|tls|certificate/i;

export function sanitizeErrorForClient(error: unknown): string {
  const context = contextErrorForClient(error) ?? toolSchemaErrorForClient(error) ?? providerQuotaErrorForClient(error);
  if (context) return context.message;
  const raw = error instanceof Error ? error.message : String(error);

  // Log full detail server-side for debugging
  console.error("[error-sanitizer] Raw error:", raw);
  if (error instanceof Error) {
    // Log nested cause chain (LangChain wraps errors multiple levels deep)
    let cause = (error as any).cause;
    while (cause) {
      console.error("[error-sanitizer] Caused by:", cause.message ?? cause);
      cause = cause.cause;
    }
    // Log response details if present (Google API errors attach response/details)
    const errAny = error as any;
    if (errAny.response) {
      console.error("[error-sanitizer] Response status:", errAny.response.status);
      console.error("[error-sanitizer] Response data:", JSON.stringify(errAny.response.data ?? errAny.response.body ?? "").substring(0, 2000));
    }
    if (errAny.details) {
      console.error("[error-sanitizer] Details:", JSON.stringify(errAny.details).substring(0, 2000));
    }
    if (error.stack) {
      console.error("[error-sanitizer] Stack:", error.stack);
    }
  }

  // Map to user-friendly messages
  if (PROVIDER_PATTERN.test(raw)) {
    return "AI 服务暂时不可用，请稍后重试。";
  }
  if (DB_PATTERN.test(raw)) {
    return "数据服务异常，请稍后重试。";
  }
  if (AUTH_PATTERN.test(raw)) {
    return "认证失败，请刷新页面重新登录。";
  }
  if (INFRA_PATTERN.test(raw)) {
    return "网络连接异常，请检查网络后重试。";
  }
  if (raw.includes("abort") || raw.includes("cancel")) {
    return "请求已取消。";
  }
  if (raw.length > 100) {
    // Long messages are likely stack traces or JSON errors
    return "请求处理失败，请重试。";
  }

  // Short, non-technical messages can pass through
  return "请求处理失败，请重试。";
}
