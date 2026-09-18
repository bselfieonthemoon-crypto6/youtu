import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../../../../../supabase/migrations/20260913000001_image_proposal_conversation_relations.sql", import.meta.url);
const semanticMigration = new URL("../../../../../supabase/migrations/20260913000002_semantic_image_confirmation_context.sql", import.meta.url);

describe("image proposal conversation relation migration", () => {
  it("keeps semantic relation writes server-only and actor scoped", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("revoke all on table public.image_proposal_turn_relations from public,anon,authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("session.created_by=p_user");
    expect(sql).toContain("candidate.created_by=p_user");
    expect(sql).toContain("source_run.created_by=p_user");
  });

  it("serializes relation writes and preserves retry/idempotence fences", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("for update of session");
    expect(sql).toContain("for update of candidate");
    expect(sql).toContain("on conflict (proposal_id,message_id) do nothing");
    expect(sql).toContain("image_proposal_relation_conflict");
    expect(sql).toContain("newer.status='pending'");
    expect(sql).toContain("if proposal.status='confirmed' and p_decision='confirm' then return to_jsonb(proposal)");
  });

  it("requires every intervening non-decision turn to have a preserve relation", async () => {
    const sql = (await readFile(migration, "utf8")).toLowerCase();
    expect(sql).toContain("not private.loomic_image_turn_preserves_proposal(candidate.id,intervening)");
    expect(sql).toContain("not private.loomic_image_turn_preserves_proposal(proposal.id,intervening)");
    expect(sql).toContain("relation.relation='preserve'");
    expect(sql).toContain("relation_value not in ('preserve','invalidate')");
  });

  it("moves natural CTA review behind service-only exact message bindings", async () => {
    const sql = (await readFile(semanticMigration, "utf8")).toLowerCase();
    expect(sql).toContain("assistant_message_id uuid references public.chat_messages(id)");
    expect(sql).toContain("loomic_get_contextual_image_confirmation_review");
    expect(sql).toContain("loomic_bind_reviewed_contextual_image_confirmation");
    expect(sql).toContain("binding.assistant_message_id is not null");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("from public,anon,authenticated,service_role");
    expect(sql).toContain("='确认'");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });
});
