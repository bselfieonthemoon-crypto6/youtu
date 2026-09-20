/**
 * The per-turn TWO-LAYER record: what the router DETECTED versus what the run
 * actually EXECUTED, plus a small honest summary of the executed turn.
 *
 * Why it exists. `design.routing` already publishes the routing verdict, and it
 * is a hint: it never authorizes execution. The verification report that asked
 * for this module found the exact failure that separation makes invisible — the
 * router said `new_generation`, the model only asked a clarifying question, and
 * nothing in the product let anyone see the two side by side. The transcript
 * showed a routing notice and a question; the routing notice was treated as if
 * it described what happened.
 *
 * So this record keeps the two answers apart, on purpose:
 *
 *   - `detected` is the router's verdict, passed in from the `design.routing`
 *     event the runtime already emitted. It is quoted, never re-derived and
 *     never corrected here.
 *   - `executed` is derived ONLY from the run's own tool receipts. The intent is
 *     not an input to it. A run whose receipts say `ask_clarification` reports
 *     `clarification` whatever the router believed.
 *
 * Honesty rules this module owns (a wrong summary is worse than a missing one):
 *
 *   1. NOTHING IS CLAIMED WITHOUT A RECEIPT. A `jobId` on a generation/edit
 *      receipt is the only proof a submission was accepted, so
 *      `executionJobIds` is empty unless real jobIds were read. A run that
 *      *appears* to generate but carries no jobId is never described as
 *      submitted (`describeDesignTurnExecution` says so explicitly).
 *   2. `unknown` IS A REAL ANSWER. When a tool call left no readable receipt
 *      (still running, cancelled, or an output shape this module cannot parse)
 *      the executed action is `unknown` — with a machine-readable reason — not a
 *      guess at what probably happened. The refusal notice in
 *      `mastra-refusal-notice.ts` takes the same position from the other side:
 *      an unverifiable receipt is never rounded into a conclusion.
 *   3. ABSENT, NOT INVENTED. Every summary field that the run cannot know is
 *      omitted (`undefined`), never defaulted, never filled from the intent.
 *      A turn that read no Skill guide reports no matched Skill even when it
 *      certainly read one in an earlier turn.
 *   4. NO SUBMISSION PROSE. This module never asserts 已提交 / 正在生成. A
 *      refused submission says nothing was created, because `refused: true`
 *      means the submitter was never called (see `mastra-image-tool.ts`).
 *
 * It is presentation/truth state only: it creates no job, charges nothing,
 * grants nothing, and writes nothing.
 */
import type { DesignTurnIntent } from "@loomic/shared";

// ---------------------------------------------------------------------------
// The executed layer
// ---------------------------------------------------------------------------

/**
 * The ACTUAL behaviour of one run, as the receipts describe it.
 *
 * `generation` is the only kind that implies a durable submission, and it
 * always carries the jobIds that prove it. Every kind may also carry the jobs
 * and assets observed this turn, so a turn that clarified *and* submitted is
 * not forced to hide one behind the other.
 */
export type DesignTurnExecutedAction =
  | { kind: "generation"; jobIds: string[]; assetIds: string[] }
  | { kind: "clarification"; jobIds: string[]; assetIds: string[] }
  | { kind: "canvas_operation"; jobIds: string[]; assetIds: string[] }
  | { kind: "text_only"; jobIds: string[]; assetIds: string[] }
  /** A pre-submission refusal; `code` is the receipt's own `error` field. */
  | { kind: "refused"; code: string; jobIds: string[]; assetIds: string[] }
  /**
   * The receipts genuinely do not say. `code` is one of the constants below and
   * is always a reason this module observed, never a guess at the intent.
   */
  | {
      kind: "unknown";
      code: DesignTurnExecutionUnknownCode;
      jobIds: string[];
      assetIds: string[];
    };

export type DesignTurnExecutionUnknownCode =
  | "no_tool_receipts_readable"
  | "tool_execution_report_pending"
  | "run_canceled"
  | "tool_failed_without_receipt"
  | "image_receipt_unverifiable";

/** How many tool calls one turn may report before the list is only a sample. */
export const DESIGN_TURN_MAX_TOOL_NAMES = 12;
/** Bound on the ids copied out of receipts, per kind. */
export const DESIGN_TURN_MAX_IDS = 8;

/** A receipt that names a durable job proves the submission was accepted. */
const IMAGE_SUBMISSION_TOOLS = new Set(["generate_image", "edit_image"]);
const CANVAS_WRITE_TOOLS = new Set(["manipulate_canvas"]);
const SKILL_READ_TOOLS = new Set(["use_skill", "compose_skills"]);

/**
 * Delivery is captured separately from the submission. `jobId` says a task was
 * created; `assetId`/`design_id` say something was actually produced, and a
 * generation that is still processing has the first without the second.
 */
const JOB_ID_KEYS = ["jobId", "job_id", "jobID"] as const;
const ASSET_ID_KEYS = ["assetId", "design_id", "designId", "object_id", "objectId"] as const;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** Tool calls made this turn, by name. Receipts only, so counts can be trusted. */
export type DesignTurnToolUsageCounts = Record<string, number>;

/**
 * The per-turn summary. Every array is empty and every scalar `undefined` when
 * the run cannot know it; that is the absent-not-invented rule, not a default.
 */
export type DesignTurnSummary = {
  /** The detected intent, so one object carries both layers. Absent when the
   * router published no verdict at all — absent, never defaulted. */
  intent?: DesignTurnIntent;
  /** Guides this run actually READ (a body came back), in read order. */
  matchedSkillNames?: string[];
  toolUsageCounts: DesignTurnToolUsageCounts;
  /** Jobs created this turn, with the ids that prove it. */
  executionJobIds: string[];
  /** Assets the run delivered, when its receipts named them. */
  deliveredAssetIds: string[];
};

/**
 * The two layers plus the summary, as one per-turn record.
 *
 * `detectedIntent` is `null` when the router published no `design.routing`
 * event for the turn (it stays silent for a turn with no design decision at
 * all). That is NOT the same as `non_design`, and it is not filled in.
 */
export type DesignTurnRecord = {
  runId: string;
  detectedIntent: DesignTurnIntent | null;
  detectedReasonCode?: string;
  detectedSource?: string;
  detectedConfidence?: number;
  executed: DesignTurnExecutedAction;
  summary: DesignTurnSummary;
};

/**
 * The smallest honest description of what the run's blocks are: receipts the
 * module can read, and how the run ended. Reported through the executed action's
 * `unknown` reason codes rather than a second field, so there is exactly one
 * place that can describe a run's outcome.
 */
export type DesignTurnReceiptStatus = "completed" | "running" | "canceled" | "failed";

// ---------------------------------------------------------------------------
// Receipt reading
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** True when the tool call produced a receipt this module can actually read. */
function isReadableReceipt(output: unknown): output is Record<string, unknown> {
  return output !== null && typeof output === "object" && !Array.isArray(output);
}

/** A tool block, structurally: the server owns this shape (`ToolBlock`). */
type ToolBlockLike = {
  type: string;
  toolName?: unknown;
  status?: unknown;
  output?: unknown;
};

function toolBlocks(contentBlocks: readonly unknown[]): ToolBlockLike[] {
  return contentBlocks
    .map(asRecord)
    .filter(block => block.type === "tool" && typeof block.toolName === "string")
    .map(block => ({
      type: "tool",
      toolName: block.toolName,
      status: block.status,
      output: block.output,
    }));
}

/**
 * One guide this run read, from the receipt that carried the body.
 *
 * `list_skills` is a catalog listing and a model claim is not a receipt, so
 * neither can put a name here — the same rule `mastra-agent.ts` applies before a
 * loaded guide may enable a server-recognized capability.
 */
function readSkillName(toolName: string, output: Record<string, unknown>): string | undefined {
  if (toolName === "use_skill") {
    if (output.status !== "loaded") return undefined;
    return typeof output.instructions === "string" && output.instructions.length > 0
      ? firstString(asRecord(output.skill), ["name"])
      : undefined;
  }
  if (toolName === "compose_skills") {
    if (output.status !== "composed") return undefined;
    return firstString(asRecord(output.primary), ["name"]);
  }
  return undefined;
}

/** Every Skill name one readable receipt declares as read. */
function readSkillNames(toolName: string, output: Record<string, unknown>): string[] {
  const primary = readSkillName(toolName, output);
  if (toolName !== "compose_skills" || !primary) return primary ? [primary] : [];
  const helpers = Array.isArray(output.helpers) ? output.helpers : [];
  const names = [primary];
  for (const helper of helpers) {
    const name = firstString(asRecord(helper), ["name"]);
    if (name) names.push(name);
  }
  return names;
}

function collectIds(
  output: Record<string, unknown>,
  keys: readonly string[],
  into: Set<string>,
): void {
  const id = firstString(output, keys);
  if (id && into.size < DESIGN_TURN_MAX_IDS) into.add(id);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export type BuildDesignTurnRecordInput = {
  runId: string;
  /** The detected layer, quoted from the run's own `design.routing` event. */
  detected?: DesignTurnDetectedInput | undefined;
  /** The run's assistant content blocks, read AFTER persistence. */
  contentBlocks: readonly unknown[];
};

/**
 * The detected layer as the caller hands it over: a QUOTE of the routing
 * verdict, never a re-derivation. `runId` is absent on purpose — the record
 * carries one run id, and a mismatched pair must be unrepresentable.
 */
export type DesignTurnDetectedInput = {
  intent: DesignTurnIntent;
  reasonCode?: string | undefined;
  source?: string | undefined;
  confidence?: number | undefined;
};

/**
 * Derive the executed action from the run's receipts.
 *
 * Precedence, and why: a user-visible clarification is the turn's outcome when
 * one was asked, so it outranks generation even though a job may also have been
 * created — and in that case the jobIds are still carried, so nothing is hidden.
 * Generation comes next because a job is the strongest evidence available.
 * Only a run with no receipts at all is `text_only`; a run whose receipts are
 * unreadable is `unknown`, never `text_only`.
 */
function deriveExecutedAction(input: { contentBlocks: readonly unknown[] }): DesignTurnExecutedAction {
  const jobIds = new Set<string>();
  const assetIds = new Set<string>();
  const refusals: string[] = [];
  let imageJobs = 0;
  let clarifications = 0;
  let canvasOperations = 0;
    let readableReceipts = 0;
    let unreadableReceipts = 0;
    let failedCalls = 0;
    let runningCalls = 0;
    let canceledCalls = 0;
    let answeredWithText = false;
    let unverifiableImageReceipt = false;

    for (const raw of input.contentBlocks) {
      const block = asRecord(raw);
      if (block.type !== "tool" || typeof block.toolName !== "string") {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
          answeredWithText = true;
        continue;
      }
      const toolName = block.toolName;
      const status = block.status;
      if (status === "running") { runningCalls += 1; continue; }
      if (status === "canceled") { canceledCalls += 1; continue; }
      if (block.output === undefined || !isReadableReceipt(block.output)) {
        // A call with no readable receipt proves nothing about what it did.
        unreadableReceipts += 1;
        continue;
      }
      readableReceipts += 1;
      const output = block.output;
      collectIds(output, JOB_ID_KEYS, jobIds);
      collectIds(output, ASSET_ID_KEYS, assetIds);
      const jobId = firstString(output, JOB_ID_KEYS);
      if (IMAGE_SUBMISSION_TOOLS.has(toolName)) {
        // `refused: true` is the server-owned marker for a request that was
        // rejected BEFORE the submitter was called: no job, no charge. It is a
        // conclusion the receipts support, unlike a bare failure.
        if (output.refused === true) refusals.push(firstString(output, ["error"]) ?? "image_submission_refused");
        else if (jobId) imageJobs += 1;
        // The unknown-transport receipt may already own a durable task. It is
        // deliberately not a refusal (`mastra-image-tool.ts`), so the action must
        // not claim either direction.
        else if (output.status === "unknown") unverifiableImageReceipt = true;
        else if (output.status === "failed") failedCalls += 1;
      }
      if (toolName === "ask_clarification") clarifications += 1;
      if (CANVAS_WRITE_TOOLS.has(toolName)) canvasOperations += 1;
    }

  const observedJobs = [...jobIds];
  const observedAssets = [...assetIds];
  if (clarifications > 0)
    return { kind: "clarification", jobIds: observedJobs, assetIds: observedAssets };
  if (imageJobs > 0)
    return { kind: "generation", jobIds: observedJobs, assetIds: observedAssets };
  if (canvasOperations > 0)
    return { kind: "canvas_operation", jobIds: observedJobs, assetIds: observedAssets };
  // A pre-submission refusal is a positive fact ("nothing was created"), so it is
  // a conclusion and not an `unknown`. It outranks `text_only` because the run
  // tried to act and was stopped.
  if (refusals.length > 0)
    return { kind: "refused", code: refusals[0]!, jobIds: observedJobs, assetIds: observedAssets };
  // Nothing acted, so what is left is a statement about the receipts — and an
  // unreadable one is never rounded into `text_only`.
  const unknown: DesignTurnExecutionUnknownCode | undefined = unverifiableImageReceipt
    ? "image_receipt_unverifiable"
    : failedCalls > 0 ? "tool_failed_without_receipt"
    : runningCalls > 0 ? "tool_execution_report_pending"
    : canceledCalls > 0 ? "run_canceled"
    : unreadableReceipts > 0 ? "no_tool_receipts_readable"
    : undefined;
  if (unknown)
    return { kind: "unknown", code: unknown, jobIds: observedJobs, assetIds: observedAssets };
  // Every receipt the turn had is readable and none of them acted. When the run
  // wrote text it answered the turn; with no receipts at all there is nothing to
  // conclude and a bare `unknown` would be misread as a missing receipt.
  if (readableReceipts > 0 || answeredWithText)
    return { kind: "text_only", jobIds: observedJobs, assetIds: observedAssets };
  return {
    kind: "unknown",
    code: "no_tool_receipts_readable",
    jobIds: observedJobs,
    assetIds: observedAssets,
  };
}

/**
 * Build the whole record.
 *
 * The detected layer is quoted from the caller's own routing verdict and the
 * executed layer is derived only from `contentBlocks`; neither is allowed to
 * influence the other, which is what keeps a mis-route diagnosable instead of
 * self-confirming.
 */
export function buildDesignTurnRecord(input: BuildDesignTurnRecordInput): DesignTurnRecord {
  const blocks = toolBlocks(input.contentBlocks);
  const skillNames: string[] = [];
  const toolUsageCounts: DesignTurnToolUsageCounts = {};
  const jobIds = new Set<string>();
  const assetIds = new Set<string>();

  for (const block of blocks) {
    const toolName = String(block.toolName);
    toolUsageCounts[toolName] = (toolUsageCounts[toolName] ?? 0) + 1;
    if (block.output === undefined || !isReadableReceipt(block.output)) continue;
    collectIds(block.output, JOB_ID_KEYS, jobIds);
    collectIds(block.output, ASSET_ID_KEYS, assetIds);
    for (const name of readSkillNames(toolName, block.output)) {
      if (!skillNames.includes(name) && skillNames.length < DESIGN_TURN_MAX_TOOL_NAMES)
        skillNames.push(name);
    }
  }

  const executed = deriveExecutedAction({ contentBlocks: input.contentBlocks });
  const summary: DesignTurnSummary = {
    // Absent when the router published nothing: a missing verdict is NOT the
    // `non_design` label, so it is never substituted with one.
    ...(input.detected ? { intent: input.detected.intent } : {}),
    // Absent, never invented: a run that read no guide this turn reports none,
    // even when the session certainly read one earlier.
    ...(skillNames.length ? { matchedSkillNames: skillNames } : {}),
    toolUsageCounts,
    executionJobIds: [...jobIds],
    deliveredAssetIds: [...assetIds],
  };

  return {
    runId: input.runId,
    detectedIntent: input.detected ? input.detected.intent : null,
    ...(input.detected?.reasonCode ? { detectedReasonCode: input.detected.reasonCode } : {}),
    ...(input.detected?.source ? { detectedSource: input.detected.source } : {}),
    ...(typeof input.detected?.confidence === "number"
      ? { detectedConfidence: input.detected.confidence }
      : {}),
    executed,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Display copy
// ---------------------------------------------------------------------------

/** The raw router vocabulary, rendered as a label. */
const DETECTED_LABELS: Record<DesignTurnIntent, string> = {
  new_generation: "新一轮生成",
  series_continuation: "沿用当前系列",
  local_edit: "局部修改现有设计",
  non_design: "非设计执行",
};

/**
 * What the run actually did, in the SECOND person of the executed layer — every
 * phrase is a receipt description, so none of them can be produced by an intent.
 */
export function describeDesignTurnExecution(action: DesignTurnExecutedAction): string {
  switch (action.kind) {
    case "generation":
      return action.jobIds.length
        ? `提交生成任务（${action.jobIds.length} 个任务）`
        : "调用生成工具，但没有读到任务号——未确认已提交";
    case "clarification":
      return "向用户提问澄清，没有提交生成";
    case "canvas_operation":
      return "执行画布操作";
    case "refused":
      return `提交前被拒绝（${action.code}），未创建任务、未扣费`;
    case "text_only":
      return "只回复文字，没有创建任务";
    case "unknown":
      return "无法判定（工具回执不可读）";
  }
}

const UNKNOWN_REASONS: Record<DesignTurnExecutionUnknownCode, string> = {
  no_tool_receipts_readable: "本轮有工具调用但没有可读回执",
  tool_execution_report_pending: "本轮结束时仍有工具调用没有结果",
  run_canceled: "本轮被取消，工具结果不完整",
  tool_failed_without_receipt: "工具调用失败且回执没有说明是否提交",
  image_receipt_unverifiable: "图片提交回执状态未知，可能已创建持久任务",
};

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolUsageLine(counts: DesignTurnToolUsageCounts): string | undefined {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return undefined;
  const shown = entries.slice(0, DESIGN_TURN_MAX_TOOL_NAMES).map(([name, count]) => `${name}×${count}`);
  const suffix = entries.length > DESIGN_TURN_MAX_TOOL_NAMES ? "…" : "";
  return shown.join("、") + suffix;
}

export type DesignTurnDisplay = { summary: string; detail?: string };

/**
 * The summary copy, authored on the server next to the receipts it describes.
 *
 * `summary` is the side-by-side line the whole record exists for: 用户意图 (what
 * the router detected) next to what the run actually did. A field with no
 * receipt is either omitted or reported as 未记录 — never filled in with a
 * plausible value.
 *
 * The caller decides who sees what: this function does not know about the
 * advanced-mode gate, and the line is safe to withhold (it is withheld from
 * ordinary users entirely).
 */
export function formatDesignTurnRecord(record: DesignTurnRecord): DesignTurnDisplay {
  const detected = record.detectedIntent
    ? DETECTED_LABELS[record.detectedIntent]
    : "未判定（本轮没有路由结论）";
  const summaryParts = [
    `本轮意图：检测到「${detected}」→ 实际执行「${describeDesignTurnExecution(record.executed)}」`,
  ];
  const tools = toolUsageLine(record.summary.toolUsageCounts);
  if (tools) summaryParts.push(`使用工具：${tools}`);
  else summaryParts.push("使用工具：未记录");
  summaryParts.push(record.summary.executionJobIds.length
    ? `创建任务 ${record.summary.executionJobIds.length} 个（${record.summary.executionJobIds.join("、")}）`
    : "创建任务：0 个");
  summaryParts.push(record.summary.deliveredAssetIds.length
    ? `最终交付资产：${record.summary.deliveredAssetIds.join("、")}`
    : "最终交付资产：未记录");

  const detail: string[] = [];
  if (record.detectedIntent) {
    const basis = record.detectedSource === "model" ? "模型判定"
      : record.detectedSource === "fallback" ? "模型不可用，沿用规则判定" : "规则判定";
    const confidence = typeof record.detectedConfidence === "number"
      ? ` · 置信度 ${Math.round(Math.min(1, Math.max(0, record.detectedConfidence)) * 100)}%` : "";
    const reason = record.detectedReasonCode ? ` · ${record.detectedReasonCode}` : "";
    detail.push(`检测层：${basis}${reason}${confidence}`);
  } else {
    detail.push("检测层：本轮没有路由结论（运行时未发布 design.routing）");
  }
  if (record.executed.kind === "unknown")
    detail.push(`执行层：${UNKNOWN_REASONS[record.executed.code]}`);
  detail.push(record.summary.matchedSkillNames?.length
    ? `匹配到的技能（本轮实际读到正文）：${record.summary.matchedSkillNames.join("、")}`
    : "匹配到的技能：未记录（本轮未读到任何技能正文）");

  return {
    summary: bounded(summaryParts.join("；"), 400),
    detail: bounded(detail.join("\n"), 400),
  };
}
