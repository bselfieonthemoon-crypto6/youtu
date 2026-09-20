#!/usr/bin/env node
/**
 * Loomic Agent 关键流程固定自动回归套件 (fixed automated regression suite).
 *
 * Closes the checklist item 为关键流程建立自动回归用例：只讨论不生图 / 只给提示词 /
 * 明确生成 / 生成后改口 / 多图系列 / 透明背景 / 多参考图消歧 / 运行中取消 /
 * 删除确认 / 非标准尺寸 / 新话题不继承旧约束。
 *
 * One flow = one documented record in FLOWS below: `id`, the user-facing 中文名,
 * the exact prompt (written to a per-flow .txt file at run time, so PowerShell
 * quoting can never mangle it), the required setup (none / one uploaded
 * reference / two uploads / one canvas image), whether it may spend provider
 * work (`paid`), the machine-checkable expectations and what the flow
 * deliberately does NOT decide.
 *
 * Usage (from the repo root, with the local stack already running):
 *   node --env-file=artifacts/local-replica-20260907/app.env \
 *     apps/server/scripts/agent-regression-flows.mjs
 *   ... --paid                 also run the provider-spending flows
 *   ... --only prompt-only,nonstandard-size-discussion
 *   ... --list                 print the flow table and exit
 *   ... --strict               treat UNVERIFIED as a failure for the exit code
 *
 * Default (no --paid) runs ONLY the zero-cost flows, so a person can safely run
 * it at any time:
 *   只讨论不生图 / 只给提示词 / 多参考图消歧 / 非标准尺寸 / 新话题不继承旧约束
 *
 * The suite never modifies product code. It calls
 * apps/server/scripts/agent-sim-tools.mjs as a child process
 * (`process.execPath` + the script path), one operation per process, and every
 * child's stdout/stderr is captured into a log FILE rather than through a shell
 * pipe. Evidence lives in artifacts/agent-regression-<YYYYMMDD>/:
 *   flows/<id>/prompt-N.txt     the exact prompt handed to the sim tool
 *   flows/<id>/fixture.json     the isolated project + canvas + session
 *   flows/<id>/turn-N.json      the raw turn report the expectations read
 *   flows/<id>/state.json       session transcript + jobs + canvas
 *   flows/<id>/check.json       the sim tool's 8 structural invariants
 *   flows/<id>/result.json      this flow's verdict
 *   flows/<id>/logs/*.log       raw child output per step
 *   report.json / report.md     summary (report-<stamp>.json keeps each run)
 *
 * Nothing is asserted from prose alone. Every expectation reads a turn-report
 * field (`runStatus`, `jobs`, `tools`, `routing`, `assistantMessages`,
 * `canvas`, `attachments`) or the `check` / `state` JSON. When a field cannot
 * decide an expectation it is reported as `unverified`, never as a pass.
 *
 * Status vocabulary:
 *   PASS        every expectation decided true
 *   FAIL        at least one expectation decided false            -> exit 1
 *   SKIP        not run (browser-owned flow, or paid without --paid)
 *   UNVERIFIED  nothing failed, but at least one expectation could not be
 *               decided from the report fields
 *   ERROR       the harness could not produce the evidence for a step -> exit 1
 *
 * 删除确认 is declared here with `runner: "browser"` and its real probe path,
 * and is always reported as SKIPPED: a CLI cannot impersonate a browser tab, so
 * a second probe would be a duplicate, not a regression case.
 *
 * Prose-assertion contract (added 2026-09-20 after the false-FAIL incident in
 * `new-topic-no-inheritance`): an expectation that reads natural language must
 * never FAIL because a reply *quotes, denies or voids* what it mentions. Every
 * such assertion here is clause/scope aware, states its rule in a comment with
 * the incident as the reason, and is listed in PROSE_PROXY_AUDIT below as `fixed`
 * or `flagged` (assertions that read report/state/check JSON are structural and
 * out of scope). The assertions themselves are pinned by a native node:test suite
 * that lives beside this file:
 *   node --test apps/server/scripts/agent-regression-flows.assertions.test.mjs
 */
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/* ===================================================================== paths */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, "..", "..", "..");
const SIM_TOOL = resolve(REPO_ROOT, "apps", "server", "scripts", "agent-sim-tools.mjs");
const DEFAULT_ENV_FILE = resolve(REPO_ROOT, "artifacts", "local-replica-20260907", "app.env");
/** Owned by apps/web/scripts — declared here, never duplicated. */
const DELETE_CONFIRMATION_PROBE = resolve(REPO_ROOT, "apps", "web", "scripts", "check-delete-confirmation.mjs");

const argv = process.argv.slice(2);
function flag(name) {
  const inline = argv.find(argument => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}
function allFlags(name) {
  const out = [];
  argv.forEach((argument, index) => {
    if (argument === `--${name}`) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) out.push(next);
    } else if (argument.startsWith(`--${name}=`)) out.push(argument.slice(name.length + 3));
  });
  return out;
}
const has = name => argv.includes(`--${name}`);

const PAID = has("paid");
const LIST = has("list");
const STRICT = has("strict");
const HELP = has("help") || has("-h");
const ONLY = allFlags("only").flatMap(value => String(value).split(",")).map(value => value.trim()).filter(Boolean);
const API = String(flag("api") ?? process.env.LOOMIC_LIVE_API ?? "http://127.0.0.1:3002");
const ENV_FILE = resolve(String(flag("env-file") ?? DEFAULT_ENV_FILE));
const TURN_TIMEOUT_MINUTES = Number(flag("turn-timeout-minutes") ?? 10);
const WAIT_JOBS_MINUTES = Number(flag("wait-jobs-minutes") ?? 10);

const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const RUN_ROOT = resolve(REPO_ROOT, "artifacts", `agent-regression-${DAY}`);

const rel = path => relative(REPO_ROOT, path).split(sep).join("/");

/* ================================================================ expectations */

const IMAGE_TOOLS = new Set(["generate_image", "edit_image"]);
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "canceled", "dead_letter"]);

const pass = (code, description, observed) => ({ code, description, ok: true, observed });
const fail = (code, description, observed) => ({ code, description, ok: false, observed });
const undecided = (code, description, observed) => ({ code, description, ok: null, observed });
const decide = (condition, code, description, observed) =>
  condition ? pass(code, description, observed) : fail(code, description, observed);

const jobSummary = job => `${job.jobType ?? "?"}/${job.operation ?? "-"}/${job.status}${job.errorCode ? `(${job.errorCode})` : ""}`;
const toolSummary = tool => `${tool.toolName}:${tool.status}`;

/** `null` means "the turn produced no report", which must never pass a check. */
const jobsOf = turn => (turn?.report ? (turn.report.jobs ?? []) : null);
const imageJobsOf = jobs => (jobs ?? []).filter(job => job.jobType === "image_generation");
const imageToolsOf = turn => (turn?.tools ?? []).filter(tool => IMAGE_TOOLS.has(tool.toolName));
const routingOf = turn => turn?.routing ?? [];
const creationRoutingOf = turn => routingOf(turn).filter(item => item.intent && item.intent !== "non_design");

function runCompleted(turn, description = "本轮 agent run 以 completed 结束（超时/失败都不算通过）") {
  if (!turn?.report) return undecided("run_completed", description, { reason: "本轮没有 turn 报告" });
  return decide(turn.runStatus === "completed", "run_completed", description,
    { runStatus: turn.runStatus, runError: turn.runError ?? null });
}
function noJobs(turn, description) {
  const jobs = jobsOf(turn);
  if (!jobs) return undecided("no_jobs", description, { reason: "本轮没有 turn 报告" });
  return decide(jobs.length === 0, "no_jobs", description, { jobCount: jobs.length, jobs: jobs.map(jobSummary) });
}
function noImageToolCall(turn, description = "本轮不得调用 generate_image / edit_image（任何状态都算）") {
  if (!turn?.report) return undecided("no_image_tool_call", description, { reason: "本轮没有 turn 报告" });
  const calls = imageToolsOf(turn);
  return decide(calls.length === 0, "no_image_tool_call", description, { imageToolCalls: calls.map(toolSummary) });
}
function noSuccessfulImageTool(turn, description = "不得出现成功的 generate_image / edit_image 调用") {
  if (!turn?.report) return undecided("no_successful_image_tool_call", description, { reason: "本轮没有 turn 报告" });
  const completed = imageToolsOf(turn).filter(tool => tool.status === "completed");
  return decide(completed.length === 0, "no_successful_image_tool_call", description,
    { completedImageTools: completed.map(toolSummary) });
}
/** The report must not publish a creation/continuation/edit round for a turn the
 * user closed to generation. An empty `routing` array is "nothing published",
 * which is decidable and acceptable for a discussion turn. */
function noCreationRouting(turn, description = "报告不得发布 new_generation / series_continuation / local_edit 路由") {
  if (!turn?.report) return undecided("no_creation_routing", description, { reason: "本轮没有 turn 报告" });
  const creation = creationRoutingOf(turn);
  return decide(creation.length === 0, "no_creation_routing", description,
    { published: routingOf(turn).map(item => `${item.intent}/${item.reasonCode ?? "-"}/${item.source ?? "-"}`),
      creationIntents: creation.map(item => item.intent) });
}
function replyPresent(turn, minChars, code = "reply_present", description = "本轮必须给出可见回复") {
  if (turn?.replyAuthority === "none") return fail(code, description, { replySource: turn.replySource, replyChars: 0 });
  if (turn?.replyAuthority === "partial") return undecided(code, description, { replySource: turn.replySource, replyChars: turn.reply.length });
  return decide(turn.reply.trim().length >= minChars, code, description,
    { replySource: turn.replySource, replyChars: turn.reply.trim().length, minChars, excerpt: turn.reply.trim().slice(0, 240) });
}
/**
 * "回复不得声称已经生成/交付了图片" — clause-scoped, fixed in the same pass as the
 * old-topic rule because it is the same class of proxy: the first version matched
 * /已(?:经)?(?:生成|出图|交付|…)/ anywhere in the reply, so a sentence that
 * explicitly DENIES delivery ("本轮不会生成图片，也没有已生成的结果") read as a
 * claim — the reply was punished for quoting the very thing it refused. A claim
 * now requires the matched verb to sit in a clause whose immediate neighbourhood
 * carries no negation (不/没/未/别/勿/无/尚未/不会/不能/无法/还没…), so the denial
 * clause is exempt while a real claim in a neighbouring clause still fails.
 */
const GENERATION_CLAIM = /(?:已(?:经)?(?:生成|出图|交付|完成生成)|生成完成|图片已生成|已完成生成)/;
const CLAIM_NEGATION = /(?:不|没|未|别|勿|无|尚未|不会|不能|无法|不必|无需|还没|否认|毋需)/;
function generationClaimClause(reply) {
  for (const sentence of String(reply).split(SENTENCE_SPLIT)) {
    const match = GENERATION_CLAIM.exec(sentence);
    if (!match) continue;
    const [from, to] = clauseBounds(sentence, match.index, match.index + match[0].length);
    const clause = sentence.slice(from, to);
    const neighbourhood = clause.slice(Math.max(0, match.index - from - 8), match.index - from);
    if (CLAIM_NEGATION.test(neighbourhood)) continue;
    return clause.trim().slice(0, 160);
  }
  return null;
}
function noGenerationClaim(turn, description = "回复不得声称已经生成/交付了图片") {
  if (turn?.replyAuthority === "none") return undecided("no_generation_claim", description, { reason: "没有可见回复可判定" });
  const claim = generationClaimClause(turn.reply);
  if (claim) return fail("no_generation_claim", description, { claimClause: claim, excerpt: turn.reply.slice(0, 240) });
  return pass("no_generation_claim", description, { claimClause: null, replySource: turn.replySource });
}
function noCanvasDelivery(turn, description = "本轮画布不得新增图片元素") {
  const canvas = turn?.report?.canvas;
  if (!canvas) return undecided("no_canvas_delivery", description, { reason: "报告没有 canvas 摘要" });
  return decide((canvas.images ?? []).length === 0, "no_canvas_delivery", description,
    { canvasImages: (canvas.images ?? []).length, canvasElementCount: canvas.elementCount ?? null });
}
function imageJobCount(jobs, expected, code, description) {
  if (!jobs) return undecided(code, description, { reason: "没有 state/报告可读取任务列表" });
  const imageJobs = imageJobsOf(jobs);
  return decide(imageJobs.length === expected && new Set(imageJobs.map(job => job.id)).size === expected,
    code, description,
    { imageJobCount: imageJobs.length, distinctJobIds: new Set(imageJobs.map(job => job.id)).size,
      jobs: imageJobs.map(job => ({ id: job.id, status: job.status, errorCode: job.errorCode ?? null })) });
}
function jobsTerminal(jobs, code, description) {
  if (!jobs) return undecided(code, description, { reason: "没有 state/报告可读取任务列表" });
  const unfinished = jobs.filter(job => !TERMINAL_JOB_STATUSES.has(job.status));
  return decide(unfinished.length === 0, code, description,
    { statuses: jobs.map(job => `${job.id.slice(0, 8)}:${job.status}`), unfinished: unfinished.map(job => `${job.id.slice(0, 8)}:${job.status}`) });
}
function imageJobSucceeded(jobs, code, description) {
  if (!jobs) return undecided(code, description, { reason: "没有 state/报告可读取任务列表" });
  const imageJobs = imageJobsOf(jobs);
  const failed = imageJobs.filter(job => job.status !== "succeeded");
  return decide(imageJobs.length > 0 && failed.length === 0, code, description,
    { jobs: imageJobs.map(job => ({ id: job.id, status: job.status, errorCode: job.errorCode ?? null,
      errorMessage: job.errorMessage ?? null })) });
}
function structuralInvariants(ctx) {
  const verdict = ctx.check;
  const description = "agent-sim-tools check：8 条结构不变量全部通过";
  if (!verdict) {
    const failedStep = ctx.steps.find(step => step.step.endsWith("-check") && step.exitCode !== 0);
    return undecided("structural_invariants", description,
      { reason: "check 没有产出 verdict", checkExitCode: failedStep?.exitCode ?? null, log: failedStep?.log ?? null });
  }
  return decide(verdict.ok === true, "structural_invariants", description,
    { violations: verdict.violations ?? [], counts: verdict.counts ?? null });
}
function harnessStepsOk(ctx) {
  const failedSteps = ctx.steps.filter(step => !step.expectFailure && step.exitCode !== 0);
  return decide(failedSteps.length === 0, "harness_steps_ok", "所有 sim 步骤都以 exit 0 结束",
    { steps: ctx.steps.map(step => `${step.step}:${step.exitCode ?? `spawn-error(${step.spawnError})`}`),
      failed: failedSteps.map(step => ({ step: step.step, exitCode: step.exitCode, log: step.log })) });
}

/* --------------------------------------------------------------------------- *
 * Prose assertions.                                                            *
 * Everything below reads natural-language reply text, so each rule has to say  *
 * how it decides — and what it refuses to decide — or it becomes a proxy that  *
 * a reply can satisfy, or break, merely by quoting the words in question.      *
 * --------------------------------------------------------------------------- */

/** Sentence cut shared by every prose assertion (no trim: indexes stay valid). */
const SENTENCE_SPLIT = /(?<=[。；！？!?;\n])/;
/** Clause cut inside one sentence. Brackets/quotes are deliberately NOT
 * delimiters: a copy label may wrap its value (文案「夏日上新」) and the label has
 * to stay visible to the assignment test. */
const CLAUSE_DELIMITER = /[，、；：,;:]/;

/**
 * "非标准尺寸" expectation: the discussion must not claim an exact 320×70 output.
 *
 * Rule (documented so it can be argued with): split the reply into sentences; a
 * sentence is a claim only when it names 320×70, contains a completion-aspect
 * delivery verb (已生成/已交付/生成完成/…) or a precision-delivery verb pair
 * (输出/产出/生成 + 精确/正好), and contains no negation, approximation or
 * conditional marker. Questions are never claims.
 *
 * FLAGGED (see PROSE_PROXY_AUDIT): the suppression marker is SENTENCE scoped, so
 * a negation in one clause can excuse a real claim in another clause of the same
 * sentence — the mirror image of the quoted-token defect. It has not produced a
 * false FAIL (the direction that hides regressions in noise is the opposite one:
 * a false PASS), and tightening it would change the live baseline of a flow this
 * pass does not own, so it is left as-is and recorded instead.
 */
const PIXEL_SIZE = /320\s*[×xX*]\s*70/;
const DELIVERY_COMPLETION = /(?:已(?:经)?(?:生成|交付|导出|完成|产出|给出|输出|提交|做好|得到|获得)|生成完成|提交完成|交付完成|输出完成|已完成|做好了)/;
const DELIVERY_PRECISE = /(?:输出|产出|生成|交付|得到|获得|保证|确保)[^。；！？\n]{0,12}(?:精确|精准|正好|恰好)/;
const NON_CLAIM_MARKER = /(?:无法|不能|不会|不可|不要|不用|未能|没有|尚未|未|并非|不是|不保证|不承诺|不声称|不精确|近似|差不多|接近|如果|若|假如|裁切|裁剪|缩放|自己再|你自己)/;
function exactPixelClaimSentence(reply) {
  for (const raw of String(reply).split(SENTENCE_SPLIT)) {
    const sentence = raw.trim();
    if (!sentence || /[？?]/.test(sentence)) continue;
    if (!PIXEL_SIZE.test(sentence)) continue;
    if (NON_CLAIM_MARKER.test(sentence)) continue;
    if (DELIVERY_COMPLETION.test(sentence) || DELIVERY_PRECISE.test(sentence)) return sentence;
  }
  return null;
}
function noExactPixelClaim(turn) {
  const description = "回复不得声称已经产出/交付了精确 320×70 像素的成品";
  if (turn?.replyAuthority !== "full") {
    return undecided("no_exact_pixel_claim", description,
      { reason: "回复不可读，无法判定是否作了精确像素声明", replySource: turn?.replySource ?? "none" });
  }
  const claim = exactPixelClaimSentence(turn.reply);
  return decide(claim === null, "no_exact_pixel_claim", description,
    { claimSentence: claim, replyChars: turn.reply.length });
}

/**
 * "新话题不继承旧约束": CLAUSE-SCOPED inheritance detection with application evidence.
 *
 * INCIDENT (the reason this rule exists). The first version of this expectation
 * was a raw substring scan over the whole reply:
 *     OLD_TOPIC_TOKENS.filter(token => second.reply.includes(token))
 * It reported FAIL on four consecutive full runs on 2026-09-20
 * (report-2026-09-20T08-36-18, 08-59-00, 09-34-55, 12-09-35), every time because
 * the old-topic words appeared inside the sentence that VOIDS them, e.g.
 *   「这是一个全新任务，之前青原保温壶的品牌、产品、文案和 3:2 尺寸全部作废，不沿用。」
 *   「**前一轮设定已作废**：青原保温壶、哑光绿、夏日上新、3:2 全部不带入本任务。」
 * The product behaviour was correct — the same turn's routing_not_series_continuation
 * and new_topic_reply_is_about_new_subject passed — so the CHECK was the defect.
 * A wrong FAIL is worse than no check: it trains people to ignore the suite and it
 * buries real regressions in noise.
 *
 * RULE. A forbidden token counts as inheritance only when BOTH hold:
 *   1. it is not voided (see voidCover below), and
 *   2. it carries application evidence (see applicationEvidence below), i.e. the
 *      sentence presents it as THIS turn's active setting.
 * Void scope (computed inside one sentence; a void in one sentence never covers
 * another sentence):
 *   - VOID_BACKWARD (作废/无效/不作数/清空/重置/…): Chinese puts the object before
 *     the predicate, so it voids the tokens before it in the sentence; it voids the
 *     tokens after it only when it introduces a list with a colon (已作废：A、B).
 *   - VOID_NEGATED_USE (不再沿用/不使用/不带入/不继承/…) and VOID_FORWARD
 *     (放弃/弃用/忘掉/删除/…): the object may sit on either side, so they void the
 *     tokens before them in the sentence and the tokens after them in their own
 *     clause.
 *   - VOID_CONTRAST (相比/不同于/不是/并非/无关/…): voids the tokens in its clause.
 * Void scope beats application evidence, because a discarded enumeration may
 * legitimately name the settings it throws away: 「之前的品牌青原保温壶、主色哑光绿
 * 全部作废」 is not reuse.
 * Application evidence (inside the token's own clause only): a setting noun assigns
 * the token (品牌青原 / 主色是哑光绿 / 文案「夏日上新」), the token is named as a
 * setting (哑光绿作为主色), or a negation-guarded application verb carries it
 * (沿用/继续用/保持/改用/… — so 不沿用 can never read as 沿用).
 * A token that is neither voided nor applied is NOT a pass: prose alone cannot tell
 * a passing comparison from a silent carry-over, so it is reported as `unverified`
 * (ok: null) for a human to read — never as PASS and never as FAIL.
 * The forbidden-token list is deliberately NOT weakened: one applied token fails
 * the expectation (self-tested in agent-regression-flows.assertions.test.mjs).
 *
 * KNOWN LIMITS (deliberate, so nobody mistakes them for coverage):
 *   - Application evidence is clause-local (a setting noun or verb within ~4 chars
 *     of the token). A carry-over whose verb sits in the final clause of a 、-list
 *     ("青原保温壶的品牌、产品、文案全部沿用") is reported unverified, not failed:
 *     widening evidence to sentence scope would also judge "青原保温壶项目已收尾，
 *     书店沿用夜间暖光" as inheritance — a false FAIL, the exact defect fixed here.
 *   - A reply can reuse the old setting without naming any forbidden token
 *     ("沿用之前的品牌"); a token-based check cannot see that and does not claim to.
 */
const OLD_TOPIC_TOKENS = ["青原", "保温壶", "夏日上新", "哑光绿"];

/** Bare discard predicates: their object normally PRECEDES them in Chinese. */
const VOID_BACKWARD = /(?:作废|无效|不作数|已废弃|废弃|全部不要|清空|重置|清除)/;
/** Negated-use forms: the object may precede or follow ("不再沿用 X" / "X 不再沿用"). */
const VOID_NEGATED_USE = /(?:不再沿用|不再使用|不再采用|不再保留|不再继续|不沿用|不使用|不采用|不保留|不继续|不继承|不带入|不要沿用|不要用|别沿用|勿沿用|无需沿用|不用沿用)/;
/** Directives whose object FOLLOWS them ("放弃旧方案"). */
const VOID_FORWARD = /(?:放弃|弃用|停用|忘掉|忘记|删除|移除|去掉|脱离|另起|重新开始|重来)/;
/** Contrast markers: the token is being compared with, or separated from, the new task.
 * Deliberately limited to contrast/negation of the token itself: 全新 and 另一个 were
 * removed because they can sit in the SAME clause as an applied token
 * ("全新方案沿用青原保温壶"), and void scope would then swallow a real inheritance. */
const VOID_CONTRAST = /(?:不同于|区别于|无关|不相关|没有任何关系|相比|对比|不是|并非)/;

/** Setting nouns that can assign a value to the current turn. */
const SETTING_NOUN = "(?:品牌名|品牌色|品牌|产品名|产品|主色调|主色|配色|色调|色系|颜色|文案|主题|系列|尺寸|比例|风格|视觉|画面|素材|字体)";
/** Only these may sit between a setting noun and its value (品牌 青原 / 主色是哑光绿). */
const ASSIGN_GAP = "(?:是|为|用|定|做|选|按|照|沿用|采用|保持|保留|继续|：|:|、|\\s|\\*)*";
const ASSIGNMENT_BEFORE = new RegExp(`${SETTING_NOUN}(?:名|色)?${ASSIGN_GAP}$`);
const ASSIGNMENT_AFTER = /^(?:[^，。；：、\n]{0,3})?(?:作为|为|是|定为|设为|用作|做|成为)(?:品牌名|品牌|主色调|主色|配色|色调|色系|文案|主题|系列|尺寸|比例|风格)/;
/** Application verbs; the lookbehind is what keeps 不沿用 / 不再用 / 弃用 from reading as use. */
const APPLY_VERB = "(?:沿用|延用|继续|保持|保留|采用|使用|改用|改为|改成|切换到|转向|统一|一致|照旧|照常|同上|仍然|仍|依然|依旧|还是|不变|固定为|定为|设为|作为|按|照|用)";
const NOT_NEGATED = "(?<!不再|不|没|未|别|勿|弃|停|免|无需)";
const APPLICATION_BEFORE = new RegExp(`${NOT_NEGATED}${APPLY_VERB}[^，。；：、\\n]{0,4}$`);
const APPLICATION_AFTER = new RegExp(`^[^，。；：、\\n]{0,2}${NOT_NEGATED}${APPLY_VERB}`);

/** Clause bounds around one token occurrence, inside one sentence. */
function clauseBounds(sentence, start, end) {
  let from = 0;
  for (let index = start - 1; index >= 0; index--) if (CLAUSE_DELIMITER.test(sentence[index])) { from = index + 1; break; }
  let to = sentence.length;
  for (let index = end; index < sentence.length; index++) if (CLAUSE_DELIMITER.test(sentence[index])) { to = index; break; }
  return [from, to];
}
function sameClause(sentence, first, second) {
  return !CLAUSE_DELIMITER.test(sentence.slice(Math.min(first, second), Math.max(first, second)));
}
/** Why (if at all) this sentence voids the token at `index`; `null` means "not voided". */
function voidCover(sentence, index, length) {
  const end = index + length;
  const backward = VOID_BACKWARD.exec(sentence);
  if (backward) {
    if (index < backward.index) return `void-before:${backward[0]}`;
    const after = sentence.slice(backward.index + backward[0].length);
    if (end > backward.index + backward[0].length && /^[\s*]*[:：]/.test(after)) return `void-colon-list:${backward[0]}`;
  }
  for (const marker of [VOID_NEGATED_USE, VOID_FORWARD]) {
    const match = marker.exec(sentence);
    if (!match) continue;
    const markerEnd = match.index + match[0].length;
    if (index < match.index) return `void-object-of:${match[0]}`;
    if (end > markerEnd && sameClause(sentence, match.index, index)) return `void-after:${match[0]}`;
  }
  const contrast = VOID_CONTRAST.exec(sentence);
  if (contrast && sameClause(sentence, contrast.index, index)) return `void-contrast:${contrast[0]}`;
  return null;
}
/** Why (if at all) this token is presented as the current turn's setting. */
function applicationEvidence(clause, offset, token) {
  const before = clause.slice(0, offset);
  const after = clause.slice(offset + token.length);
  const assignment = ASSIGNMENT_BEFORE.exec(before);
  if (assignment) return `setting-assigns:${assignment[0]}`;
  const named = ASSIGNMENT_AFTER.exec(after);
  if (named) return `named-as-setting:${named[0]}`;
  const verbBefore = APPLICATION_BEFORE.exec(before);
  if (verbBefore) return `apply-verb-before:${verbBefore[0]}`;
  const verbAfter = APPLICATION_AFTER.exec(after);
  if (verbAfter) return `apply-verb-after:${verbAfter[0]}`;
  return null;
}
const evidenceRecord = (token, sentence, extra) => ({ token, sentence: sentence.trim().slice(0, 160), ...extra });
/**
 * Classify every old-topic token occurrence in `reply`.
 * reused     -> presented as this turn's setting            (inheritance)
 * disavowed  -> quoted only to be voided/refused/contrasted  (innocent)
 * unclear    -> mentioned with no void and no application    (unverifiable)
 */
function oldConstraintUse(reply, tokens = OLD_TOPIC_TOKENS) {
  const reused = [];
  const disavowed = [];
  const unclear = [];
  for (const sentence of String(reply).split(SENTENCE_SPLIT)) {
    if (!sentence.trim()) continue;
    for (const token of tokens) {
      for (let index = sentence.indexOf(token); index >= 0; index = sentence.indexOf(token, index + token.length)) {
        const [from, to] = clauseBounds(sentence, index, index + token.length);
        const cover = voidCover(sentence, index, token.length);
        const evidence = cover ? null : applicationEvidence(sentence.slice(from, to), index - from, token);
        if (cover) disavowed.push(evidenceRecord(token, sentence, { voidedBy: cover }));
        else if (evidence) reused.push(evidenceRecord(token, sentence, { evidence }));
        else unclear.push(evidenceRecord(token, sentence, { reason: "既未被作废/对比，也没有被当作本轮设定使用" }));
      }
    }
  }
  return { reused, disavowed, unclear };
}
/** The flow's expectation, with a decidable PASS / FAIL and an honest UNVERIFIED. */
function newTopicExcludesOldConstraints(turn) {
  const description = "第 2 轮回复不得把第 1 轮的品牌/产品/文案/尺寸当作本轮生效设定（引用后作废/不沿用不算复用）";
  if (turn?.replyAuthority !== "full") {
    return undecided("new_topic_excludes_old_constraints", "回复不可读，无法判定是否复用旧约束",
      { replySource: turn?.replySource ?? "none" });
  }
  const { reused, disavowed, unclear } = oldConstraintUse(turn.reply);
  const observed = {
    appliedTokens: reused.map(record => record.token),
    appliedEvidence: reused.map(record => `${record.token}<-${record.evidence}`),
    voidedTokens: disavowed.map(record => record.token),
    undecidedTokens: unclear.map(record => record.token),
    forbidden: OLD_TOPIC_TOKENS,
    excerpt: turn.reply.trim().slice(0, 240),
  };
  if (reused.length) {
    return fail("new_topic_excludes_old_constraints", description,
      { ...observed, appliedSentences: reused.map(record => record.sentence) });
  }
  if (unclear.length) {
    return undecided("new_topic_excludes_old_constraints", description,
      { ...observed, reason: "旧话题特征词既未被作废、也没有被当作本轮设定使用：文字层面无法判定，交人复核",
        undecidedSentences: unclear.map(record => record.sentence) });
  }
  return pass("new_topic_excludes_old_constraints", description, observed);
}

/* --------------------------------------------------------------------------- *
 * PROSE_PROXY_AUDIT — every expectation in this file that judges natural        *
 * language rather than a structured report field, with its disposition and why. *
 * Audit performed 2026-09-20 after the `new-topic-no-inheritance` false FAIL.   *
 * Dispositions:                                                                 *
 *   fixed      — rule rewritten in this pass (scope/negation aware, self-tested)*
 *   flagged    — known proxy kept as-is; its weakness is stated here. It can    *
 *                only produce a false PASS (a real regression slipping through),*
 *                never a false FAIL, and it has produced neither so far.        *
 * Anything reading turn-report/state/check JSON (runStatus, jobs, tools,        *
 * routing, canvas, attachments, harness steps) is structural and out of scope.  *
 * --------------------------------------------------------------------------- */
const PROSE_PROXY_AUDIT = [
  { code: "new_topic_excludes_old_constraints", where: "new-topic-no-inheritance", disposition: "fixed",
    note: "raw substring scan over the reply -> void-cover + application-evidence rule; incident 2026-09-20 (4 false FAILs)" },
  { code: "no_generation_claim", where: "discussion-only / prompt-only", disposition: "fixed",
    note: "claim regex read a denial clause (没有已生成/不会生成) as a claim -> clause-scoped negation guard" },
  { code: "no_exact_pixel_claim", where: "nonstandard-size-discussion", disposition: "flagged",
    note: "sentence-scoped NON_CLAIM_MARKER: a negation in one clause excuses a claim in another (false PASS direction)" },
  { code: "reply_is_prompt_text", where: "prompt-only", disposition: "flagged",
    note: "/提示词|prompt/ + length can be satisfied by quoting the word; only asserts delivery form is text" },
  { code: "clarification_instead_of_job", where: "multi-reference-disambiguation", disposition: "flagged",
    note: "/请明确|需要你|澄清|哪一张/ over prose is satisfiable by a negated sentence; the structural image-tool refusal path is unaffected" },
  { code: "discusses_size", where: "nonstandard-size-discussion", disposition: "flagged",
    note: "/320|70|尺寸|比例|像素/ can be satisfied by mentioning the size in order to refuse it" },
  { code: "new_topic_reply_is_about_new_subject", where: "new-topic-no-inheritance", disposition: "flagged",
    note: "/书店|宠物|猫/ can be satisfied by a negated mention; positive-content proxy only" },
  { code: "routing_background_removal", where: "transparent-background", disposition: "flagged",
    note: "mentionsRemoval fallback regexes routing summary prose; the structural signal is primarySkill" },
  { code: "reply_present", where: "discussion-only / prompt-only", disposition: "flagged",
    note: "length-only presence check: cannot be satisfied or broken by quoting, but it does not prove the reply is on the requested subject" },
];

/* ====================================================================== flows */

/**
 * The FIXED suite. Order is stable; `--only` filters by id or 中文名.
 *
 * `paid: true` means the flow submits real provider work and therefore never
 * runs without `--paid`. `runner: "browser"` means another workstream owns the
 * probe and this orchestrator only declares + skips it.
 */
const FLOWS = [
  {
    id: "discussion-only",
    name: "只讨论不生图",
    paid: false,
    setup: "none",
    summary: "用户只要方向讨论：必须给出可见回复，且不得提交任务、不得调用图片工具、不得发布创建轮路由。",
    declared: ["run 以 completed 结束", "jobs = 0", "没有 generate_image / edit_image 调用", "没有 new_generation/series_continuation/local_edit 路由", "有可见回复", "回复不声称已生成图片"],
    turns: [{
      prompt: "我想给一家做手冲咖啡的小店做整套视觉，先聊聊整体方向就行。现在不要生成图片，也不要提交任何任务，先告诉我你建议的路线和取舍。",
    }],
    notVerified: ["方案本身的创意质量（本套件只断言结构事实，不评价设计好坏）"],
    decide: ({ turns }) => {
      const turn = turns[0];
      return [runCompleted(turn), noJobs(turn, "只讨论不生图：本轮必须 0 个任务"), noImageToolCall(turn),
        noCreationRouting(turn), replyPresent(turn, 40), noGenerationClaim(turn)];
    },
  },
  {
    id: "prompt-only",
    name: "只给提示词",
    paid: false,
    setup: "none",
    summary: "用户只要可直接粘贴的提示词文本：回复必须是提示词正文，且 0 任务、不调用图片工具。",
    declared: ["run 以 completed 结束", "jobs = 0", "没有 generate_image / edit_image 调用", "回复含提示词标记且 ≥150 字符", "回复不声称已生成图片"],
    turns: [{
      prompt: "帮我写一份可以直接粘贴给绘图模型的图片提示词，主题是“秋日限定桂花拿铁”的外卖主图。我只要提示词文本，不要生成图片，也不要提交任何任务。",
    }],
    notVerified: ["提示词的实际出图效果（需要付费生成，本流程只验证交付形态是文本）"],
    decide: ({ turns }) => {
      const turn = turns[0];
      const hasMarker = /提示词|prompt/i.test(turn.reply);
      const longEnough = turn.reply.trim().length >= 150;
      const promptText = turn.replyAuthority === "full"
        ? decide(hasMarker && longEnough, "reply_is_prompt_text",
          "回复必须是可直接使用的提示词文本（含“提示词/prompt”标记且正文 ≥150 字符）",
          { hasPromptMarker: hasMarker, replyChars: turn.reply.trim().length, excerpt: turn.reply.trim().slice(0, 240) })
        : undecided("reply_is_prompt_text", "回复不可读，无法判定交付形态", { replySource: turn.replySource });
      return [runCompleted(turn), noJobs(turn, "只给提示词：本轮必须 0 个任务"), noImageToolCall(turn), promptText, noGenerationClaim(turn)];
    },
  },
  {
    id: "multi-reference-disambiguation",
    name: "多参考图消歧",
    paid: false,
    setup: "two uploads",
    summary: "同一轮挂两张参考图并要求“只参考其中一张”：必须先澄清用哪张，不得直接提交任务。",
    declared: ["第 1 轮 1 张参考图、第 2 轮 2 张参考图", "两轮 run 都 completed", "两轮 jobs = 0", "没有成功的图片工具调用", "有澄清提问或工具以来源歧义拒绝", "画布没有新增图片"],
    turns: [
      { attach: [1], prompt: "这是我上传的一张参考图。请先告诉我你从这张图里看出什么构图和主色倾向，不要生成图片，也不要提交任务。" },
      { attach: [1, 2], prompt: "我再给你一张参考图。现在请只参考其中一张做一张新的活动海报，主色和构图都照那一张来，另一张不要用。" },
    ],
    notVerified: ["澄清之后用户选定参考图的第二轮生成（需要付费出图，不在本流程内）"],
    decide: ({ turns }) => {
      const [first, second] = turns;
      const firstAttachments = (first.report?.attachments ?? []).length;
      const secondAttachments = (second.report?.attachments ?? []).length;
      const refusal = imageToolsOf(second).find(tool => tool.status === "failed"
        && /source_grounding|ambiguous|multiple_matches|clarification|请明确/.test(JSON.stringify(tool.error ?? "")));
      const asksQuestion = /[？?]/.test(second.reply) || /(?:请(?:明确|确认|告诉|选择)|哪一?张|哪一?个|澄清|无法确定|不明确|需要你)/.test(second.reply);
      const clarification = second.replyAuthority !== "full" && !refusal
        ? undecided("clarification_instead_of_job", "两张参考图有歧义时必须先澄清；回复不可读，无法判定",
          { replySource: second.replySource })
        : decide(Boolean(refusal) || asksQuestion, "clarification_instead_of_job",
          "两张参考图有歧义时：图片工具应以来源歧义拒绝，或回复提出澄清问题，而不是直接提交任务",
          { refusal: refusal ? `${refusal.toolName}:${JSON.stringify(refusal.error ?? {})}` : null,
            questionMark: /[？?]/.test(second.reply), excerpt: second.reply.trim().slice(0, 240) });
      return [
        decide(firstAttachments === 1, "one_reference_registered", "第 1 轮只挂 1 张参考图（setup 生效）", { attachmentCount: firstAttachments }),
        decide(secondAttachments === 2, "two_references_registered", "第 2 轮挂 2 张参考图（setup 生效）", { attachmentCount: secondAttachments }),
        runCompleted(first), runCompleted(second),
        noJobs(first, "参考图分析轮：不得提交任务"), noJobs(second, "消歧轮：歧义未澄清前不得提交任务"),
        noImageToolCall(first), noSuccessfulImageTool(second), clarification,
        noCanvasDelivery(second),
      ];
    },
  },
  {
    id: "nonstandard-size-discussion",
    name: "非标准尺寸",
    paid: false,
    setup: "none",
    summary: "320×70 的讨论路径：0 任务、不调用图片工具，且不得声称已产出精确 320×70 像素。",
    declared: ["run 以 completed 结束", "jobs = 0", "没有 generate_image / edit_image 调用", "回复不得声称已交付精确 320×70", "回复必须谈到尺寸/比例"],
    turns: [{
      prompt: "我要做一张 320×70 像素的商城活动顶栏，文案是“夏日上新”。请先说明这种非标准尺寸你会怎么做、最终会交付多少像素；暂时不要生成图片，也不要提交任务。",
    }],
    notVerified: ["近似比例的实际出图与像素（需要付费生成并下载结果核对，本流程只验证讨论路径）",
      "回复里的像素声明用句子级正则判定：句中出现否定/近似/条件标记即不视为声明"],
    decide: ({ turns }) => {
      const turn = turns[0];
      const mentionsSize = /320|70|比例|尺寸|像素/.test(turn.reply);
      const sizeDiscussion = turn.replyAuthority === "full"
        ? decide(mentionsSize, "discusses_size", "回复必须正面谈到目标尺寸/比例，而不是回避",
          { mentionsSize, excerpt: turn.reply.trim().slice(0, 240) })
        : undecided("discusses_size", "回复不可读，无法判定是否谈到尺寸", { replySource: turn.replySource });
      return [runCompleted(turn), noJobs(turn, "非标准尺寸讨论路径：本轮必须 0 个任务"),
        noImageToolCall(turn), noExactPixelClaim(turn), sizeDiscussion];
    },
  },
  {
    id: "new-topic-no-inheritance",
    name: "新话题不继承旧约束",
    paid: false,
    setup: "none",
    summary: "第 1 轮给出品牌/产品/文案约束，第 2 轮换全新话题：新话题回复不得把旧约束当作本轮生效设定，路由不得判为系列延续。",
    declared: ["两轮 run 都 completed", "两轮 jobs = 0", "第 2 轮回复不把旧话题特征词（青原/保温壶/夏日上新/哑光绿）当作本轮生效设定（引用后作废/不沿用不算复用）", "第 2 轮回复必须谈新话题（书店/宠物/猫）", "第 2 轮路由不是 series_continuation"],
    turns: [
      { prompt: "我要做青原保温壶的夏日上新系列视觉，品牌主色是哑光绿，文案固定为“夏日上新”，尺寸按 3:2。先给我一份两张图的文字规划，现在不要生成图片，也不要提交任务。" },
      { prompt: "换一个全新的任务：请为一家宠物友好书店设计周五晚间活动视觉，主题“猫咪陪你读到打烊”。之前的品牌、产品、文案和尺寸设定全部作废，不要沿用，也不要生成图片或提交任务，先只确认新方向。" },
    ],
    notVerified: ["生成之后 session_design_context.series 的不继承（讨论轮不写入设计回执，mastra-runtime.ts:857 只在真实设计写入时替换系列），这里验证的是对话层面的不继承：回复文本与路由",
      "旧特征词「既未被作废、也没有被当作本轮设定使用」的中性提及记为 unverified 而不是失败：仅凭文字无法区分“顺带比较”和“悄悄沿用”，交人复核（应用动词落在列举句末的写法，如「…、…全部沿用」，同样记为 unverified）"],
    decide: ({ turns }) => {
      const [first, second] = turns;
      const talksAboutNewTopic = /(书店|宠物|猫)/.test(second.reply);
      const routingB = routingOf(second);
      const seriesContinuation = routingB.filter(item => item.intent === "series_continuation");
      const newTopicText = [
        newTopicExcludesOldConstraints(second),
        second.replyAuthority === "full"
          ? decide(talksAboutNewTopic, "new_topic_reply_is_about_new_subject",
            "第 2 轮回复必须谈新话题（出现 书店/宠物/猫）",
            { talksAboutNewTopic, excerpt: second.reply.trim().slice(0, 240) })
          : undecided("new_topic_reply_is_about_new_subject", "回复不可读，无法判定是否谈新话题", { replySource: second.replySource }),
      ];
      return [runCompleted(first), runCompleted(second),
        noJobs(first, "第 1 轮规划：必须 0 个任务"), noJobs(second, "第 2 轮新话题讨论：必须 0 个任务"),
        noImageToolCall(first), noImageToolCall(second),
        ...newTopicText,
        decide(seriesContinuation.length === 0, "routing_not_series_continuation",
          "第 2 轮不得被判为系列延续（series_continuation）",
          { published: routingB.map(item => `${item.intent}/${item.reasonCode ?? "-"}`) })];
    },
  },

  /* ------------------------------------------------- paid: real provider work */

  {
    id: "explicit-generation",
    name: "明确生成",
    paid: true,
    setup: "none",
    summary: "用户明确要求现在生成：恰好提交 1 个 image_generation 任务，且任务最终成功。",
    declared: ["run 以 completed 结束", "有成功的 generate_image 调用", "恰好 1 个 image_generation 任务", "任务全部终态", "任务成功（非 dead_letter）", "结构不变量通过"],
    turns: [{
      prompt: "请现在就生成一张手冲咖啡店的开业宣传海报，暖色调，画面里要有“今日开业”四个中文字。现在就提交生成任务，不用再问我。",
    }],
    waitJobsMinutes: WAIT_JOBS_MINUTES,
    notVerified: ["出图质量与文字是否逐字正确（本套件只断言任务结构，不看图）"],
    decide: ctx => {
      const turn = ctx.turns[0];
      const jobs = ctx.state?.jobs ?? null;
      return [runCompleted(turn),
        decide(imageToolsOf(turn).some(tool => tool.status === "completed"), "image_tool_ran",
          "本轮必须有成功的 generate_image 调用",
          { imageToolCalls: imageToolsOf(turn).map(toolSummary) }),
        imageJobCount(jobs, 1, "exactly_one_image_job", "明确生成：必须恰好提交 1 个 image_generation 任务"),
        jobsTerminal(jobs, "jobs_terminal_after_wait", "wait-jobs 结束后所有任务都应处于终态"),
        imageJobSucceeded(jobs, "image_job_succeeded", "图片任务必须成功（dead_letter/failed 先按 sim 工具说明复核上游，再判断是否产品缺陷）"),
        structuralInvariants(ctx)];
    },
  },
  {
    id: "generate-then-withdraw",
    name: "生成后改口",
    paid: true,
    setup: "none",
    summary: "先生成，随后用户改口取消：早先的任务必须终态为 canceled，且不得出现第二个任务。",
    declared: ["两轮 run 都 completed", "总共恰好 1 个 image_generation 任务（没有第二个）", "早先任务终态为 canceled", "结构不变量通过"],
    turns: [
      { prompt: "请现在就生成一张宠物友好咖啡馆的宣传海报，暖色木质风格，画面里要有“欢迎毛孩子”五个中文字。现在就提交生成任务，不用再问我。" },
      { prompt: "等一下，我改主意了。这张图先不要了，请把刚才提交的那个生成任务取消掉，也不要重新生成、不要提交新任务。" },
    ],
    waitJobsMinutes: WAIT_JOBS_MINUTES,
    notVerified: ["若改口发生在任务已经成功之后，则没有可取消的对象：此时该期望记为 unverified 而不是通过"],
    decide: ctx => {
      const [first, second] = ctx.turns;
      const jobs = ctx.state?.jobs ?? null;
      const imageJobs = imageJobsOf(jobs);
      const job = imageJobs[0];
      let canceled;
      if (!jobs) canceled = undecided("earlier_job_canceled", "没有 state 可读取任务列表", {});
      else if (!job) canceled = fail("earlier_job_canceled", "改口前应当存在 1 个已提交任务", { imageJobCount: imageJobs.length });
      else if (job.status === "canceled") canceled = pass("earlier_job_canceled", "改口后早先任务终态为 canceled",
        { jobId: job.id, status: job.status, completedAt: job.completedAt ?? null });
      else if (job.completedAt && second.report?.at && Date.parse(job.completedAt) <= Date.parse(second.report.at))
        canceled = undecided("earlier_job_canceled", "改口请求发出前任务已结束，没有可取消的对象",
          { jobId: job.id, status: job.status, completedAt: job.completedAt, withdrawalTurnAt: second.report.at });
      else if (job.status === "failed" || job.status === "dead_letter")
        canceled = undecided("earlier_job_canceled", "任务在改口生效前已因上游失败结束",
          { jobId: job.id, status: job.status, errorCode: job.errorCode ?? null });
      else canceled = fail("earlier_job_canceled", "改口后早先任务仍未取消", { jobId: job.id, status: job.status });
      return [runCompleted(first), runCompleted(second),
        imageJobCount(jobs, 1, "exactly_one_image_job", "改口不得产生第二个任务：总数仍为 1"),
        canceled,
        structuralInvariants(ctx)];
    },
  },
  {
    id: "multi-image-series",
    name: "多图系列",
    paid: true,
    setup: "none",
    summary: "先规划后执行的两图系列：规划轮 0 任务，执行轮恰好 2 个 image_generation 任务且都成功。",
    declared: ["第 1 轮规划 jobs = 0", "第 2 轮恰好 2 个 image_generation 任务", "两个任务 id 不同", "任务全部终态且成功", "结构不变量通过"],
    turns: [
      { prompt: "我要为青原保温壶做一个夏日上新系列，两张图：一张新品主视觉、一张日常使用场景。请先给我两张图的文字规划，现在不要生成图片，也不要提交任务。" },
      { prompt: "就按刚才的规划执行：请生成这两张同系列的宣传图，必须正好两张，产品与品牌保持一致。现在就提交生成任务。" },
    ],
    waitJobsMinutes: WAIT_JOBS_MINUTES,
    notVerified: ["两张图的系列一致性（需要下载结果比对，本套件只看任务结构）"],
    decide: ctx => {
      const [first, second] = ctx.turns;
      const jobs = ctx.state?.jobs ?? null;
      return [runCompleted(first), runCompleted(second),
        noJobs(first, "系列规划轮：不得提交任务"),
        imageJobCount(jobs, 2, "exactly_two_image_jobs", "多图系列执行轮：必须恰好 2 个 image_generation 任务"),
        jobsTerminal(jobs, "jobs_terminal_after_wait", "wait-jobs 结束后所有任务都应处于终态"),
        imageJobSucceeded(jobs, "image_jobs_succeeded", "两个图片任务都必须成功"),
        structuralInvariants(ctx)];
    },
  },
  {
    id: "transparent-background",
    name: "透明背景",
    paid: true,
    setup: "none (背景去除技能被显式指定)",
    summary: "透明背景素材：路由必须落在背景去除技能上，恰好 1 个任务并成功。",
    declared: ["routing primarySkill = background-removal", "恰好 1 个 image_generation 任务", "任务终态且成功", "结构不变量通过"],
    turns: [{
      skill: "background-removal",
      prompt: "请制作一张独立的陶瓷香薰机产品素材，导出透明背景 PNG，产品完整、边缘干净，不要底色或地面。",
    }],
    waitJobsMinutes: WAIT_JOBS_MINUTES,
    notVerified: ["交付 PNG 是否真的带 alpha 透明通道（需要下载结果并解码像素，报告字段无法判定）"],
    decide: ctx => {
      const turn = ctx.turns[0];
      const jobs = ctx.state?.jobs ?? null;
      const routing = routingOf(turn);
      const primary = routing.find(item => item.primarySkill)?.primarySkill ?? null;
      const mentionsRemoval = routing.some(item => /背景去除|透明/.test(`${item.summary ?? ""}${item.detail ?? ""}`));
      if (!turn.report) {
        return [undecided("routing_background_removal", "本轮没有 turn 报告", {}), structuralInvariants(ctx), harnessStepsOk(ctx)];
      }
      return [runCompleted(turn),
        decide(primary === "background-removal" || mentionsRemoval, "routing_background_removal",
          "透明背景轮的路由必须落在背景去除技能上（primarySkill=background-removal 或路由摘要含“背景去除”）",
          { primarySkill: primary, routing: routing.map(item => `${item.intent}/${item.primarySkill ?? "-"}`) }),
        imageJobCount(jobs, 1, "exactly_one_image_job", "透明背景：恰好 1 个 image_generation 任务"),
        jobsTerminal(jobs, "jobs_terminal_after_wait", "wait-jobs 结束后所有任务都应处于终态"),
        imageJobSucceeded(jobs, "image_job_succeeded", "透明背景任务必须成功"),
        structuralInvariants(ctx)];
    },
  },
  {
    id: "cancel-while-running",
    name: "运行中取消",
    paid: true,
    setup: "none",
    summary: "任务运行中由 CLI 取消：任务必须终态 canceled，且取消的任务不得出现在画布上。",
    declared: ["恰好 1 个 image_generation 任务", "取消后任务终态为 canceled", "被取消的任务没有画布交付", "结构不变量通过"],
    turns: [{
      prompt: "请现在就生成一张书店周年庆的宣传海报，暖色书籍与灯光氛围，画面里要有“周年庆”三个中文字。现在就提交生成任务，不用再问我。",
    }],
    cancelAfterTurns: true,
    waitJobsMinutes: 2,
    notVerified: ["若取消时任务已经成功，则没有可取消的对象：此时该期望记为 unverified 而不是通过"],
    decide: ctx => {
      const turn = ctx.turns[0];
      const jobs = ctx.state?.jobs ?? null;
      const imageJobs = imageJobsOf(jobs);
      const job = imageJobs[0];
      const canvas = ctx.state?.canvas;
      let canceled;
      if (!job) canceled = undecided("canceled_job_terminal", "没有 state 或没有图片任务", { imageJobCount: imageJobs.length });
      else if (job.status === "canceled") canceled = pass("canceled_job_terminal", "运行中取消后任务终态为 canceled", { jobId: job.id, status: job.status });
      else if (job.status === "succeeded") canceled = undecided("canceled_job_terminal", "取消请求到达前任务已成功，没有可取消的对象",
        { jobId: job.id, status: job.status, completedAt: job.completedAt ?? null });
      else if (job.status === "failed" || job.status === "dead_letter") canceled = undecided("canceled_job_terminal", "任务在取消生效前已因上游失败结束",
        { jobId: job.id, status: job.status, errorCode: job.errorCode ?? null });
      else canceled = fail("canceled_job_terminal", "取消后任务仍未进入终态", { jobId: job.id, status: job.status });
      const deliveredAsset = job?.result?.asset_id ?? job?.result?.assetId ?? null;
      const onCanvas = deliveredAsset && canvas ? (canvas.images ?? []).some(image => image.assetId === deliveredAsset) : null;
      const delivery = !canvas ? undecided("canceled_job_not_delivered", "没有 state.canvas 可判定", {})
        : decide(!onCanvas, "canceled_job_not_delivered", "被取消的任务不得在画布上交付图片",
          { jobStatus: job?.status ?? null, deliveredAsset, canvasImages: (canvas.images ?? []).length });
      return [runCompleted(turn),
        imageJobCount(jobs, 1, "exactly_one_image_job", "运行中取消：应当只有 1 个 image_generation 任务"),
        canceled, delivery, structuralInvariants(ctx)];
    },
  },

  /* --------------------------------------------------------- browser-owned flow */

  {
    id: "delete-confirmation",
    name: "删除确认",
    paid: false,
    setup: "one canvas image (seeded by the probe itself)",
    runner: "browser",
    summary: "删除危险操作必须由真实浏览器点击完成，CLI 无法冒充浏览器标签页，因此本套件只声明并跳过。",
    declared: ["PHASE 1 卡片出现“需要确认危险操作/确认删除”，点击前画布图片仍在",
      "PHASE 2 真实点击后元素从画布删除、卡片收敛为“已确认并删除”",
      "PHASE 3 未确认的卡片不会被后台定时器自动执行，TTL 过后点击被拒绝",
      "PHASE 4 刷新后既不复活图片也不重复出现待确认卡片"],
    probe: rel(DELETE_CONFIRMATION_PROBE),
    probeCommand: "cd apps/web && node --env-file=../../.env.local ../../apps/web/scripts/check-delete-confirmation.mjs",
    probeEvidence: "artifacts/delete-confirmation-browser/",
    skipReason: "browser-owned probe: " + rel(DELETE_CONFIRMATION_PROBE) + "（由 apps/web 工作流维护，本套件不重复实现）",
    notVerified: ["本套件不执行该流程；结论以浏览器探针的 evidence JSON 为准"],
  },
];

/* ================================================================ run helpers */

let CHILD_ENV = { ...process.env };

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

async function spawnCollect(handle, args, usePipes) {
  return new Promise(settle => {
    let child;
    try {
      child = spawn(process.execPath, [SIM_TOOL, ...args], {
        cwd: REPO_ROOT, env: CHILD_ENV,
        stdio: usePipes ? ["ignore", "pipe", "pipe"] : ["ignore", handle.fd, handle.fd],
      });
    } catch (error) {
      return settle({ spawnError: String(error?.message ?? error) });
    }
    const chunks = [];
    if (usePipes) {
      child.stdout.on("data", chunk => chunks.push(chunk));
      child.stderr.on("data", chunk => chunks.push(chunk));
    }
    let settled = false;
    const done = value => { if (!settled) { settled = true; settle({ ...value, chunks }); } };
    child.on("error", error => done({ spawnError: String(error?.message ?? error) }));
    child.on("close", (code, signal) => done({ code, signal }));
  });
}

/** One sim operation, its raw output captured into a log file (never a shell pipe). */
async function sim(flowId, stepName, args, options = {}) {
  const logPath = join(RUN_ROOT, "flows", flowId, "logs", `${stepName}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const startedAt = Date.now();
  const safeArgs = args.map(argument => String(argument).includes(REPO_ROOT) ? rel(argument) : String(argument));
  const entry = { step: stepName, args: safeArgs, startedAt: new Date(startedAt).toISOString(),
    expectFailure: options.expectFailure === true };
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await open(logPath, attempt === 0 ? "w" : "a");
    try {
      await handle.write(`# ${new Date().toISOString()} $ node ${rel(SIM_TOOL)} ${safeArgs.join(" ")}\n`);
      const outcome = await spawnCollect(handle, args, attempt === 1);
      if (outcome.chunks?.length) await handle.write(Buffer.concat(outcome.chunks));
      entry.exitCode = outcome.code ?? null;
      entry.signal = outcome.signal ?? null;
      entry.spawnError = outcome.spawnError ?? null;
      if (!outcome.spawnError) break;
      await handle.write(`# stdio retry after spawn error: ${outcome.spawnError}\n`);
    } finally {
      await handle.close();
    }
  }
  entry.ms = Date.now() - startedAt;
  entry.log = rel(logPath);
  return entry;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- fixtures */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}
/**
 * Two visually distinct, self-contained reference images so the suite never
 * depends on another workstream's artifacts: "a" is a red field with a white
 * disc, "b" is a blue field with a white band.
 */
function referencePng(kind, size = 512) {
  const width = size;
  const height = size;
  const palette = kind === "a" ? [200, 40, 40] : [30, 70, 190];
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      let [r, g, b] = palette;
      if (kind === "a") {
        const dx = x - width / 2;
        const dy = y - height / 2;
        if (dx * dx + dy * dy <= (width * 0.28) ** 2) [r, g, b] = [255, 255, 255];
      } else if (y > height * 0.3 && y < height * 0.7 && x > width * 0.15 && x < width * 0.85) {
        [r, g, b] = [255, 255, 255];
      }
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function resolveReplies(turns, state) {
  return turns.map((turn, index) => {
    const start = Date.parse(turn.report?.at ?? turn.startedAt);
    const own = (turn.report?.assistantMessages ?? []).map(message => (message.content ?? "").trim()).filter(Boolean).join("\n\n");
    if (own) return { reply: own, replySource: "turn-report", replyAuthority: "full" };
    const end = index + 1 < turns.length ? Date.parse(turns[index + 1].report?.at ?? turns[index + 1].startedAt) : Infinity;
    const matched = (state?.messages ?? [])
      .filter(message => message.role === "assistant" && (message.content ?? "").trim())
      .filter(message => {
        const at = message.createdAt ? Date.parse(message.createdAt) : start;
        return at >= start && at < end;
      });
    if (matched.length)
      return { reply: matched.map(message => message.content.trim()).join("\n\n"), replySource: "state-read", replyAuthority: "full" };
    const streamed = (turn.report?.text ?? "").trim();
    if (streamed) return { reply: streamed, replySource: "stream-delta", replyAuthority: "partial" };
    return { reply: "", replySource: "none", replyAuthority: "none" };
  });
}

/* ------------------------------------------------------------------ the runner */

async function runFlow(flow) {
  const startedAt = new Date().toISOString();
  const dir = join(RUN_ROOT, "flows", flow.id);
  await mkdir(dir, { recursive: true });
  const ctx = { flow, dir, steps: [], turns: [], uploads: [], checks: [], states: [], state: null, check: null,
    fixture: null, fixturePath: join(dir, "fixture.json"), notes: [] };
  const result = { id: flow.id, name: flow.name, paid: flow.paid, setup: flow.setup, summary: flow.summary,
    runner: flow.runner ?? "cli", startedAt, dir: rel(dir), declared: flow.declared, notVerified: flow.notVerified ?? [],
    expectations: [], observed: {}, notes: [], evidence: {}, error: null };

  try {
    // 1. isolated fixture (project + canvas + session)
    ctx.steps.push(await sim(flow.id, "create", ["create", "--name", `regression-${flow.id}`, "--out", ctx.fixturePath]));
    ctx.fixture = await readJson(ctx.fixturePath);
    // A broken setup is a harness failure, not a product finding: stop before
    // spending turns on a fixture that does not exist.
    if (!ctx.fixture) throw new Error(`fixture 未生成（见 ${ctx.steps.at(-1).log}）`);

    // 2. setup: uploads / canvas image
    if (flow.setup === "one uploaded reference" || flow.setup === "two uploads") {
      const count = flow.setup === "two uploads" ? 2 : 1;
      for (let index = 1; index <= count; index++) {
        const kind = index === 1 ? "a" : "b";
        const sourcePath = join(dir, `reference-${kind}.png`);
        await writeFile(sourcePath, referencePng(kind));
        const outPath = join(dir, `attachment-${index}.json`);
        const step = await sim(flow.id, `upload-${index}`,
          ["upload", "--file", sourcePath, "--project", ctx.fixture.projectId, "--out", outPath]);
        ctx.steps.push(step);
        const attachment = await readJson(outPath);
        if (step.exitCode !== 0 || !attachment)
          throw new Error(`参考图上传失败（exit=${step.exitCode}，见 ${step.log}）`);
        ctx.uploads.push({ ...attachment, path: sourcePath, jsonPath: outPath });
      }
    }
    if (flow.setup === "one canvas image") {
      const sourcePath = join(dir, "canvas-source.png");
      await writeFile(sourcePath, referencePng("a"));
      const seedStep = await sim(flow.id, "seed-canvas",
        ["seed-canvas", "--fixture", ctx.fixturePath, "--source", sourcePath, "--width", "700", "--height", "1000"]);
      ctx.steps.push(seedStep);
      if (seedStep.exitCode !== 0) throw new Error(`画布种子图片失败（exit=${seedStep.exitCode}，见 ${seedStep.log}）`);
    }

    // 3. turns
    for (let index = 0; index < flow.turns.length; index++) {
      const turn = flow.turns[index];
      const promptPath = join(dir, `prompt-${index + 1}.txt`);
      await writeFile(promptPath, `${turn.prompt.trim()}\n`, "utf8");
      const reportPath = join(dir, `turn-${index + 1}.json`);
      const args = ["turn", "--fixture", ctx.fixturePath, "--text-file", promptPath,
        "--out", reportPath, "--timeout-minutes", String(flow.turnTimeoutMinutes ?? TURN_TIMEOUT_MINUTES)];
      if (turn.skill) args.push("--skill", turn.skill);
      for (const uploadIndex of turn.attach ?? []) args.push("--attach", ctx.uploads[uploadIndex - 1].jsonPath);
      const step = await sim(flow.id, `turn-${index + 1}`, args);
      ctx.steps.push(step);
      const report = await readJson(reportPath);
      ctx.turns.push({
        index: index + 1, prompt: turn.prompt, promptPath: rel(promptPath), startedAt: startedAt,
        report, runStatus: report?.runStatus ?? null, runError: report?.runError ?? null,
        tools: report?.tools ?? [], routing: report?.routing ?? [], reportPath: rel(reportPath),
        uploads: (turn.attach ?? []).map(uploadIndex => ctx.uploads[uploadIndex - 1]?.name ?? null),
      });
    }

    // 4. cancel (运行中取消)
    if (flow.cancelAfterTurns) ctx.steps.push(await sim(flow.id, "cancel", ["cancel", "--fixture", ctx.fixturePath]));

    // 5. wait for provider jobs (paid flows only)
    if (flow.waitJobsMinutes) {
      ctx.steps.push(await sim(flow.id, "wait-jobs",
        ["wait-jobs", "--fixture", ctx.fixturePath, "--timeout-minutes", String(flow.waitJobsMinutes)]));
    }

    // 6. transcript + jobs + canvas
    const statePath = join(dir, "state.json");
    ctx.steps.push(await sim(flow.id, "state", ["state", "--fixture", ctx.fixturePath, "--out", statePath]));
    ctx.state = await readJson(statePath);

    // 7. structural invariants
    const checkPath = join(dir, "check.json");
    const checkArgs = ["check", "--fixture", ctx.fixturePath, "--out", checkPath];
    for (const code of flow.checkAllow ?? []) checkArgs.push("--allow", code);
    ctx.steps.push(await sim(flow.id, "check", checkArgs, { expectFailure: true }));
    ctx.check = await readJson(checkPath);

    // 8. replies (turn report first, then the persisted transcript)
    const replies = resolveReplies(ctx.turns, ctx.state);
    ctx.turns.forEach((turn, index) => Object.assign(turn, replies[index]));

    // 9. verdicts
    result.expectations = [...(flow.decide(ctx) ?? []), harnessStepsOk(ctx)];
  } catch (error) {
    result.error = String(error?.message ?? error);
    result.notes.push(`harness error: ${result.error}`);
    if (!result.expectations.length) {
      result.expectations = [{ code: "harness_steps_ok", description: "harness 必须产出证据", ok: false,
        observed: { error: result.error, steps: ctx.steps.map(step => step.step) } }];
    }
  }

  const failed = result.expectations.filter(expectation => expectation.ok === false);
  const unknown = result.expectations.filter(expectation => expectation.ok === null);
  result.status = result.error || failed.length ? "fail" : unknown.length ? "unverified" : "pass";
  if (result.error) result.status = "error";
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  result.observed = {
    fixture: ctx.fixture ? { projectId: ctx.fixture.projectId, canvasId: ctx.fixture.canvasId, sessionId: ctx.fixture.sessionId,
      textModel: ctx.fixture.textModel, imageModel: ctx.fixture.imageModel } : null,
    uploads: ctx.uploads.map(upload => ({ name: upload.name, assetId: upload.assetId })),
    turns: ctx.turns.map(turn => ({ index: turn.index, runStatus: turn.runStatus, runError: turn.runError,
      tools: turn.tools.map(toolSummary), routing: turn.routing.map(item => `${item.intent}/${item.reasonCode ?? "-"}/${item.source ?? "-"}`),
      jobCount: (turn.report?.jobs ?? []).length, jobs: (turn.report?.jobs ?? []).map(jobSummary),
      attachments: (turn.report?.attachments ?? []).length, replySource: turn.replySource, replyChars: turn.reply?.length ?? 0,
      replyExcerpt: (turn.reply ?? "").trim().slice(0, 400), reportPath: turn.reportPath, promptPath: turn.promptPath })),
    sessionJobs: (ctx.state?.jobs ?? []).map(job => ({ id: job.id, jobType: job.jobType, status: job.status,
      errorCode: job.errorCode ?? null, createdAt: job.createdAt ?? null, completedAt: job.completedAt ?? null })),
    canvas: ctx.state?.canvas ? { elementCount: ctx.state.canvas.elementCount, images: (ctx.state.canvas.images ?? []).length,
      placeholders: ctx.state.canvas.placeholders ?? [] } : null,
    check: ctx.check ? { ok: ctx.check.ok, violations: ctx.check.violations, counts: ctx.check.counts } : null,
    steps: ctx.steps,
  };
  result.evidence = { dir: rel(dir), fixture: rel(ctx.fixturePath), turns: ctx.turns.map(turn => turn.reportPath),
    state: rel(join(dir, "state.json")), check: rel(join(dir, "check.json")), logs: rel(join(dir, "logs")) };

  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function skippedResult(flow, reason) {
  return { id: flow.id, name: flow.name, paid: flow.paid, setup: flow.setup, summary: flow.summary,
    runner: flow.runner ?? "cli", status: "skip", skipReason: reason, declared: flow.declared,
    expectations: [], notVerified: flow.notVerified ?? [], observed: {},
    ...(flow.probe ? { probe: flow.probe, probeCommand: flow.probeCommand, probeEvidence: flow.probeEvidence } : {}),
    startedAt: null, finishedAt: null, durationMs: 0 };
}

/* --------------------------------------------------------------- presentation */

const STATUS_LABEL = { pass: "PASS", fail: "FAIL", skip: "SKIP", unverified: "UNVERIFIED", error: "ERROR" };

function expectationSummary(result) {
  if (result.status === "skip") return result.declared?.length ? `${result.declared.length} 条声明（未执行）` : "未执行";
  const total = result.expectations.length;
  const ok = result.expectations.filter(item => item.ok === true).length;
  const unknown = result.expectations.filter(item => item.ok === null).length;
  return `${ok}/${total} 通过${unknown ? `，${unknown} 无法判定` : ""}`;
}

function printTable(results, stream = console.log) {
  const rows = results.map(result => [result.id, result.name, result.paid ? "paid" : "free",
    STATUS_LABEL[result.status] ?? result.status, expectationSummary(result),
    result.status === "skip" ? (result.skipReason ?? "") : (result.observed?.turns ?? []).map(turn =>
      `jobs=${turn.jobCount} tools=${turn.tools.length} reply=${turn.replyChars}`).join(" | ")]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => displayWidth(row[column] ?? ""))));
  const line = row => row.map((cell, column) => pad(cell ?? "", widths[column])).join("  ");
  stream("");
  stream(line(["FLOW", "中文流程", "成本", "结果", "期望", "观测"]));
  stream(line(widths.map(width => "-".repeat(width))));
  for (const row of rows) stream(line(row));
  stream("");
}
/** CJK-aware column width so the table stays aligned in a terminal. */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  return width;
}
function pad(text, width) {
  return String(text) + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function flowRow(flow) {
  return [flow.id, flow.name, flow.paid ? "paid" : "free", flow.setup, flow.summary,
    (flow.declared ?? []).map(item => `- ${item}`).join("\n")].join(" | ");
}

function writeMarkdown(results, meta) {
  const lines = [];
  lines.push(`# Loomic Agent 关键流程回归报告 (${meta.day})`);
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- API：\`${meta.api}\`　env：\`${meta.envFile}\``);
  lines.push(`- 模式：${meta.paid ? "**--paid（含付费出图流程）**" : "默认（仅零成本流程）"}${meta.only.length ? `　--only=${meta.only.join(",")}` : ""}`);
  lines.push(`- 退出码：\`${meta.exitCode}\`　PASS ${meta.counts.pass} / FAIL ${meta.counts.fail} / SKIP ${meta.counts.skip} / UNVERIFIED ${meta.counts.unverified}${meta.counts.error ? ` / ERROR ${meta.counts.error}` : ""}`);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push("| FLOW | 中文流程 | 成本 | 结果 | 期望 | 观测 |");
  lines.push("|---|---|---|---|---|---|");
  for (const result of results) {
    const observed = result.status === "skip" ? (result.skipReason ?? "")
      : (result.observed?.turns ?? []).map(turn => `jobs=${turn.jobCount} tools=${turn.tools.length} reply=${turn.replyChars}`).join("<br>");
    lines.push(`| \`${result.id}\` | ${result.name} | ${result.paid ? "paid" : "free"} | **${STATUS_LABEL[result.status]}** | ${expectationSummary(result)} | ${observed} |`);
  }
  lines.push("");
  lines.push("## 散文代理断言审计（不随运行变化）");
  lines.push("");
  lines.push("本套件中所有“读自然语言而不是读结构化字段”的期望，及其处置（fixed＝本轮已按语义范围重写并自测；flagged＝保留原样并记录已知弱点）：");
  lines.push("");
  lines.push("| 期望 | 流程 | 处置 | 说明 |");
  lines.push("|---|---|---|---|");
  for (const entry of PROSE_PROXY_AUDIT) {
    lines.push(`| \`${entry.code}\` | \`${entry.where}\` | ${entry.disposition === "fixed" ? "**fixed**" : "flagged"} | ${inline(entry.note)} |`);
  }
  lines.push("");
  lines.push("自测：`node --test apps/server/scripts/agent-regression-flows.assertions.test.mjs`");
  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.name}（\`${result.id}\`）— ${STATUS_LABEL[result.status]}`);
    lines.push("");
    lines.push(result.summary ?? "");
    lines.push("");
    if (result.status === "skip") {
      lines.push(`跳过原因：${result.skipReason}`);
      if (result.probe) {
        lines.push("");
        lines.push(`浏览器探针：\`${result.probe}\``);
        lines.push("");
        lines.push("```");
        lines.push(result.probeCommand ?? "");
        lines.push("```");
        lines.push(`探针证据目录：\`${result.probeEvidence}\``);
      }
      lines.push("");
      lines.push("声明的期望（本套件不执行）：");
      lines.push("");
      for (const item of result.declared ?? []) lines.push(`- ${item}`);
      lines.push("");
      continue;
    }
    lines.push(`setup：${result.setup}　证据目录：\`${result.evidence?.dir ?? "-"}\``);
    lines.push("");
    if (result.observed?.turns?.length) {
      lines.push("| 轮次 | runStatus | 路由 | 工具 | jobs | 回复来源/字符 |");
      lines.push("|---|---|---|---|---|---|");
      for (const turn of result.observed.turns) {
        lines.push(`| ${turn.index} | ${turn.runStatus ?? "-"} | ${turn.routing.join("<br>") || "-"} | ${turn.tools.join("<br>") || "-"} | ${turn.jobCount} (${turn.jobs.join(", ") || "-"}) | ${turn.replySource}/${turn.replyChars} |`);
      }
      lines.push("");
    }
    lines.push("| 期望 | 判定 | 观测 |");
    lines.push("|---|---|---|");
    for (const expectation of result.expectations) {
      const verdict = expectation.ok === true ? "PASS" : expectation.ok === false ? "**FAIL**" : "UNVERIFIED";
      lines.push(`| \`${expectation.code}\` ${expectation.description} | ${verdict} | \`${inline(JSON.stringify(expectation.observed))}\` |`);
    }
    lines.push("");
    if (result.notVerified?.length) {
      lines.push("本流程刻意不判定：");
      lines.push("");
      for (const item of result.notVerified) lines.push(`- ${item}`);
      lines.push("");
    }
    if (result.status !== "pass") {
      lines.push("原始证据：");
      lines.push("");
      for (const turn of result.observed?.turns ?? []) {
        lines.push(`- 提示词 \`${turn.promptPath}\`（本轮 0 成本运行的真实输入）`);
      }
      lines.push(`- 报告：${(result.evidence?.turns ?? []).map(path => `\`${path}\``).join("、")}`);
      lines.push(`- 状态/任务：\`${result.evidence?.state}\`　结构检查：\`${result.evidence?.check}\`　日志：\`${result.evidence?.logs}\``);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
const inline = text => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 600);

/* ======================================================================= main */

function selectFlows() {
  if (!ONLY.length) return FLOWS;
  return FLOWS.filter(flow => ONLY.some(selector => selector === flow.id || selector === flow.name));
}

async function assertReachable() {
  const url = `${API}/api/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    if (payload?.ok !== true) throw new Error(`unexpected health payload: ${text.slice(0, 200)}`);
    return payload;
  } catch (error) {
    console.error(`\nAPI 不可达：${url}\n  ${String(error?.message ?? error)}`);
    console.error("本地栈必须先启动（API 3002 + Supabase），或使用 --api <url> 指向其它实例。");
    console.error("启动方式见 artifacts/local-replica-20260907/（本套件不会自行启动服务）。\n");
    process.exit(2);
  }
}

async function main() {
  if (HELP) {
    console.log("用法：node apps/server/scripts/agent-regression-flows.mjs [--paid] [--only <id,...>] [--list] [--strict] [--api <url>] [--env-file <path>]");
    return 0;
  }
  const flows = selectFlows();
  if (!flows.length) {
    console.error(`--only 没有匹配任何流程。已知流程：${FLOWS.map(flow => flow.id).join(", ")}`);
    return 2;
  }
  if (LIST) {
    console.log("");
    for (const flow of flows) {
      console.log(`${flow.id}  [${flow.paid ? "paid" : "free"}]  ${flow.name}  setup=${flow.setup}${flow.runner === "browser" ? "  runner=browser" : ""}`);
      console.log(`    ${flow.summary}`);
      for (const item of flow.declared ?? []) console.log(`    - ${item}`);
      if (flow.notVerified?.length) console.log(`    未判定：${flow.notVerified.join("；")}`);
    }
    console.log("");
    return 0;
  }

  await access(SIM_TOOL).catch(() => {
    console.error(`找不到 sim 工具：${SIM_TOOL}`);
    process.exit(2);
  });
  if (!(await access(ENV_FILE).then(() => true).catch(() => false))) {
    console.error(`找不到 env 文件：${ENV_FILE}\n用 --env-file <path> 指定包含 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY 的文件。`);
    return 2;
  }
  const fileEnv = parseEnvFile(await readFile(ENV_FILE, "utf8"));
  CHILD_ENV = { ...process.env, ...fileEnv, LOOMIC_LIVE_API: API };
  for (const required of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]) {
    if (!CHILD_ENV[required]) {
      console.error(`env 文件缺少 ${required}：${ENV_FILE}`);
      return 2;
    }
  }

  const health = await assertReachable();
  await mkdir(RUN_ROOT, { recursive: true });

  console.log("");
  console.log(`Loomic Agent 关键流程回归：${PAID ? "--paid（含付费出图流程）" : "默认（仅零成本流程）"}`);
  console.log(`API ${API}  health=${JSON.stringify(health)}`);
  console.log(`env ${ENV_FILE}`);
  console.log(`证据 ${rel(RUN_ROOT)}`);
  console.log(`流程 ${flows.length} 个：${flows.map(flow => `${flow.name}[${flow.paid ? "paid" : "free"}]`).join("、")}`);

  const results = [];
  for (const flow of flows) {
    if (flow.runner === "browser") {
      console.log(`\n--- SKIP ${flow.name}（${flow.id}）：${flow.skipReason}`);
      results.push(skippedResult(flow, flow.skipReason));
      continue;
    }
    if (flow.paid && !PAID) {
      const reason = `付费流程：默认运行不执行，加 --paid 才会提交真实出图任务（${flow.name}）`;
      console.log(`\n--- SKIP ${flow.name}（${flow.id}）：${reason}`);
      results.push(skippedResult(flow, reason));
      continue;
    }
    console.log(`\n--- RUN ${flow.name}（${flow.id}）${flow.paid ? " [paid]" : ""}`);
    const result = await runFlow(flow);
    results.push(result);
    for (const expectation of result.expectations) {
      const verdict = expectation.ok === true ? "PASS" : expectation.ok === false ? "FAIL" : "UNVERIFIED";
      console.log(`    ${verdict.padEnd(10)} ${expectation.code}  ${JSON.stringify(expectation.observed)}`);
    }
    console.log(`    => ${STATUS_LABEL[result.status]} ${result.name}（${result.durationMs} ms）`);
  }

  const counts = results.reduce((acc, result) => {
    const key = result.status === "error" ? "error" : result.status;
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, { pass: 0, fail: 0, skip: 0, unverified: 0, error: 0 });
  const exitCode = counts.fail + counts.error > 0 || (STRICT && counts.unverified > 0) ? 1 : 0;
  const meta = { day: DAY, generatedAt: new Date().toISOString(), api: API, envFile: rel(ENV_FILE), paid: PAID,
    only: ONLY, strict: STRICT, counts, exitCode,
    flows: results.map(result => ({ id: result.id, name: result.name, status: result.status, paid: result.paid })) };
  const report = { kind: "agent-regression-report", ...meta, results };
  await writeFile(join(RUN_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(RUN_ROOT, "report.md"), writeMarkdown(results, meta), "utf8");
  await writeFile(join(RUN_ROOT, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printTable(results);
  console.log(`PASS ${counts.pass} / FAIL ${counts.fail} / SKIP ${counts.skip} / UNVERIFIED ${counts.unverified}${counts.error ? ` / ERROR ${counts.error}` : ""}`);
  console.log(`汇总报告 ${rel(join(RUN_ROOT, "report.json"))}　可读表 ${rel(join(RUN_ROOT, "report.md"))}`);
  if (counts.fail || counts.error) {
    console.log("");
    console.log("失败流程：");
    for (const result of results.filter(item => item.status === "fail" || item.status === "error")) {
      const broken = result.expectations.filter(expectation => expectation.ok === false);
      console.log(`  ${result.name}（${result.id}）：${broken.map(item => item.code).join(", ") || result.error}`);
      for (const expectation of broken) console.log(`    - ${expectation.code}: ${JSON.stringify(expectation.observed)}`);
      if (result.evidence?.dir) console.log(`    证据：${result.evidence.dir}`);
    }
  }
  if (STRICT && counts.unverified) console.log(`\n--strict：${counts.unverified} 个流程含无法判定的期望，按失败处理。`);
  return exitCode;
}

/* ---------------------------------------------------------------- test surface */

/**
 * Exported only so the sibling node:test suite can drive the prose assertions
 * directly:
 *   node --test apps/server/scripts/agent-regression-flows.assertions.test.mjs
 * Nothing else should import this module (it is a CLI; see IS_ENTRY below).
 */
export {
  OLD_TOPIC_TOKENS, PROSE_PROXY_AUDIT, generationClaimClause, newTopicExcludesOldConstraints,
  noGenerationClaim, oldConstraintUse,
};

/**
 * Run the suite only when this file IS the entry point. The prose assertions are
 * pinned by a sibling node:test file, and importing this module from a test must
 * not reach for the API, the env file or the artifacts directory.
 */
const SELF_PATH = fileURLToPath(import.meta.url);
const samePath = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;
const IS_ENTRY = process.argv[1] !== undefined && samePath(resolve(process.argv[1]), SELF_PATH);
if (IS_ENTRY) process.exitCode = await main();
