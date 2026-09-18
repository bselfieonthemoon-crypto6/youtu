import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../../../../../supabase/migrations/20260913000004_semantic_image_repeat_continuity.sql", import.meta.url);
const rollback = new URL("../../../scripts/test-semantic-image-repeat-continuity-transaction.sql", import.meta.url);

describe("semantic image repeat continuity migration", () => {
  it("trusts a direct-generation ledger only with its exact binding and real scoped job", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("binding.semantic_decision='confirm_current_run'");
    expect(sql).toContain("binding.run_id=p_proposal.origin_run_id");
    expect(sql).toContain("authorization_message.id=p_proposal.requirement_message_id");
    expect(sql).toContain("block->'output'->>'jobid'=p_proposal.id::text");
    expect(sql).toContain("execution.output->>'jobid'=p_proposal.id::text");
    expect(sql).toContain("job.id=p_proposal.id and job.created_by=p_user");
    expect(sql).toContain("job.session_id=p_proposal.session_id and job.canvas_id=p_proposal.canvas_id");
  });

  it("extends bounded relation review to confirmed proposals without ignoring intervening turns", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("candidate.status in ('pending','confirmed')");
    expect(sql).toContain("relation_value not in ('preserve','invalidate')");
    expect(sql).toContain("prior.relation='invalidate'");
    expect(sql).toContain("message.session_sequence<=current_sequence");
    expect(sql).toContain("not private.loomic_image_turn_preserves_proposal(candidate.id,intervening)");
    expect(sql).not.toContain("update public.image_generation_proposals");
  });

  it("applies only 00004 and rolls back the database fixture", async () => {
    const sql = (await readFile(rollback, "utf8")).toLowerCase();
    expect(sql).toContain("20260913000004_semantic_image_repeat_continuity.sql");
    expect(sql).not.toContain("20260913000003_contextual_image_generation_intent.sql");
    expect(sql).toContain("delete from public.background_jobs");
    expect(sql).toContain("tool ledger without real job remained trusted");
    expect(sql.trimEnd()).toMatch(/rollback;$/);
  });
});
