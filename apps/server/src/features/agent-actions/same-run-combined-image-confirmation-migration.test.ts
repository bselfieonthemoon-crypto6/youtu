import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000016_same_run_combined_image_confirmation.sql",
  import.meta.url,
);

describe("same-run combined image confirmation migration", () => {
  it("keeps combined wording out of the ordinary classifier and binds the exact run and requirement", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create function private.loomic_is_combined_current_image_confirmation");
    expect(sql).not.toContain("loomic_classify_image_message");
    expect(sql).toContain("proposal.origin_run_id=p_run");
    expect(sql).toContain("proposal.requirement_message_id=current_id");
    expect(sql).toContain("private.loomic_image_confirmation_matches_proposal(current_content,proposal.input)");
  });

  it("patches only the atomic decision predicate and does not create or rewrite proposals", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("pg_get_functiondef('public.loomic_decide_current_image(uuid,uuid,uuid,uuid,text)'::regprocedure)");
    expect(sql).not.toContain("insert into public.image_generation_proposals");
    expect(sql).not.toContain("update public.image_generation_proposals");
    expect(sql).not.toContain("loomic_get_current_image_proposal");
  });
});
