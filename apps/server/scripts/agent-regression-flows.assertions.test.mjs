#!/usr/bin/env node
/**
 * Self-tests for the prose assertions of agent-regression-flows.mjs.
 *
 * Run:
 *   node --test apps/server/scripts/agent-regression-flows.assertions.test.mjs
 *
 * apps/server/vitest.config.ts excludes scripts/** on purpose ("scripts contains
 * native node:test suites; run them with test:supervisor"), so this is a native
 * node:test file beside the suite it tests, exactly like worker-supervisor.test.mjs.
 *
 * WHY THIS FILE EXISTS. On 2026-09-20 the expectation
 * `new_topic_excludes_old_constraints` reported FAIL on four consecutive full
 * suite runs (report-2026-09-20T08-36-18, 08-59-00, 09-34-55, 12-09-35) because it
 * was a raw substring scan: the old-topic words appeared inside the sentence that
 * VOIDED them. The product was right and the checker was wrong. A checker nobody
 * checks is a liability — it hides real regressions in noise — so every branch of
 * the rewritten rule is pinned here, including the branch that must still FAIL.
 *
 * The synthetic replies below are the contract:
 *   voided quote        -> PASS   (never inheritance)
 *   applied old setting -> FAIL    (genuine silent inheritance is still caught)
 *   neutral mention     -> UNVERIFIED (ok === null), because prose alone cannot
 *                          tell a passing comparison from a silent carry-over;
 *                          the suite's vocabulary has no room for a guessed PASS
 *                          and the incident showed a guessed FAIL is worse.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  OLD_TOPIC_TOKENS,
  PROSE_PROXY_AUDIT,
  generationClaimClause,
  newTopicExcludesOldConstraints,
  noGenerationClaim,
  oldConstraintUse,
} from "./agent-regression-flows.mjs";

const turn = (reply, replyAuthority = "full", replySource = "turn-report") =>
  ({ reply, replyAuthority, replySource });
const verdict = reply => newTopicExcludesOldConstraints(turn(reply));

/* ------------------------------------------------------------------ contract */

test("forbidden token list is not weakened by the rewrite", () => {
  assert.deepEqual(OLD_TOPIC_TOKENS, ["青原", "保温壶", "夏日上新", "哑光绿"]);
});

test("every prose proxy in the suite is classified in PROSE_PROXY_AUDIT", () => {
  const dispositions = new Set(PROSE_PROXY_AUDIT.map(entry => entry.disposition));
  assert.deepEqual([...dispositions].sort(), ["fixed", "flagged"]);
  for (const entry of PROSE_PROXY_AUDIT) {
    assert.ok(entry.code && entry.where && entry.note, `incomplete audit entry: ${JSON.stringify(entry)}`);
  }
  assert.deepEqual(
    PROSE_PROXY_AUDIT.filter(entry => entry.disposition === "fixed").map(entry => entry.code).sort(),
    ["new_topic_excludes_old_constraints", "no_generation_claim"],
  );
});

/* ------------------------------------------- old topic: voided quotes pass */

test("old-topic: the historical voiding replies pass (regression for the 2026-09-20 false FAIL)", () => {
  const historical = [
    "新任务已切换到宠物友好书店，之前的青原保温壶品牌、产品、文案和 3:2 尺寸全部作废，不沿用。\n\n**书店活动方向**：夜间暖光、猫咪陪你读到打烊。",
    "**前一轮设定已作废**：青原保温壶、哑光绿、夏日上新、3:2 全部不带入本任务。\n\n新主题是宠物友好书店的「猫咪陪你读到打烊」夜间活动。",
    "新任务已建立，之前的青原保温壶设定（品牌、产品、哑光绿、文案、3:2）全部作废，不再沿用，本轮不生成图片、不提交任务，只做方向确认。",
    "这是一个全新任务，之前青原保温壶的品牌、产品、文案和 3:2 尺寸全部作废，不沿用。下面只确认方向，不生成、不提交。",
  ];
  for (const reply of historical) {
    const result = verdict(reply);
    assert.equal(result.ok, true, `voiding reply must PASS, got ${JSON.stringify(result.observed)}`);
    assert.deepEqual(result.observed.appliedTokens, []);
    assert.ok(result.observed.voidedTokens.length > 0, "the voiding must be recorded as evidence");
  }
});

test("old-topic: a discarded enumeration that names its own settings still passes", () => {
  const result = verdict("之前的系列设定（品牌青原保温壶、主色哑光绿、文案「夏日上新」）全部作废，本次只做书店活动方向确认。");
  assert.equal(result.ok, true, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, []);
  assert.ok(result.observed.voidedTokens.includes("哑光绿"));
  assert.ok(result.observed.voidedTokens.includes("夏日上新"));
});

test("old-topic: a reply that names no old token passes", () => {
  const result = verdict("宠物友好书店周五晚间活动方向：夜间暖光、猫咪陪你读到打烊，主色建议深绿与暖黄。");
  assert.equal(result.ok, true);
  assert.deepEqual(result.observed.appliedTokens, []);
  assert.deepEqual(result.observed.undecidedTokens, []);
});

/* ------------------------------------------ old topic: applied tokens fail */

test("old-topic: applying the old brand / colour / copy to the new topic fails", () => {
  const inherited = [
    "好的，新任务书店视觉沿用之前的品牌青原保温壶，主色哑光绿，文案仍是「夏日上新」。",
    "新任务：宠物友好书店周五晚间活动海报，品牌 青原保温壶，主色 哑光绿，尺寸 3:2，文案「夏日上新」。",
    "沿用之前的青原保温壶品牌和哑光绿主色。",
  ];
  for (const reply of inherited) {
    const result = verdict(reply);
    assert.equal(result.ok, false, `inheritance must FAIL: ${reply}`);
    assert.ok(result.observed.appliedTokens.length > 0);
    assert.deepEqual(result.observed.appliedTokens, [...new Set(result.observed.appliedTokens)]);
  }
});

test("old-topic: the token-based check does not pretend to catch an unnamed reuse", () => {
  // Documented limit, not a defect: "沿用之前的品牌" reuses the old setting without
  // naming any forbidden token, and a token-based expectation cannot see it. It is
  // declared in the flow's notVerified list instead of being guessed at.
  const result = verdict("新任务只做方向：沿用之前的品牌和系列设定。");
  assert.equal(result.ok, true);
  assert.deepEqual(result.observed.appliedTokens, []);
  assert.deepEqual(result.observed.forbidden, OLD_TOPIC_TOKENS);
});

test("old-topic: a list-shaped carry-over with the verb in the last clause is UNVERIFIED, not a guessed FAIL", () => {
  // Second documented limit: the token sits in the first 、-clause while the
  // application verb sits in the last one. Widening application evidence to
  // sentence scope would also judge "青原保温壶项目已收尾，书店沿用夜间暖光" as
  // inheritance — a false FAIL, the exact defect this pass fixes. So this shape is
  // reported unverified for a human, and the flow declares it in notVerified.
  const result = verdict("新任务方向如下：之前青原保温壶的品牌、产品、文案全部沿用。");
  assert.equal(result.ok, null, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, []);
  assert.ok(result.observed.undecidedTokens.length > 0);
});

test("old-topic: one disavowal cannot cover a token that is applied in another clause", () => {
  const result = verdict("之前的品牌作废，新方案主色哑光绿。");
  assert.equal(result.ok, false, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, ["哑光绿"]);
  assert.deepEqual(result.observed.voidedTokens, []);
});

test("old-topic: a negated-use marker does not excuse a re-applied token later in the same sentence", () => {
  const result = verdict("不再沿用旧的文案，主色哑光绿。");
  assert.equal(result.ok, false, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, ["哑光绿"]);
});

test("old-topic: a void in one sentence cannot launder the next sentence", () => {
  const result = verdict("之前的品牌、产品、文案和尺寸全部作废。新方案仍然沿用青原保温壶的品牌，主色是哑光绿。");
  assert.equal(result.ok, false, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, ["青原", "保温壶", "哑光绿"]);
});

/* ---------------------------------------------- old topic: neutral mention */

test("old-topic: a neutral mention is UNVERIFIED — never a pass, never a fail", () => {
  const result = verdict("书店活动定在周五晚，之前的青原保温壶项目已经收尾。");
  assert.equal(result.ok, null, JSON.stringify(result.observed));
  assert.deepEqual(result.observed.appliedTokens, []);
  assert.deepEqual(result.observed.voidedTokens, []);
  assert.ok(result.observed.undecidedTokens.includes("青原"));
  assert.ok(String(result.observed.reason).includes("无法判定"));
});

test("old-topic: an unreadable reply is UNVERIFIED, not a pass", () => {
  const result = newTopicExcludesOldConstraints(turn("青原", "partial", "stream-delta"));
  assert.equal(result.ok, null);
  assert.equal(result.observed.replySource, "stream-delta");
});

test("old-topic: evidence names the void predicate and the application evidence", () => {
  const voided = oldConstraintUse("之前的青原保温壶全部作废。");
  assert.match(voided.disavowed[0].voidedBy, /^void-/);
  const applied = oldConstraintUse("主色是哑光绿。");
  assert.match(applied.reused[0].evidence, /^setting-assigns:/);
  const negated = oldConstraintUse("不再沿用青原保温壶。");
  assert.deepEqual(negated.reused, []);
  assert.equal(negated.disavowed.length, 2);
});

/* ----------------------------------------------- generation-claim assertion */

test("generation claim: a denial clause that quotes 已生成 is not a claim", () => {
  const replies = [
    "本轮不生成，也不存在已生成的图片。",
    "还没有已生成的成品，本轮只给方向。",
  ];
  for (const reply of replies) {
    const result = noGenerationClaim(turn(reply));
    assert.equal(result.ok, true, `denial must PASS: ${reply}`);
    assert.equal(result.observed.claimClause, null);
    assert.equal(generationClaimClause(reply), null);
  }
});

test("generation claim: a real claim fails even when a neighbouring clause is negated", () => {
  const replies = [
    "已生成两张图，请查看画布。",
    "这不是讨论稿，已经生成好了两张图。",
  ];
  for (const reply of replies) {
    const result = noGenerationClaim(turn(reply));
    assert.equal(result.ok, false, `claim must FAIL: ${reply}`);
    assert.ok(result.observed.claimClause.length > 0);
  }
});

test("generation claim: no visible reply is UNVERIFIED, not a pass", () => {
  const result = noGenerationClaim({ reply: "", replyAuthority: "none", replySource: "none" });
  assert.equal(result.ok, null);
});
