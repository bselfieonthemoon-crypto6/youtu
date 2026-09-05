import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260904000003_design_async_worker_recovery.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

describe("design async worker recovery migration", () => {
  it("marks only a terminal preview job at its frozen current revision as error", () => {
    expect(sql).toContain("loomic_design_preview_mark_error");
    expect(sql).toContain(
      "job_row.status NOT IN ('failed', 'dead_letter', 'canceled')",
    );
    expect(sql).toContain("design_row.revision = frozen_revision");
    expect(sql).toContain("design_row.preview_status = 'queued'");
  });

  it("excludes terminal finalization ledgers and rotates retry candidates", () => {
    expect(sql).toContain("f.status = 'failed'");
    expect(sql).toContain(
      "f.status = 'running' AND f.updated_at < now() - interval '5 minutes'",
    );
    expect(sql).not.toContain(
      "f.status NOT IN ('completed', 'needs_attention')",
    );
    expect(sql).toContain(
      "ORDER BY COALESCE(f.updated_at, j.completed_at, j.updated_at), j.id",
    );
  });

  it("keeps both recovery functions service-only", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.loomic_design_preview_mark_error(uuid, text, text)",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.loomic_design_finalization_candidates(integer)",
    );
    expect(sql).toContain("TO service_role");
  });
});
