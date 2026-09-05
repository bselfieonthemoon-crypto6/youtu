import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(fileURLToPath(new URL(
  "../../../../../supabase/migrations/20260901000006_private_assets_and_safe_gc.sql",
  import.meta.url,
)), "utf8");

describe("private storage and safe GC migration", () => {
  it("makes media buckets private and removes public screenshot reads", () => {
    expect(sql).toContain("VALUES ('workspace-assets', 'workspace-assets', false)");
    expect(sql).toContain("WHERE id = 'canvases'");
    expect(sql).not.toContain("WHERE id IN ('project-assets', 'canvases')");
    expect(sql).toContain('DROP POLICY IF EXISTS "canvases_select_public"');
    expect(sql).toContain("private.is_workspace_member");
  });

  it("tracks references and claims only assets with no remaining references", () => {
    expect(sql).toContain("CREATE TABLE public.asset_references");
    expect(sql).toContain("deletion_pending_at timestamptz");
    expect(sql).toMatch(
      /NOT EXISTS\s*\(\s*SELECT 1 FROM public\.asset_references(?:\s+\w+)? WHERE (?:\w+\.)?asset_id = (?:\w+\.)?(?:p_asset_id|id)\s*\)/,
    );
    expect(sql).toContain("loomic_orphan_asset_finalize");
  });

  it("backfills asset ids into existing generated canvas elements", () => {
    expect(sql).toContain("'{customData,assetId}'");
    expect(sql).toContain("INSERT INTO public.asset_references");
  });
});
