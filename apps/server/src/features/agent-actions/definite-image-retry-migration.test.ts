import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000009_definite_image_retry.sql",
  import.meta.url,
);

describe("definite image retry migration", () => {
  it("creates one immutable-plan retry per explicit request under the session lock", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("add column retry_of uuid references public.image_generation_proposals(id) on delete set null");
    expect(sql).toContain("unique index image_proposal_retry_request_idx");
    expect(sql).toContain("for update of s");
    expect(sql).toContain("private.loomic_is_image_confirmation_message(current_content)");
    expect(sql).toContain("current_proposal->>'id' is distinct from p_id::text");
    expect(sql).toContain("source_job.status::text<>'dead_letter'");
    expect(sql).toContain("source_proposal.input,source_proposal.details,source_proposal.approved_cost");
    expect(sql).toContain("retry_of=p_id and requirement_message_id=current_message_id");
    expect(sql.indexOf("retry_of=p_id and requirement_message_id=current_message_id"))
      .toBeLessThan(sql.indexOf("current_proposal:=public.loomic_get_current_image_proposal"));
  });

  it("allows only a structured rejection or the exact legacy no-channel evidence", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("source_job.error_code is distinct from 'provider_rejected'");
    expect(sql).toContain("source_job.error_code='image_generation_result_unknown'");
    expect(sql).toContain("503[[:space:]]*获取分组[[:space:]]+default[[:space:]]+下模型");
    expect(sql).toContain("[（(]distributor[）)]");
    expect(sql).toContain("no available channel");
    expect(sql).toContain("image_retry_result_not_definite");
    expect(sql).not.toContain("source_job.error_message ~* '503'");
  });
});
