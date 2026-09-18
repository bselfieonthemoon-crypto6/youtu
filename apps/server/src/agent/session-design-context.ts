/**
 * Session-level design context: sticky Skill selection, the current series
 * preferences, and what the last run left unfinished. This is method state only.
 * Execution authorization (submission, ratio approximation, source lineage) is
 * never stored here and stays per-run: the unfinished record is briefing text
 * for the next continuation turn, never a permission to spend or to write.
 */
export type SessionSeriesContext = {
  style?: string;
  sizes?: string[];
  materialAssetIds?: string[];
  updatedAt?: string;
};

/**
 * One output a completed run planned but did not deliver: a request the image
 * tool refused before any submission attempt, or a recorded plan step still
 * `pending`/`in_progress` when the run ended (for example a user cancellation).
 *
 * Progress/method state for the NEXT continuation turn's instruction text only:
 * it creates no design write, resumes no job and grants no execution, billing,
 * model, ratio or source authority. Authorization is re-derived per run.
 */
export type SessionUnfinishedOutput = {
  /** The user-visible name of the missing output, used to name it back to the model. */
  title: string;
  /** `refused` = a pre-submission refusal; `planned` = an open plan step. */
  kind: "refused" | "planned";
  prompt?: string;
  operation?: string;
  aspectRatio?: string;
  sourceAssetIds?: string[];
};

/** Raw refused-call record the image tool appends to the per-run `configurable`. */
export type SessionRefusedOutput = {
  title: string;
  prompt?: string;
  operation?: string;
  aspectRatio?: string;
  sourceAssetIds?: string[];
};

/**
 * Bounds shared by the per-run record, the persisted jsonb column and the
 * migration's CHECK constraint, so a run can never build a list the column
 * would reject. The hard run limit is 8, so eight entries cover one whole run.
 */
export const SESSION_UNFINISHED_MAX_ITEMS = 8;
export const SESSION_UNFINISHED_MAX_TITLE_LENGTH = 200;
export const SESSION_UNFINISHED_MAX_PROMPT_LENGTH = 400;
export const SESSION_UNFINISHED_MAX_SOURCE_IDS = 16;

/**
 * Per-run `configurable` key the image tool appends pre-submission refusals to.
 * The runtime merges it with the run's recorded plan steps and persists the
 * result at run end; nothing here is read as authorization by any gate.
 */
export const SESSION_REFUSED_OUTPUTS_KEY = "session_refused_outputs";

export type SessionDesignContext = {
  activeSkill: string | null;
  activeSkillHash: string | null;
  series: SessionSeriesContext | null;
  /** True after an ask_clarification turn; the next short answer is a generation. */
  awaitingClarification: boolean;
  /** What the last run left undone; empty when the last run finished everything. */
  unfinishedOutputs: SessionUnfinishedOutput[];
};

/** Defaults on; set LOOMIC_SESSION_SKILL_MEMORY=0 to disable without a deploy. */
export function sessionSkillMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.LOOMIC_SESSION_SKILL_MEMORY;
  return value !== "0" && value !== "false" && value !== "off";
}

function seriesFromJson(value: unknown): SessionSeriesContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sizes = Array.isArray(record.sizes) ? record.sizes.filter((item): item is string => typeof item === "string") : undefined;
  const materialAssetIds = Array.isArray(record.materialAssetIds)
    ? record.materialAssetIds.filter((item): item is string => typeof item === "string") : undefined;
  return {
    ...(typeof record.style === "string" && record.style.trim() ? { style: record.style } : {}),
    ...(sizes?.length ? { sizes } : {}),
    ...(materialAssetIds?.length ? { materialAssetIds } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function boundedSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, SESSION_UNFINISHED_MAX_SOURCE_IDS);
}

/** Normalize one raw refused-call record the image tool left on the run context. */
function refusedEntryFromJson(value: unknown): SessionUnfinishedOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = boundedString(record.title, SESSION_UNFINISHED_MAX_TITLE_LENGTH);
  if (!title) return null;
  const prompt = boundedString(record.prompt, SESSION_UNFINISHED_MAX_PROMPT_LENGTH);
  const operation = boundedString(record.operation, 64);
  const aspectRatio = boundedString(record.aspectRatio, 40);
  const sourceAssetIds = boundedSourceIds(record.sourceAssetIds);
  return { title, kind: "refused", ...(prompt ? { prompt } : {}), ...(operation ? { operation } : {}),
    ...(aspectRatio ? { aspectRatio } : {}), ...(sourceAssetIds.length ? { sourceAssetIds } : {}) };
}

/** Normalize the persisted jsonb column (or any untrusted value of that shape). */
function unfinishedFromJson(value: unknown): SessionUnfinishedOutput[] {
  if (!Array.isArray(value)) return [];
  const items: SessionUnfinishedOutput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const title = boundedString(record.title, SESSION_UNFINISHED_MAX_TITLE_LENGTH);
    if (!title) continue;
    const prompt = boundedString(record.prompt, SESSION_UNFINISHED_MAX_PROMPT_LENGTH);
    const operation = boundedString(record.operation, 64);
    const aspectRatio = boundedString(record.aspectRatio, 40);
    const sourceAssetIds = boundedSourceIds(record.sourceAssetIds);
    items.push({ title, kind: record.kind === "refused" ? "refused" : "planned",
      ...(prompt ? { prompt } : {}), ...(operation ? { operation } : {}),
      ...(aspectRatio ? { aspectRatio } : {}), ...(sourceAssetIds.length ? { sourceAssetIds } : {}) });
    if (items.length >= SESSION_UNFINISHED_MAX_ITEMS) break;
  }
  return items;
}

/**
 * Merge one run's refused outputs with the plan steps it left open into the
 * bounded list the next continuation turn is briefed on.
 *
 * Deduplication is by title (the model names an output by its title), so a
 * four-page carousel refused three times yields three entries, not copies of
 * one. Refused entries win over a plan step with the same title because they
 * carry the original operation, ratio and source IDs. Structural only: the
 * caller passes raw values, and nothing here reads prose or authorizes anything.
 */
export function collectUnfinishedSessionOutputs(input: { refused: unknown; planSteps: unknown }): SessionUnfinishedOutput[] {
  const items: SessionUnfinishedOutput[] = [];
  const seenTitles = new Set<string>();
  const push = (entry: SessionUnfinishedOutput) => {
    if (items.length >= SESSION_UNFINISHED_MAX_ITEMS) return;
    const key = entry.title.toLocaleLowerCase();
    if (seenTitles.has(key)) return;
    seenTitles.add(key);
    items.push(entry);
  };
  if (Array.isArray(input.refused)) {
    for (const raw of input.refused) {
      const entry = refusedEntryFromJson(raw);
      if (entry) push(entry);
    }
  }
  if (Array.isArray(input.planSteps)) {
    for (const raw of input.planSteps) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const step = raw as Record<string, unknown>;
      if (step.status !== "pending" && step.status !== "in_progress") continue;
      const title = boundedString(step.title, SESSION_UNFINISHED_MAX_TITLE_LENGTH);
      if (title) push({ title, kind: "planned" });
    }
  }
  return items;
}

/** Best-effort read: a missing table, row or permission must never block a run. */
export async function loadSessionDesignContext(client: any, sessionId: string): Promise<SessionDesignContext | null> {
  try {
    const { data, error } = await client.from("session_design_context")
      .select("active_skill,active_skill_hash,series,awaiting_clarification,unfinished_outputs")
      .eq("session_id", sessionId).maybeSingle();
    if (error || !data) return null;
    return {
      activeSkill: typeof data.active_skill === "string" ? data.active_skill : null,
      activeSkillHash: typeof data.active_skill_hash === "string" ? data.active_skill_hash : null,
      series: seriesFromJson(data.series),
      awaitingClarification: data.awaiting_clarification === true,
      unfinishedOutputs: unfinishedFromJson(data.unfinished_outputs),
    };
  } catch {
    return null;
  }
}

/** Best-effort upsert. Only provided keys are written. */
export async function saveSessionDesignContext(client: any, sessionId: string, patch: {
  activeSkill?: string | null;
  activeSkillHash?: string | null;
  series?: SessionSeriesContext | null;
  awaitingClarification?: boolean;
  /** Unfinished work for the next turn; an empty list clears the column. */
  unfinishedOutputs?: SessionUnfinishedOutput[] | null;
}): Promise<void> {
  try {
    const row: Record<string, unknown> = { session_id: sessionId };
    if ("activeSkill" in patch) row.active_skill = patch.activeSkill ?? null;
    if ("activeSkillHash" in patch) row.active_skill_hash = patch.activeSkillHash ?? null;
    if ("series" in patch) row.series = patch.series ?? null;
    if ("awaitingClarification" in patch) row.awaiting_clarification = patch.awaitingClarification === true;
    if ("unfinishedOutputs" in patch) row.unfinished_outputs = patch.unfinishedOutputs?.length
      ? patch.unfinishedOutputs : null;
    await client.from("session_design_context").upsert(row, { onConflict: "session_id" });
  } catch {
    // Remembering preferences must never fail the user's turn.
  }
}
