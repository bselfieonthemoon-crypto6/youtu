import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL(
  "../../../../../supabase/migrations/20260901000004_provider_execution_snapshots.sql",
  import.meta.url,
));
const sql = readFileSync(migrationPath, "utf8");

describe("provider execution snapshot migration security invariants", () => {
  it("keeps Vault ids outside the immutable snapshot table and denies clients", () => {
    const snapshotTable = sql.slice(
      sql.indexOf("CREATE TABLE public.provider_execution_snapshots"),
      sql.indexOf("CREATE TABLE public.provider_execution_credentials"),
    );
    expect(snapshotTable).not.toContain("api_key_secret_id");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  });

  it("requires a verified config and enforces target modality", () => {
    expect(sql).toContain("config_row.last_test_status <> 'succeeded'");
    expect(sql).toContain("model_row.capabilities ? 'image_generation'");
    expect(sql).toContain("model_row.capabilities ? 'video_generation'");
    expect(sql).toContain("model_row.capabilities ? 'text'");
    expect(sql).toContain("JOIN public.projects p ON p.id = c.project_id");
    expect(sql).toContain("SELECT p.workspace_id INTO target_workspace_id");
  });

  it("retains retry credentials and cleans every terminal path", () => {
    expect(sql).toContain("status::text = 'failed' AND attempt_count < max_attempts");
    expect(sql).toContain("NEW.status::text = 'failed' AND NEW.attempt_count >= NEW.max_attempts");
    expect(sql).toContain("NEW.status IN ('completed', 'failed', 'canceled')");
    expect(sql).toContain("provider_execution_credentials_cleanup_secret");
  });

  it("preserves catalog keys across model metadata updates", () => {
    expect(sql).toContain("ADD COLUMN catalog_key uuid NOT NULL DEFAULT gen_random_uuid()");
    expect(sql).toContain("ON CONFLICT (provider_config_id, upstream_model_id, modality) DO UPDATE SET");
  });
});
