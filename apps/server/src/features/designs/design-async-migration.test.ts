import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260904000001_design_lifecycle_and_async_delivery.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string, nextMarker: string) {
  return sql.slice(
    sql.indexOf(name),
    sql.indexOf(nextMarker, sql.indexOf(name)),
  );
}

describe("design lifecycle and async delivery migration", () => {
  it("keeps lifecycle mutations transactional, CAS-protected and service-only", () => {
    for (const name of [
      "loomic_design_rename",
      "loomic_design_soft_delete",
      "loomic_design_restore",
      "loomic_design_copy",
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${name}`);
    }
    expect(sql).toContain("design_revision_conflict");
    expect(sql).toContain("canvas_revision_conflict");
    expect(sql).toContain("design_lifecycle_requests");
    expect(sql).toContain("design_copy_requests");
    expect(sql).toContain("object_id_map");
    expect(sql).toContain("'{childObjectIds}'");
    expect(sql).toContain("'updateType', 'renamed'");
    expect(sql).toContain("'updateType', 'deleted'");
    expect(sql).toContain("'updateType', 'restored'");
    expect(sql).toContain("TO service_role;");
  });

  it("queues member previews but keeps asset commit off authenticated SQL", () => {
    const queue = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_preview_queue",
      "CREATE OR REPLACE FUNCTION public.loomic_design_preview_commit",
    );
    const commit = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_preview_commit",
      "CREATE OR REPLACE FUNCTION public.loomic_design_reconcile_references",
    );
    expect(queue).toContain("private.loomic_assert_design_member");
    expect(queue).toContain(
      "'design_preview_jobs', 'design_preview', 'queued'",
    );
    expect(queue).toContain("'revision', p_expected_revision");
    expect(queue).toContain("'status', CASE");
    expect(commit).toContain("private.loomic_assert_design_member");
    expect(commit).toContain(
      "design_row.revision IS DISTINCT FROM p_expected_revision",
    );
    expect(commit).toContain("'committed', false");
    expect(commit).toContain("'updateType', 'preview'");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.loomic_design_preview_queue(uuid, bigint, uuid, uuid, uuid)",
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.loomic_design_preview_commit[\s\S]{0,300}TO authenticated/,
    );
  });

  it("leases outbox rows and stops hot retries after three attempts", () => {
    const claim = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_outbox_claim",
      "CREATE OR REPLACE FUNCTION public.loomic_design_outbox_mark_published",
    );
    const failed = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_design_outbox_mark_failed",
      "CREATE OR REPLACE FUNCTION public.loomic_design_outbox_reconcile",
    );
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim).toContain("attempt_count < 3");
    expect(claim).toContain("interval '5 minutes'");
    expect(failed).toContain("LEAST(300, 5 * power(2");
    expect(sql).toContain("'type', 'design.sync'");
    expect(sql).not.toContain("'changeType'");
    expect(sql).not.toContain("'commands_applied'");
  });

  it("uses a stable UUID command for idempotent target finalization", () => {
    expect(sql).toContain("background_jobs_design_export_idempotency_key");
    const claim = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_job_finalization_claim",
      "CREATE OR REPLACE FUNCTION public.loomic_job_finalization_finish",
    );
    expect(claim).toContain("p_command_id uuid");
    expect(claim).toContain("job_target_finalizations");
    expect(claim).toContain("command_id");
    expect(claim).toContain("attempt_count");
    expect(sql).toContain("'needs_attention'");
  });
});
