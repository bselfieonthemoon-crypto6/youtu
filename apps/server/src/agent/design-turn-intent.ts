import type { MessageMention } from "@loomic/shared";

/**
 * Deterministic turn classification for the session design context. This is a
 * routing hint for method selection, never execution authorization: image
 * submission, ratio approximation and source lineage stay per-run.
 */
export type DesignTurnIntent = "new_generation" | "series_continuation" | "local_edit" | "non_design";

const CONTINUATION_PATTERN =
  /(?:再来一?张|再来一?版|再出一张|同一套|同系列|同款|同一会?风格|继续|接着|还是这(?:个|种)(?:风格)?|还是刚才|按这个|按刚才|照这个|照刚才|一样的风格|这个尺寸再来|换(?:个)?主题(?:但|,|，)?(?:还是|同|保持)|another one|same style|keep the style|continue)/i;

const GENERATION_PATTERN =
  /(?:生成|做(?:一|个|一版|一套|成)|再(?:做|出|来)|重新(?:做|生成|来|出)|设计一?个|制作|出图|出一张|换个主题|换一张|新主题|新尺寸|新的一张|另(?:外)?一张|generate|create|make (?:a|an|another)|design (?:a|an))/i;

const EDIT_PATTERN =
  /(?:改(?:成|为|一下|下|掉|小)?|换(?:成|为|个|一下|掉)?(?:颜色|底色|背景|字体|文字|文案|标题|logo|图标|元素)|去掉|去除|删除|移除|擦除|抹掉|挪(?:动|一下)?|移动|位移|调整|微调|放大|缩小|变大|变小|加(?:上|个)?(?:字|文字|标题|logo|图标)|补上|旋转|裁切|裁剪|调(?:整|一下|下)|把.{0,16}(?:改|换|调)|remove|delete|recolou?r|resize|move|tweak|adjust)/i;

const NEGATION_PATTERN =
  /(?:不要(?:生成|做|出图|图片)|先不(?:要|做|生成|出图)|别(?:急着|着急|忙)?(?:生成|做|出图)|不用生成|不需要生成|先(?:讨论|聊|说|看看)|只(?:讨论|聊|说)|先别(?:做|生成))/i;

const QUESTION_PATTERN = /(?:怎么|如何|为什么|能不能|可不可以|可以吗|是否|哪些|什么|多少|吗|呢|要不要|how|why|what|can (?:you|i)|is it|should)/i;

/**
 * Explanatory questions ask HOW/WHY something works. They are informational even
 * when they contain an action verb: "怎么生成一张高质量的海报？" must not be
 * classified as a generation request, because a `new_generation` verdict
 * preloads a Skill and sediments a new series — so a question would silently
 * overwrite what the session had remembered.
 */
const EXPLANATORY_QUESTION_PATTERN =
  /(?:怎么|如何|为什么|为何|是什么|哪些|哪种|多少|需要多久|why\b|how\s+(?:do|does|to|can|should)|what\s+(?:is|are))/i;

/**
 * A bare brief that names the deliverable without any action verb
 * ("游戏活动的产品主图") is still a creation request. Only consulted when the
 * prompt is not interrogative, so "这个海报怎么样" stays informational.
 */
const DELIVERABLE_NOUN_PATTERN =
  /(?:海报|主图|封面|头图|配图|宣传图|主视觉|横幅|图标|字标|标志|轮播|九宫格|详情页|落地页|插画|banner|poster|cover|logo|kv\b)/i;

// Re-rolling the elements/subject of the same deliverable is another render of
// the series, not a property edit of one existing object.
const ELEMENT_CHANGE_PATTERN =
  /(?:(?:换个|换一批|重新(?:换|出|做|生成)|再来一?版|再出一?版|再换一?版)[^，。；,;]{0,10}(?:元素|主体|角色|人物|道具|构图|画面|版本|方案|插画|插图))/i;

// A style/colour direction change is a refinement of the same deliverable, not
// an unrelated turn: keep the text/size and re-render the series.
const STYLE_CHANGE_PATTERN =
  /(?:(?:换|改)(?:成|为|个|一下)?[^，。；,;]{0,12}(?:风格|色调|配色|主题色)|(?:风格|色调|配色)(?:换|改)(?:成|为)|换个(?:风格|色调|配色))/i;

// An explicit reset restarts the series even inside a continuation phrase.
const RESET_PATTERN = /(?:重开|重新开始|新的?系列|换(?:一|个)套|换一个系列|另起一套|不(?:要|用)?沿用|别沿用|忘(?:掉|记)之前|从头来|清空(?:之前|已)?(?:的)?(?:偏好|设置|风格)?|reset|start over|new series)/i;

// Deterministic style vocabulary so a new generation can sediment a compact
// style hint without any extra model call.
const STYLE_HINTS = [
  "高端", "奢华", "高级感", "轻奢", "豪华", "黑金", "金色", "鎏金", "暗黑", "霓虹", "电竞", "赛博", "蒸汽波",
  "活力", "明快", "明亮", "清新", "温暖", "冷色", "高对比", "渐变", "柔和", "柔光", "光晕", "发光",
  "海洋", "深海", "水下", "海底", "极地", "沙漠", "森林", "太空", "都市", "都会", "赛博朋克",
  "简约", "极简", "复古", "国潮", "科技", "未来", "卡通", "写实", "扁平", "立体", "像素", "水彩", "手绘",
  "质感", "磨砂", "金属", "玻璃", "粗体", "衬线", "无衬线", "手写", "3D", "插画", "写意",
];

/** Union of style descriptors, preserving the earlier direction on refinement. */
export function mergeStyleHints(existing: string | undefined, next: string | undefined): string | undefined {
  const tokens = [...new Set([...(existing?.split("、") ?? []), ...(next?.split("、") ?? [])]
    .map(token => token.trim()).filter(Boolean))];
  return tokens.length ? tokens.join("、") : undefined;
}

/** Compact, deterministic style descriptors present in the user's own words. */
export function extractStyleHints(prompt: string): string | undefined {
  const hints: string[] = [];
  for (const hint of STYLE_HINTS) if (prompt.includes(hint) && !hints.includes(hint)) hints.push(hint);
  for (const match of prompt.matchAll(/(?:深|浅|暗|亮|暖|冷)?(?:黑|白|金|银|红|蓝|绿|紫|橙|粉|青|灰|棕|黄)色/g)) {
    if (!hints.includes(match[0])) hints.push(match[0]);
  }
  return hints.length ? hints.slice(0, 6).join("、") : undefined;
}

export type SkillRouteSource = { name: string; metadata?: Record<string, unknown> | undefined };
export type SkillTier = "primary" | "helper";
/** `tier` decides which slot a Skill competes for; see `selectHelperSkills`. */
export type SkillRoute = { skill: string; keywords: string[]; priority: number; tier: SkillTier };

function mentionSkillSlugs(mentions: readonly MessageMention[]): string[] {
  return mentions
    .filter((mention): mention is Extract<MessageMention, { mentionType: "skill" }> => mention.mentionType === "skill")
    .map(mention => mention.slug);
}

/** Routing is declared by each Skill's manifest, never hardcoded in the runtime. */
export function skillRoutesFromMetadata(skills: readonly SkillRouteSource[]): SkillRoute[] {
  const routes: SkillRoute[] = [];
  for (const skill of skills) {
    const loomic = skill.metadata?.loomic as Record<string, unknown> | undefined;
    const routing = loomic?.routing as { keywords?: unknown; priority?: unknown; tier?: unknown } | undefined;
    if (!routing || !Array.isArray(routing.keywords) || typeof routing.priority !== "number") continue;
    const keywords = routing.keywords.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0);
    if (keywords.length) routes.push({ skill: skill.name, keywords, priority: routing.priority,
      tier: routing.tier === "helper" ? "helper" : "primary" });
  }
  return routes.sort((left, right) => right.priority - left.priority || left.skill.localeCompare(right.skill));
}

/** Length-weighted keyword score shared by the primary and helper tiers. */
function routeScore(text: string, keywords: readonly string[]): number {
  let score = 0;
  for (const keyword of new Set(keywords)) {
    if (text.includes(keyword.toLowerCase())) score += keyword.length;
  }
  return score;
}

/**
 * Matching HELPER Skills, highest scoring first.
 *
 * Workflow / reference / prompt / domain guides modify a deliverable rather than
 * being one, so they must never take the single primary slot — but they must
 * still reach the model in the SAME turn. Relying on the model to notice them in
 * the compact catalog is what made Skill dispatch feel unreliable: a weak model
 * simply skipped the extra `list_skills` + `use_skill` round trip.
 *
 * Only the top `max` matches are returned so one broad prompt ("海报文案") cannot
 * flood the context with every guide.
 */
export function selectHelperSkills(input: {
  prompt: string; skills: readonly SkillRouteSource[]; max?: number;
}): string[] {
  const text = input.prompt.toLowerCase();
  const scored: Array<{ skill: string; score: number }> = [];
  for (const route of skillRoutesFromMetadata(input.skills)) {
    if (route.tier !== "helper") continue;
    const score = routeScore(text, route.keywords);
    if (score) scored.push({ skill: route.skill, score });
  }
  scored.sort((left, right) => right.score - left.score || left.skill.localeCompare(right.skill));
  return scored.slice(0, input.max ?? 2).map(entry => entry.skill);
}

/**
 * Session series state may only be REPLACED when this run actually performed a
 * design write.
 *
 * The turn classifier is a regex hint, and a wrong `new_generation` used to
 * discard the remembered style / size / material outright — asking "怎么生成一张
 * 海报？" was enough to wipe them. Gating the overwrite on a real write receipt
 * makes a misclassification harmless: nothing was generated, so nothing is
 * overwritten. Continuations merge in place and are decided separately.
 */
export function shouldReplaceSessionSeries(input: {
  designIntent: DesignTurnIntent;
  performedDesignWrite: boolean;
}): boolean {
  return input.designIntent === "new_generation" && input.performedDesignWrite;
}

/**
 * Explicit @Skill mention wins. Otherwise each Skill's declared routing keywords
 * are SCORED rather than first-match-wins:
 *
 *   score = sum of the length of every distinct declared keyword present
 *
 * Length stands in for specificity, so a concrete keyword ("主视觉") outweighs a
 * generic one ("logo"), and several corroborating keywords outweigh a single
 * incidental hit. `priority` only breaks an exact score tie.
 *
 * The previous rule — walk routes by descending priority and return the first
 * route with any keyword hit — let one incidental generic keyword hijack a turn:
 * "海报上放我们的 logo，做一个活动主视觉" routed to logo-design (priority 60)
 * even though three keywords pointed at campaign-design.
 */
export function selectPrimarySkill(input: {
  prompt: string; mentions: readonly MessageMention[]; skills: readonly SkillRouteSource[];
}): string | undefined {
  const mentioned = mentionSkillSlugs(input.mentions);
  if (mentioned.length) return mentioned[0];
  const text = input.prompt.toLowerCase();
  let best: { skill: string; score: number; priority: number } | undefined;
  for (const route of skillRoutesFromMetadata(input.skills)) {
    // A helper guide must never take the deliverable slot.
    if (route.tier === "helper") continue;
    const score = routeScore(text, route.keywords);
    if (!score) continue;
    // Higher score wins; declaration priority is only a tie-breaker, so it can
    // no longer override a clearly better-matching Skill.
    if (!best || score > best.score || (score === best.score && route.priority > best.priority))
      best = { skill: route.skill, score, priority: route.priority };
  }
  return best?.skill;
}

/** Deterministic "WxH" / "W:H" targets present in the current request. */
export function extractTargetSizes(prompt: string): string[] {
  const sizes = new Set<string>();
  // Store every target as W:H so series sizes always compare as ratios.
  for (const match of prompt.matchAll(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/g)) sizes.add(`${match[1]}:${match[2]}`);
  for (const match of prompt.matchAll(/(\d{1,5})\s*[:：]\s*(\d{1,5})/g)) sizes.add(`${match[1]}:${match[2]}`);
  return [...sizes];
}

/**
 * Order matters: explicit mention and hard negation win first, then an
 * explanatory question (informational even when it contains an action verb),
 * then series continuation, then creation, then a bare deliverable brief, then
 * local edit. Anything ambiguous stays non_design so no remembered state is
 * silently applied or overwritten.
 */
export function classifyDesignTurnIntent(input: {
  prompt: string;
  mentions: readonly MessageMention[];
  activeSkill: string | null;
  hasSeries: boolean;
  hasAttachments: boolean;
  clarificationPending?: boolean;
}): DesignTurnIntent {
  const prompt = input.prompt.trim();
  if (!prompt) return "non_design";
  if (mentionSkillSlugs(input.mentions).length) return "new_generation";
  if (NEGATION_PATTERN.test(prompt)) return "non_design";
  // An explanatory question is informational even when it names an action verb,
  // so it is resolved before the reset/continuation/generation branches.
  if (EXPLANATORY_QUESTION_PATTERN.test(prompt)) return "non_design";
  // An explicit reset always starts a fresh series, even with continuation words.
  if (RESET_PATTERN.test(prompt)) return "new_generation";
  // "再来一张" / "换成海洋风格" / "换个元素和主体" with no remembered series
  // starts one; with a series they continue it (keeping text/size).
  if (CONTINUATION_PATTERN.test(prompt) || STYLE_CHANGE_PATTERN.test(prompt) || ELEMENT_CHANGE_PATTERN.test(prompt))
    return input.hasSeries ? "series_continuation" : "new_generation";
  if (GENERATION_PATTERN.test(prompt)) return "new_generation";
  // An edit verb outranks a bare deliverable noun: "把海报上的文字改成蓝色" names
  // the deliverable but is a property edit of an existing object.
  if (EDIT_PATTERN.test(prompt)) return "local_edit";
  // A brief that only names the deliverable ("游戏活动的产品主图") has no action
  // verb but is unambiguously a creation request. Interrogative prompts were
  // already handled above, so this cannot swallow a question.
  if (DELIVERABLE_NOUN_PATTERN.test(prompt) && !QUESTION_PATTERN.test(prompt)) return "new_generation";
  if (QUESTION_PATTERN.test(prompt)) return "non_design";
  // A short factual answer to a pending clarification is a generation request,
  // so the server preloads the skill and captures the series instead of relying
  // on the model to re-select from the catalog.
  if (input.clarificationPending) return "new_generation";
  return "non_design";
}
