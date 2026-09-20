/**
 * The deterministic correction for a run that claimed work it had refused to
 * submit.
 *
 * The reproduced defect (2026-09-20 verification, `artifacts/agent-fix-verify-20260920/b`):
 * the user asked for 320×70, `resolveNativeImageRatio` refused with
 * `image_approximation_not_authorized` before any submission — no job, no charge,
 * and the receipt's own text already said 未提交或扣费 — and the assistant then
 * told the user it had been submitted and was generating. A model that ignores an
 * explicit receipt cannot be fixed with better wording, so the truth is restored
 * server-side instead: when the run's persisted assistant message ends in such a
 * claim, ONE correction stating that nothing was submitted is appended after it.
 *
 * Why APPEND and not rewrite: the claim is the last thing the user reads because
 * the earlier card/message keeps its original position — the same trap
 * `appendSettledNotice` documents in `job-canvas-finalizer.ts`. This module is
 * deliberately its sibling: same hashed-UUID id derivation, same "one new row,
 * never an edit of the old one" rule. Every fact the correction states is read
 * from the refusal receipt itself, never re-derived from prose.
 *
 * This is presentation/truth state only. It creates no job, charges nothing,
 * grants nothing, and is written after the run's own message was persisted.
 */
import { createHash } from "node:crypto";

/** The tools whose receipts can refuse an image submission. */
const IMAGE_SUBMISSION_TOOLS = new Set(["generate_image", "edit_image"]);

/**
 * Bound for the reason copied out of the receipt. Every refusal currently quotes
 * a server-authored constant, but the copy is user-visible, so it is bounded here
 * rather than trusted to stay short.
 */
const MAX_REASON_LENGTH = 400;

/**
 * Deterministic id for a run's correction, derived from the run id — the same
 * construction `terminalNoticeId` uses for a settled job. The correction is
 * written with this id, so a replay or a reconnect that reaches the persistence
 * seam again rewrites this row instead of appending a second correction.
 */
export function refusalCorrectionId(runId: string): string {
  const hash = createHash("sha256").update(`${runId}:image-refusal-correction`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A receipt that names a durable job proves the submission was accepted. */
function jobIdOf(output: Record<string, unknown>): string | undefined {
  const id = typeof output.jobId === "string" ? output.jobId : output.job_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Claim phrases that assert submission or work in progress. Each is a positive
 * assertion ("已提交"), never a bare verb, so an honest "没有提交" cannot match
 * one; {@link claimsSubmission} additionally ignores a match a negation precedes.
 */
const SUBMISSION_CLAIMS =
  /已(?:经)?(?:提交|创建|发起|排队|生成|出图)|提交成功|提交完成|正在(?:生成|出图|排队|提交)|(?:生成|出图|排队)中|稍后(?:再)?(?:告诉你|通知你|给你)|出图后(?:告诉你|通知你|给你)/;

/** `matchAll` needs the global flag; the pattern is cloned so no `lastIndex`
 * state is shared between calls. */
function claimMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(new RegExp(SUBMISSION_CLAIMS.source, "g"));
}

/** A negation immediately before a claim phrase makes that phrase a denial. */
const NEGATED_BEFORE = /(?:没有|并未|尚未|未曾|未|没|不|无法|不会|不能|拒绝|取消|失败)[^。！？；\n]{0,6}$/;

/** True when the text makes at least one un-negated submission/in-progress claim. */
export function claimsSubmission(text: string): boolean {
  for (const match of claimMatches(text)) {
    const index = match.index ?? 0;
    if (!NEGATED_BEFORE.test(text.slice(0, index))) return true;
  }
  return false;
}

/** The assistant text that follows the run's last tool activity, which is what
 * the user reads last. Text emitted before a later tool call is not "final". */
function finalText(contentBlocks: readonly unknown[]): string {
  let lastToolIndex = -1;
  contentBlocks.forEach((raw, index) => {
    if (asRecord(raw).type === "tool") lastToolIndex = index;
  });
  return contentBlocks
    .slice(lastToolIndex + 1)
    .map(asRecord)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("");
}

export type ImageRefusalCorrection = { id: string; text: string };

/**
 * The one correction this run owes, or `null` when the run's own message is
 * already true.
 *
 * It fires only when every part of its claim is supported by the receipts:
 * - at least one image receipt is a refusal (`refused: true`, the server-owned
 *   marker described in `mastra-image-tool.ts`) with no `jobId`;
 * - NO image receipt carries a `jobId` (a run that created a job may legitimately
 *   have promised it);
 * - NO image receipt is in an unverifiable state (the unknown-transport receipt
 *   may already own a durable task, so "nothing was submitted" would be a guess);
 * - the run's final text asserts submission or work in progress.
 */
export function imageRefusalCorrection(input: {
  runId: string;
  contentBlocks: readonly unknown[];
}): ImageRefusalCorrection | null {
  let createdJob = false;
  let unverifiable = false;
  const refusals: Record<string, unknown>[] = [];
  for (const raw of input.contentBlocks) {
    const block = asRecord(raw);
    if (block.type !== "tool" || typeof block.toolName !== "string"
      || !IMAGE_SUBMISSION_TOOLS.has(block.toolName)) continue;
    // A block with no receipt at all (the tool threw before producing one, for
    // example a schema rejection) proves nothing was submitted and is ignored.
    if (block.output === undefined) continue;
    const output = asRecord(block.output);
    if (jobIdOf(output)) createdJob = true;
    else if (output.refused === true) refusals.push(output);
    else unverifiable = true;
  }
  if (createdJob || unverifiable || refusals.length === 0) return null;
  if (!claimsSubmission(finalText(input.contentBlocks))) return null;

  const summary = refusals[0]!.summary;
  const reason = typeof summary === "string" && summary.trim()
    ? summary.trim().slice(0, MAX_REASON_LENGTH)
    : "服务端在提交前拒绝了本轮生成请求。";
  const text = `本轮没有提交任何生成任务，也没有扣费；${reason}`;
  return { id: refusalCorrectionId(input.runId), text };
}

/**
 * Append the correction as a NEW message, after the run's own message has been
 * persisted.
 *
 * The writer is injected so this stays free of a database client: the WebSocket
 * seam passes the same session-scoped `chatService.createMessage` it used for the
 * run's message. The deterministic id is what makes the append exactly-once — a
 * replay targets the existing row. Returns whether a correction was owed.
 */
export async function appendImageRefusalCorrection(input: {
  runId: string;
  contentBlocks: readonly unknown[];
  append: (message: {
    id: string;
    role: "assistant";
    content: string;
    contentBlocks: { type: "text"; text: string }[];
  }) => Promise<unknown>;
}): Promise<boolean> {
  const correction = imageRefusalCorrection(input);
  if (!correction) return false;
  await input.append({
    id: correction.id,
    role: "assistant",
    content: correction.text,
    contentBlocks: [{ type: "text", text: correction.text }],
  });
  return true;
}
