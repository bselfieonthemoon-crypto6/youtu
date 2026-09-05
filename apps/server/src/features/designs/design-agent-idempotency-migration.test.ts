import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260906000003_stage6_idempotency_and_workspace_boundary.sql",
  import.meta.url,
);
const billingMigrationUrl = new URL(
  "../../../../../supabase/migrations/20260906000004_idempotent_generation_billing_result.sql",
  import.meta.url,
);

describe("Stage 6 semantic idempotency migration", () => {
  it("atomically keys design image jobs and Agent mutation semantics", async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
    expect(sql).toContain("background_jobs_design_image_idempotency_key");
    expect(sql).toContain("PRIMARY KEY (design_id, idempotency_key)");
    expect(sql).toContain("agent_design_idempotency_conflict");
    expect(sql).toContain("loomic_agent_design_mutate_v2");
  });

  it("keeps workspace filtering in the cursor query and refund ownership explicit", async () => {
    const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
    const billingSql = await readFile(
      fileURLToPath(billingMigrationUrl),
      "utf8",
    );
    expect(sql).toContain(
      "r.scope='platform' OR r.workspace_id=p_active_workspace_id",
    );
    expect(billingSql).toContain("'charged_new',false");
    expect(billingSql).toContain("'charged_new',true");
  });
});
