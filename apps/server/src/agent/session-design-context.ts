/**
 * Session-level design context: sticky Skill selection plus the current series
 * preferences. This is method state only. Execution authorization (submission,
 * ratio approximation, source lineage) is never stored here and stays per-run.
 */
export type SessionSeriesContext = {
  style?: string;
  sizes?: string[];
  materialAssetIds?: string[];
  updatedAt?: string;
};

export type SessionDesignContext = {
  activeSkill: string | null;
  activeSkillHash: string | null;
  series: SessionSeriesContext | null;
  /** True after an ask_clarification turn; the next short answer is a generation. */
  awaitingClarification: boolean;
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

/** Best-effort read: a missing table, row or permission must never block a run. */
export async function loadSessionDesignContext(client: any, sessionId: string): Promise<SessionDesignContext | null> {
  try {
    const { data, error } = await client.from("session_design_context")
      .select("active_skill,active_skill_hash,series,awaiting_clarification").eq("session_id", sessionId).maybeSingle();
    if (error || !data) return null;
    return {
      activeSkill: typeof data.active_skill === "string" ? data.active_skill : null,
      activeSkillHash: typeof data.active_skill_hash === "string" ? data.active_skill_hash : null,
      series: seriesFromJson(data.series),
      awaitingClarification: data.awaiting_clarification === true,
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
}): Promise<void> {
  try {
    const row: Record<string, unknown> = { session_id: sessionId };
    if ("activeSkill" in patch) row.active_skill = patch.activeSkill ?? null;
    if ("activeSkillHash" in patch) row.active_skill_hash = patch.activeSkillHash ?? null;
    if ("series" in patch) row.series = patch.series ?? null;
    if ("awaitingClarification" in patch) row.awaiting_clarification = patch.awaitingClarification === true;
    await client.from("session_design_context").upsert(row, { onConflict: "session_id" });
  } catch {
    // Remembering preferences must never fail the user's turn.
  }
}
