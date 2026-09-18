export type MastraHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type MastraContextSnapshot = {
  summary: string;
  coverage?: {
    messageIds?: string[];
    omissions?: string[];
  };
};

export type MastraContextSummaryInput = {
  previousSummary: string;
  messages: MastraHistoryMessage[];
  /** Used only while reducing an oversized existing snapshot. */
  priorSummaryFragment?: string;
  omissions: string[];
  targetMaxBytes: number;
};

export type MastraConversationContext = {
  /** Recent verbatim history, in chronological order. */
  messages: MastraHistoryMessage[];
  /** Bounded historical facts. This is evidence, never execution authority. */
  summary: string;
  /** IDs represented by the returned summary, suitable for a snapshot commit. */
  coverageMessageIds: string[];
  omissions: string[];
  /** True when the database end or an existing snapshot boundary was reached. */
  sourceExhausted: boolean;
};

type MastraHistoryClient = {
  from(table: "chat_messages"): any;
};

type CompileMastraConversationContextInput = {
  client: MastraHistoryClient;
  sessionId: string;
  currentPrompt: string;
  currentUserMessageId?: string;
  snapshot?: MastraContextSnapshot | null;
  summarize(input: MastraContextSummaryInput): Promise<string>;
  limits?: Partial<{
    pageSize: number;
    maxPages: number;
    recentMessages: number;
    maxContextBytes: number;
    summaryTargetBytes: number;
    summarizerInputBytes: number;
  }>;
};

const DEFAULT_LIMITS = {
  pageSize: 80,
  maxPages: 25,
  recentMessages: 12,
  maxContextBytes: 48_000,
  summaryTargetBytes: 12_000,
  summarizerInputBytes: 28_000,
};

const OLDER_HISTORY_OMISSION =
  "Earlier messages exceed the bounded context window and remain available through the read-only conversation evidence tool.";
const SUMMARY_FALLBACK_OMISSION =
  "Historical summary refresh was unavailable; recent messages are included verbatim and older evidence remains available through the read-only conversation evidence tool.";

/**
 * Compile bounded Mastra history without a fixed-row silent truncation.
 * Binary/content-block payloads are never selected. Older text is reduced in
 * finite batches; hitting the hard scan bound records an explicit omission so
 * the agent can retrieve exact evidence on demand without rejecting the turn.
 */
export async function compileMastraConversationContext(
  input: CompileMastraConversationContextInput,
): Promise<MastraConversationContext> {
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...input.limits });
  const covered = new Set(input.snapshot?.coverage?.messageIds ?? []);
  const newestFirst: MastraHistoryMessage[] = [];
  const seen = new Set<string>();
  let sourceExhausted = false;
  let inspectedNewestForPromptFallback = false;

  for (let page = 0; page < limits.maxPages; page += 1) {
    const offset = page * limits.pageSize;
    const result = await input.client
      .from("chat_messages")
      .select("id,role,content,created_at")
      .eq("session_id", input.sessionId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limits.pageSize - 1);
    if (result.error) throw new Error("conversation_history_unavailable");

    const rawRowCount = Array.isArray(result.data) ? result.data.length : 0;
    const pageRows = normalizeRows(result.data);
    let reachedSnapshot = false;
    for (const message of pageRows) {
      if (covered.has(message.id)) {
        reachedSnapshot = true;
        break;
      }
      if (input.currentUserMessageId && message.id === input.currentUserMessageId) continue;
      if (!input.currentUserMessageId && !inspectedNewestForPromptFallback) {
        inspectedNewestForPromptFallback = true;
        if (message.role === "user" && normalizePrompt(message.content) === normalizePrompt(input.currentPrompt)) {
          continue;
        }
      }
      if (!seen.has(message.id)) {
        seen.add(message.id);
        newestFirst.push(message);
      }
    }

    // Invalid/empty rows are ignored as context, but still occupy a database
    // page. Only the raw query length can prove that pagination reached EOF.
    if (reachedSnapshot || rawRowCount < limits.pageSize) {
      sourceExhausted = true;
      break;
    }
  }

  // Keep the newest 100 so a freshly computed omission is never discarded.
  const omissions = unique([
    ...(input.snapshot?.coverage?.omissions ?? []),
    ...(!sourceExhausted ? [OLDER_HISTORY_OMISSION] : []),
  ]).slice(-100);
  const chronological = newestFirst.reverse();
  const seedSummary = input.snapshot?.summary ?? "";
  // Short ordinary conversations should remain verbatim and incur no extra
  // model call merely because they crossed the recent-window count. Compress
  // only when the bounded byte budget (or finite scan boundary) requires it.
  if (sourceExhausted && byteSize({ summary: seedSummary, messages: chronological }) <= limits.maxContextBytes) {
    return {
      messages: chronological,
      summary: seedSummary,
      coverageMessageIds: unique(input.snapshot?.coverage?.messageIds ?? []).slice(-2_000),
      omissions,
      sourceExhausted,
    };
  }
  // Keep an immutable copy for the failure path. A summarizer is an optional
  // optimization: it must never make a normal turn unavailable.
  const historyForReduction = [...chronological];
  const recent = historyForReduction.splice(-limits.recentMessages);
  const older = historyForReduction;
  const directBudget = Math.max(
    1_000,
    limits.maxContextBytes - limits.summaryTargetBytes - 2_000,
  );
  while (recent.length && byteSize(recent) > directBudget) {
    older.push(recent.shift()!);
  }

  try {
    let summary = await reduceSnapshotSummary(
      seedSummary,
      omissions,
      limits,
      input.summarize,
    );
    summary = await summarizeMessages(
      summary,
      older,
      omissions,
      limits,
      input.summarize,
    );

    // Model-produced summaries can vary in size. Keep moving the oldest direct
    // item through the same bounded reducer until the final historical packet
    // fits; the current user prompt is reserved outside this helper.
    const additionallySummarized: MastraHistoryMessage[] = [];
    while (recent.length && byteSize({ summary, messages: recent }) > limits.maxContextBytes) {
      additionallySummarized.push(recent.shift()!);
    }
    if (additionallySummarized.length) {
      summary = await summarizeMessages(
        summary,
        additionallySummarized,
        omissions,
        limits,
        input.summarize,
      );
    }

    const newlyCovered = [...older, ...additionallySummarized].map(message => message.id);
    // Keep the newest boundary IDs when a replacement snapshot reaches the
    // schema's bounded coverage list. Exact older text remains evidence-only.
    const coverageMessageIds = unique([
      ...(input.snapshot?.coverage?.messageIds ?? []),
      ...newlyCovered,
    ]).slice(-2_000);

    return {
      messages: recent,
      summary,
      coverageMessageIds,
      omissions,
      sourceExhausted,
    };
  } catch {
    // The live request is always appended by the runtime after this compiler,
    // so it remains literal even when compression fails. Durable chat history
    // contains only user/assistant text; tool calls and results are emitted
    // separately and therefore cannot be split into an invalid pair here.
    return buildSummaryFallback({
      messages: chronological,
      ...(input.snapshot !== undefined ? { snapshot: input.snapshot } : {}),
      omissions,
      sourceExhausted,
      limits,
    });
  }
}

function buildSummaryFallback(input: {
  messages: MastraHistoryMessage[];
  snapshot?: MastraContextSnapshot | null;
  omissions: string[];
  sourceExhausted: boolean;
  limits: typeof DEFAULT_LIMITS;
}): MastraConversationContext {
  // An existing summary is usable only when it already meets the active byte
  // ceiling. Never re-store a summary that the current budget cannot safely
  // send, and do not claim coverage for one we had to discard.
  const snapshotSummary = input.snapshot?.summary?.trim() ?? "";
  const summary = snapshotSummary && byteSize(snapshotSummary) <= input.limits.summaryTargetBytes
    ? snapshotSummary
    : "";
  const messages = newestMessagesThatFit(input.messages, summary, input.limits.maxContextBytes);
  const omissions = unique([
    ...input.omissions,
    SUMMARY_FALLBACK_OMISSION,
    ...(snapshotSummary && !summary ? ["Existing historical summary exceeded the active context budget and was not used."] : []),
  ]).slice(-100);

  return {
    messages,
    summary,
    coverageMessageIds: summary ? unique(input.snapshot?.coverage?.messageIds ?? []).slice(-2_000) : [],
    omissions,
    sourceExhausted: input.sourceExhausted,
  };
}

function newestMessagesThatFit(
  chronological: MastraHistoryMessage[],
  summary: string,
  maxContextBytes: number,
): MastraHistoryMessage[] {
  const selected: MastraHistoryMessage[] = [];
  for (const message of [...chronological].reverse()) {
    const candidate = [message, ...selected];
    if (byteSize({ summary, messages: candidate }) <= maxContextBytes) {
      selected.unshift(message);
      continue;
    }
    // Keep some literal context for a single oversized newest record instead
    // of returning an empty history. The current live user request is passed
    // outside this packet and is never truncated by this fallback.
    if (!selected.length) {
      const truncated = truncateMessageToFit(message, summary, maxContextBytes);
      if (truncated) selected.unshift(truncated);
    }
    break;
  }
  return selected;
}

function truncateMessageToFit(
  message: MastraHistoryMessage,
  summary: string,
  maxContextBytes: number,
): MastraHistoryMessage | null {
  const characters = [...message.content];
  const marker = "\n[... historical message omitted ...]\n";
  // This is intentionally a projection, not a quote: retain both the opening
  // request and its latest correction, which commonly appears at the end.
  // Binary search bounds serialization work even for a very large attachment
  // transcript or pasted prompt.
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    const content = keep >= characters.length
      ? message.content
      : `${characters.slice(0, head).join("")}${marker}${characters.slice(characters.length - tail).join("")}`;
    if (byteSize({ summary, messages: [{ ...message, content }] }) <= maxContextBytes) {
      best = content;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best ? { ...message, content: best } : null;
}

async function reduceSnapshotSummary(
  source: string,
  omissions: string[],
  limits: typeof DEFAULT_LIMITS,
  summarize: CompileMastraConversationContextInput["summarize"],
): Promise<string> {
  if (byteSize(source) <= limits.summaryTargetBytes) return source;
  let summary = "";
  for (const fragment of splitTextByBytes(source, Math.max(1_000, limits.summarizerInputBytes / 2))) {
    summary = await boundedSummary(summarize, {
      previousSummary: summary,
      priorSummaryFragment: fragment,
      messages: [],
      omissions,
      targetMaxBytes: limits.summaryTargetBytes,
    }, limits);
  }
  return summary;
}

async function summarizeMessages(
  seed: string,
  messages: MastraHistoryMessage[],
  omissions: string[],
  limits: typeof DEFAULT_LIMITS,
  summarize: CompileMastraConversationContextInput["summarize"],
): Promise<string> {
  let summary = seed;
  for (const batch of messageBatches(messages, limits.summarizerInputBytes)) {
    summary = await boundedSummary(summarize, {
      previousSummary: summary,
      messages: batch,
      omissions,
      targetMaxBytes: limits.summaryTargetBytes,
    }, limits);
  }
  return summary;
}

async function boundedSummary(
  summarize: CompileMastraConversationContextInput["summarize"],
  request: MastraContextSummaryInput,
  limits: typeof DEFAULT_LIMITS,
): Promise<string> {
  let summary = (await summarize(request)).trim();
  if (!summary) throw new Error("conversation_summary_empty");
  // A second reduction remains bounded and avoids slicing away arbitrary facts
  // when a provider ignores the requested output size on the first call.
  if (byteSize(summary) > limits.summaryTargetBytes) {
    summary = (await summarize({
      previousSummary: "",
      priorSummaryFragment: summary,
      messages: [],
      omissions: request.omissions,
      targetMaxBytes: limits.summaryTargetBytes,
    })).trim();
    if (!summary || byteSize(summary) > limits.summaryTargetBytes) {
      throw new Error("conversation_summary_invalid");
    }
  }
  return summary;
}

function messageBatches(messages: MastraHistoryMessage[], maxBytes: number): MastraHistoryMessage[][] {
  const expanded = messages.flatMap(message => splitMessage(message, Math.max(1_000, maxBytes / 2)));
  const batches: MastraHistoryMessage[][] = [];
  let batch: MastraHistoryMessage[] = [];
  for (const message of expanded) {
    if (batch.length && byteSize([...batch, message]) > maxBytes) {
      batches.push(batch);
      batch = [];
    }
    batch.push(message);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function splitMessage(message: MastraHistoryMessage, maxBytes: number): MastraHistoryMessage[] {
  if (byteSize(message.content) <= maxBytes) return [message];
  return splitTextByBytes(message.content, maxBytes).map((content, index) => ({
    ...message,
    content: `[fragment ${index + 1}] ${content}`,
  }));
}

function splitTextByBytes(source: string, maxBytes: number): string[] {
  const fragments: string[] = [];
  let fragment = "";
  let bytes = 0;
  for (const character of source) {
    const next = byteSize(character);
    if (fragment && bytes + next > maxBytes) {
      fragments.push(fragment);
      fragment = "";
      bytes = 0;
    }
    fragment += character;
    bytes += next;
  }
  if (fragment) fragments.push(fragment);
  return fragments;
}

function normalizeRows(value: unknown): MastraHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || (item.role !== "user" && item.role !== "assistant") ||
        typeof item.content !== "string" || !item.content.trim() || typeof item.created_at !== "string") return [];
    return [{ id: item.id, role: item.role, content: item.content, createdAt: item.created_at }];
  });
}

function normalizePrompt(value: string): string {
  return value.trim().replace(/[\s。.!！?？]+$/u, "");
}

function validateLimits(limits: typeof DEFAULT_LIMITS): typeof DEFAULT_LIMITS {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("mastra_context_limits_invalid");
  }
  if (limits.pageSize > 200 || limits.maxPages > 50 || limits.recentMessages > 100 ||
      limits.maxContextBytes > 256_000 || limits.summaryTargetBytes >= limits.maxContextBytes ||
      limits.summarizerInputBytes > 128_000) throw new Error("mastra_context_limits_invalid");
  return limits;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
