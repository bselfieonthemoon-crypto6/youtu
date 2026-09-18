import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../../../../../supabase/migrations/20260913000003_contextual_image_generation_intent.sql", import.meta.url);
const rollback = new URL("../../../scripts/test-contextual-image-generation-intent-transaction.sql", import.meta.url);

describe("contextual image generation intent migration", () => {
  it("keeps semantic review separate from transactional proposal authority", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("semantic_decision in ('confirm_existing','confirm_current_run')");
    expect(sql).toContain("candidate.origin_run_id=p_run");
    expect(sql).toContain("candidate.requirement_message_id=current_message.id");
    expect(sql).toContain("for update of session");
    expect(sql).toContain("for update of candidate");
    expect(sql).toContain("binding.semantic_decision='confirm_current_run'");
    expect(sql).toContain("proposal.status='confirmed' and p_decision='confirm' then return to_jsonb(proposal)");
  });

  it("exposes only service-role review/binding RPCs and no image bytes", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("loomic_get_semantic_image_confirmation_review");
    expect(sql).toContain("loomic_get_semantic_current_run_image_confirmation_review");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("'inputimagecount'");
    expect(sql).not.toContain("'inputimages',proposal.input");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("applies only migration 00003 in the rollback transaction corpus", async () => {
    const sql = (await readFile(rollback, "utf8")).toLowerCase();
    expect(sql).toContain("begin;");
    expect(sql).toContain("20260913000003_contextual_image_generation_intent.sql");
    expect(sql).not.toContain("20260913000001_image_proposal_conversation_relations.sql");
    expect(sql).not.toContain("20260913000002_semantic_image_confirmation_context.sql");
    expect(sql.trimEnd()).toMatch(/rollback;$/);
    expect(sql).toContain("cross-owner semantic binding unexpectedly succeeded");
  });
});
