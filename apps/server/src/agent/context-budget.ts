/** Capacity evidence is separate from Loomic's application operating budget. */
export type ContextModelProfile = {
  contextWindowTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  profileSource?: string;
  verifiedAt?: string;
  profileVersion?: string;
  imageTokensPerImage?: number | undefined;
};

export type ContextBudget = Readonly<{
  policyVersion: "loomic-context-v1";
  profileVersion: string | null;
  verification: "verified" | "unverified";
  modelContextWindowTokens: number | null;
  providerMaxInputTokens: number | null;
  providerMaxOutputTokens: number | null;
  applicationWindowTokens: number;
  inputCeilingTokens: number;
  softLimitTokens: number;
  targetTokens: number;
  keepTokens: number;
  generationReserveTokens: number;
  toolGrowthReserveTokens: number;
  uncertaintyReserveTokens: number;
  /** Frozen estimator policy shared by compaction and the final wire guard. */
  imageTokensPerImage?: number;
}>;

export type ContextTokenEstimate = Readonly<{
  source: "conservative_estimate";
  estimatedInputTokens: number;
  estimatedTextTokens: number;
  estimatedImageTokens: number;
  estimatedToolTokens: number;
  imageCount: number;
  messageCount: number;
}>;

export type ContextUsageObservation = ContextTokenEstimate & {
  sequence: number;
  purpose: "agent" | "expert" | "summary" | "intent_review";
  phase: "preflight" | "completed";
  model: string;
  budget: ContextBudget;
  allowed: boolean;
  /** Null means unavailable. Estimates are never reported as actual usage. */
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
};

export type ContextModelOptions = {
  profile?: ContextModelProfile;
  /** Application policy, not a claim about a gateway's verified capacity. */
  operatingPolicy?: "conservative" | "lean-expandable" | "lean-extended-output";
  onUsage?: (observation: ContextUsageObservation) => void;
  purpose?: "agent" | "expert" | "summary" | "intent_review";
};

const tokenFields = ["contextWindowTokens", "maxInputTokens", "maxOutputTokens", "imageTokensPerImage"] as const;

const APIYI_GEMINI_3_1_FLASH_LITE_PROFILE = Object.freeze({
  contextWindowTokens: 1_048_576,
  // APIYI documents one shared context window and a 65,536-token output cap.
  // Subtract the full output cap instead of claiming the entire window as input.
  maxInputTokens: 983_040,
  maxOutputTokens: 65_536,
  profileSource: "https://docs.apiyi.com/news/gemini-3-1-flash-lite-launch",
  verifiedAt: "2026-09-10T00:00:00+08:00",
  profileVersion: "apiyi-gemini-3.1-flash-lite-ga-2026-05-09",
}) satisfies ContextModelProfile;

/** Reject invalid administrator configuration without echoing configuration values. */
export function validateContextModelProfile(value: unknown): ContextModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw profileError();
  const source = value as Record<string, unknown>;
  const allowed = new Set<string>([...tokenFields, "profileSource", "verifiedAt", "profileVersion"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw profileError();
  const result: ContextModelProfile = {};
  for (const key of tokenFields) {
    const value = source[key];
    if (value === undefined) continue;
    const min = key === "contextWindowTokens" ? 8_192 : key === "maxInputTokens" ? 1_024 : key === "maxOutputTokens" ? 256 : 1;
    const max = key === "maxOutputTokens" ? 1_000_000 : key === "imageTokensPerImage" ? 100_000 : 4_000_000;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw profileError();
    result[key] = value;
  }
  for (const key of ["profileSource", "verifiedAt", "profileVersion"] as const) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 500) throw profileError();
    result[key] = value.trim();
  }
  if (result.verifiedAt && !Number.isFinite(Date.parse(result.verifiedAt))) throw profileError();
  if (result.contextWindowTokens !== undefined &&
    ((result.maxInputTokens !== undefined && result.maxInputTokens > result.contextWindowTokens) ||
      (result.maxOutputTokens !== undefined && result.maxOutputTokens >= result.contextWindowTokens))) throw profileError();
  return result;
}

/** Exact-key lookup only: model names never imply a supplier's actual capacity. */
export function resolveContextModelProfile(
  modelRef: string,
  profilesJson?: string,
  upstreamModelId?: string,
): ContextModelProfile | undefined {
  if (!profilesJson?.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(profilesJson); } catch { throw profileError(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw profileError();
  const profiles = parsed as Record<string, unknown>;
  const key = Object.hasOwn(profiles, modelRef) ? modelRef
    : upstreamModelId && Object.hasOwn(profiles, upstreamModelId) ? upstreamModelId : null;
  return key === null ? undefined : validateContextModelProfile(profiles[key]);
}

/**
 * Built-in capacity evidence is deliberately bound to the documented APIYI
 * endpoint and exact upstream model id. A custom gateway using the same model
 * string must provide its own administrator-verified profile.
 */
export function resolveKnownContextModelProfile(
  upstreamModelId: string,
  baseUrl: string,
): ContextModelProfile | undefined {
  if (upstreamModelId !== "gemini-3.1-flash-lite" || !isExactApiYiV1Endpoint(baseUrl)) return undefined;
  return { ...APIYI_GEMINI_3_1_FLASH_LITE_PROFILE };
}

export function resolveContextOperatingPolicy(model: string): NonNullable<ContextModelOptions["operatingPolicy"]> {
  return ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash", "deepseek-flash"].includes(model)
    ? "lean-expandable" : "conservative";
}

export function createContextBudget(profile?: ContextModelProfile,
  policy: ContextModelOptions["operatingPolicy"] = "conservative"): ContextBudget {
  const value = profile ? validateContextModelProfile(profile) : {};
  const verified = hasVerifiedCapacity(value);
  const window = verified ? value.contextWindowTokens ?? null : null;
  const maxInput = verified ? value.maxInputTokens ?? null : null;
  const maxOutput = verified ? value.maxOutputTokens ?? null : null;
  if (policy === "lean-expandable" || policy === "lean-extended-output") {
    // 128K is a user-approved application input allowance, not provider evidence.
    // Targets are ceilings for working history, never padding/minimum spend.
    const outputAllowance = policy === "lean-extended-output" ? 16_000 : 8_000;
    const operating = Math.min(window ?? Infinity, 128_000 + outputAllowance + 16_000);
    const reserve = Math.max(1, Math.min(8_000, Math.floor(operating / 8)));
    const generation = Math.min(outputAllowance, maxOutput ?? Infinity, Math.max(1, Math.floor(operating / 4)));
    const ceiling = Math.min(128_000, maxInput ?? Infinity, operating - generation - reserve * 2);
    if (ceiling < 256) throw profileError();
    return Object.freeze({
      policyVersion: "loomic-context-v1", profileVersion: value.profileVersion ?? null,
      verification: verified ? "verified" : "unverified",
      modelContextWindowTokens: window, providerMaxInputTokens: maxInput, providerMaxOutputTokens: maxOutput,
      applicationWindowTokens: operating, inputCeilingTokens: ceiling,
      softLimitTokens: Math.max(1, Math.min(48_000, Math.floor(ceiling * 0.6))),
      targetTokens: Math.max(1, Math.min(policy === "lean-extended-output" ? 32_000 : 16_000, Math.floor(ceiling * 0.4))),
      keepTokens: Math.max(1, Math.min(8_000, Math.floor(ceiling * 0.2))),
      generationReserveTokens: generation, toolGrowthReserveTokens: reserve, uncertaintyReserveTokens: reserve,
      imageTokensPerImage: verified ? value.imageTokensPerImage ?? 8_192 : 8_192,
    });
  }
  // 64K is an unverified APPLICATION allowance, never a claim about model capacity.
  // A larger verified model does not automatically receive a larger working packet.
  const operating = Math.min(window ?? 64_000, 128_000);
  const reserve = Math.max(1, Math.floor(operating / 8));
  const generation = Math.min(reserve, maxOutput ?? reserve);
  const ceiling = Math.min(maxInput ?? Infinity, operating - generation - reserve * 2);
  if (ceiling < 256) throw profileError();
  return Object.freeze({
    policyVersion: "loomic-context-v1",
    profileVersion: value.profileVersion ?? null,
    verification: verified ? "verified" : "unverified",
    modelContextWindowTokens: window,
    providerMaxInputTokens: maxInput,
    providerMaxOutputTokens: maxOutput,
    applicationWindowTokens: operating,
    inputCeilingTokens: ceiling,
    softLimitTokens: Math.max(1, Math.floor(Math.min(48_000, ceiling * 0.6))),
    targetTokens: Math.max(1, Math.floor(Math.min(32_000, ceiling * 0.4))),
    keepTokens: Math.max(1, Math.floor(Math.min(16_000, ceiling * 0.2))),
    generationReserveTokens: generation,
    toolGrowthReserveTokens: reserve,
    uncertaintyReserveTokens: reserve,
    imageTokensPerImage: verified ? value.imageTokensPerImage ?? 8_192 : 8_192,
  });
}

/**
 * Deliberately conservative, not a tokenizer and not exact supplier usage.
 * Non-ASCII is counted by UTF-8 bytes, avoiding the old Chinese chars/4 bias.
 * Image payload length is not text: charge an explicit image allowance instead.
 */
export function estimateContextTokens(
  messages: readonly unknown[],
  tools?: unknown,
  profile?: ContextModelProfile | ContextBudget,
): ContextTokenEstimate {
  let text = 0;
  let imageCount = 0;
  const verified = profile && ("verification" in profile ? profile.verification === "verified" : hasVerifiedCapacity(profile));
  const imageAllowance = verified ? profile!.imageTokensPerImage ?? 8_192 : 8_192;
  // Deduplicate only true cycles (objects on the current ancestor path). Wire
  // serialization copies a shared subobject on every appearance, so a repeated
  // sibling reference must be counted again or the budget under-counts.
  const visit = (value: unknown, active = new Set<object>()): number => {
    if (typeof value === "string") return estimateText(value);
    if (value === null || value === undefined) return 0;
    if (typeof value === "boolean" || typeof value === "number") return 2;
    if (typeof value !== "object" || active.has(value)) return 0;
    active.add(value);
    let total: number;
    if (Array.isArray(value)) {
      total = value.reduce((sum, item) => sum + visit(item, active), 0);
    } else {
      const record = value as Record<string, unknown>;
      if (["image_url", "input_image", "image"].includes(String(record.type))) {
        imageCount += 1;
        total = 0;
      } else {
        // Other multimodal input is not free either; keep a conservative byte estimate.
        total = Object.entries(record).reduce((sum, [key, item]) => sum + estimateText(key) + visit(item, active), 0);
      }
    }
    active.delete(value);
    return total;
  };
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") { text += visit(raw); continue; }
    const message = raw as Record<string, unknown>;
    text += 12 + visit(message.content ?? message);
    for (const field of ["name", "tool_calls", "tool_call_id"] as const) {
      if (message[field]) text += visit(message[field]);
    }
    // Optional provider-raw message fields kept for compatibility. A caller may
    // still pass a message object that carries the unparsed provider form of a
    // tool call alongside the parsed one; that extra field is real input, so it
    // stays charged rather than ignored. Historical callers also used the
    // `additional_kwargs` carrier for it, so it is read defensively too.
    if (message.additional_kwargs && typeof message.additional_kwargs === "object") {
      const additional = message.additional_kwargs as Record<string, unknown>;
      // The provider-raw form duplicates the parsed tool calls: the wire
      // converter sends the parsed calls when any exist and only falls back to
      // the raw field otherwise, so charging both would count bytes that never
      // go on the wire.
      const parsedCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      text += visit(parsedCalls
        ? Object.fromEntries(Object.entries(additional).filter(([key]) => key !== "tool_calls"))
        : additional);
    }
  }
  const estimatedToolTokens = tools ? visit(tools) + 16 : 0;
  const estimatedImageTokens = imageCount * imageAllowance;
  return Object.freeze({
    source: "conservative_estimate",
    estimatedInputTokens: text + estimatedToolTokens + estimatedImageTokens + 16,
    estimatedTextTokens: text,
    estimatedImageTokens,
    estimatedToolTokens,
    imageCount,
    messageCount: messages.length,
  });
}

export function assertContextBudget(estimate: ContextTokenEstimate, budget: ContextBudget): void {
  if (estimate.estimatedInputTokens <= budget.inputCeilingTokens) return;
  // Preflight failures have no provider response to attach usage to. Keep a
  // numeric-only diagnostic so history, tool schemas and secrets never leak.
  console.warn("[agent-context] input budget exceeded", {
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedTextTokens: estimate.estimatedTextTokens,
    estimatedImageTokens: estimate.estimatedImageTokens,
    estimatedToolTokens: estimate.estimatedToolTokens,
    messageCount: estimate.messageCount,
    inputCeilingTokens: budget.inputCeilingTokens,
  });
  throw Object.assign(new Error("当前任务上下文超过安全输入预算。请整理历史或缩小本次目标后重试；未向模型发送本次请求。"), {
    code: "agent_context_budget_exceeded",
    estimate,
    budget,
  });
}

function estimateText(value: string): number {
  let ascii = 0;
  let nonAsciiBytes = 0;
  for (const char of value) {
    if (char.codePointAt(0)! <= 127) ascii += 1;
    else nonAsciiBytes += Buffer.byteLength(char, "utf8");
  }
  return Math.ceil(ascii / 3) + nonAsciiBytes;
}

function profileError() {
  return Object.assign(new Error("模型上下文能力配置无效，请检查管理员配置。"), { code: "agent_context_profile_invalid" });
}

function isExactApiYiV1Endpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.apiyi.com" && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && (url.pathname === "/v1" || url.pathname === "/v1/");
  } catch {
    return false;
  }
}

function hasVerifiedCapacity(value: ContextModelProfile): boolean {
  return Boolean(value.profileSource?.trim() && value.profileSource.trim().toLowerCase() !== "unverified" &&
    value.verifiedAt && Number.isFinite(Date.parse(value.verifiedAt)) && value.contextWindowTokens &&
    value.maxInputTokens && value.maxOutputTokens && value.maxInputTokens <= value.contextWindowTokens &&
    value.maxOutputTokens < value.contextWindowTokens);
}
