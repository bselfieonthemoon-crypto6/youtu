/**
 * Behavioral evaluation: does the running agent actually honor the loaded
 * Skill and the server routing, not just the unit-level policy layer?
 *
 * The evaluators here are pure so they run deterministically in CI against
 * synthetic evidence. The live runner (scripts/eval-agent-behavior.ts) produces
 * the same evidence from real turns and applies these checks.
 */
export type BehaviorJob = {
  id: string;
  jobType: string;
  status: string;
  prompt: string;
  aspectRatio?: string;
  referenceCount: number;
};

export type BehaviorEvidence = {
  sessionId: string;
  tools: readonly string[];
  assistantTexts: readonly string[];
  jobs: readonly BehaviorJob[];
  session: { activeSkill: string | null; series: unknown } | null;
};

export type BehaviorCheck = (evidence: BehaviorEvidence) => string[];
export type BehaviorScenario = {
  id: string;
  description: string;
  turns: readonly string[];
  check: BehaviorCheck;
};

function imageJobs(evidence: BehaviorEvidence): BehaviorJob[] {
  return evidence.jobs.filter(job => job.jobType === "image_generation");
}

export const noImageGeneration: BehaviorCheck = evidence =>
  imageJobs(evidence).length ? ["expected no image generation, but an image job was created"] : [];

export const imageGenerationSucceeded: BehaviorCheck = evidence => {
  const jobs = imageJobs(evidence);
  if (!jobs.length) return ["expected an image generation job"];
  return jobs.some(job => job.status === "succeeded")
    ? [] : [`expected a succeeded image job, got ${jobs.map(job => job.status).join(", ")}`];
};

export const promptContains = (text: string): BehaviorCheck => evidence => {
  const jobs = imageJobs(evidence);
  if (!jobs.length) return ["expected an image job to inspect"];
  return jobs.some(job => job.prompt.includes(text))
    ? [] : [`no image prompt contained the required literal ${JSON.stringify(text)}`];
};

export const activeSkillIs = (slug: string): BehaviorCheck => evidence =>
  evidence.session?.activeSkill === slug
    ? [] : [`expected sticky active_skill ${slug}, got ${evidence.session?.activeSkill ?? "none"}`];

export const minReferences = (count: number): BehaviorCheck => evidence => {
  const jobs = imageJobs(evidence);
  if (!jobs.length) return ["expected an image job to inspect"];
  return jobs.some(job => job.referenceCount >= count)
    ? [] : [`no image job used ${count}+ source references`];
};

export const aspectRatioIs = (value: string): BehaviorCheck => evidence => {
  const jobs = imageJobs(evidence);
  if (!jobs.length) return ["expected an image job to inspect"];
  return jobs.some(job => job.aspectRatio === value)
    ? [] : [`no image job used aspect ratio ${value}`];
};

export function combine(...checks: BehaviorCheck[]): BehaviorCheck {
  return evidence => checks.flatMap(check => check(evidence));
}

export const BEHAVIOR_SCENARIOS: readonly BehaviorScenario[] = [
  {
    id: "chat-no-image",
    description: "Casual chat without a design request never generates",
    turns: ["你好，先随便聊聊"],
    check: noImageGeneration,
  },
  {
    id: "discuss-no-image",
    description: "Explicitly not generating stays a discussion",
    turns: ["先别生成，帮我分析一下这个方向"],
    check: noImageGeneration,
  },
  {
    id: "cold-start-logo-route",
    description: "A complete logo brief is routed to logo-design and produces an image",
    turns: ["做一个咖啡品牌 aaaa 的 logo，用于店面招牌，简约现代风格，1024×1024"],
    check: combine(imageGenerationSucceeded, activeSkillIs("logo-design")),
  },
  {
    id: "clarification-answer-generates",
    description: "A short answer after a clarification produces an image under the routed skill",
    turns: ["帮我设计一个咖啡品牌的logo", "品牌名称：aaaa 咖啡；用途：店面招牌；风格方向：简约现代"],
    check: combine(imageGenerationSucceeded, activeSkillIs("logo-design")),
  },
  {
    id: "literal-copy-preserved",
    description: "User literal copy survives into the submitted image prompt",
    turns: ["做一张促销活动海报，主标题必须是『限时五折』，红金活跃风格，1024×1024"],
    check: combine(imageGenerationSucceeded, promptContains("限时五折")),
  },
  {
    id: "game-promo-library-reference",
    description: "Game promo creation consults the workspace library",
    turns: ["做一个游戏充值活动图，标题『充值送好礼』，活跃风格，1024×1024"],
    check: combine(imageGenerationSucceeded, activeSkillIs("game-promo-visuals"), minReferences(1)),
  },
  {
    id: "approximate-ratio-authorized",
    description: "An authorized approximate ratio is submitted as a legal ratio",
    turns: ["做一张促销活动海报，主标题『限时五折』，目标宽高 656×288，尺寸不用精确，比例尽量接近就行"],
    check: combine(imageGenerationSucceeded, aspectRatioIs("656:288")),
  },
];

export function evaluateBehavior(evidence: BehaviorEvidence, scenario: BehaviorScenario): string[] {
  return scenario.check(evidence);
}
