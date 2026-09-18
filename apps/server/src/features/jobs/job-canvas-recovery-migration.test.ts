import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260909000016_recoverable_canvas_image_jobs.sql",
  import.meta.url,
);

describe("recoverable canvas image job migration", () => {
  it("filters target and every live asset before applying the bounded batch limit", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const normalized = sql.replace(/\s+/g, " ").toLowerCase();
    const targetFilter = normalized.indexOf("job.target_kind = 'canvas'");
    const mainAssetFilter = normalized.indexOf("asset.id::text = job.result->>'asset_id'");
    const mainResultFilter = normalized.indexOf("jsonb_typeof(job.result->'object_path') = 'string'");
    const layerAssetFilter = normalized.indexOf("layer_asset.id::text = layer.value->>'asset_id'");
    const layerResultFilter = normalized.indexOf("jsonb_typeof(layer.value->'object_path') is distinct from 'string'");
    const deletionFilter = normalized.indexOf("layer_asset.deletion_pending_at is null");
    const order = normalized.indexOf("order by job.completed_at asc nulls first, job.id asc");
    const limit = normalized.indexOf("limit p_limit", order);

    expect(targetFilter).toBeGreaterThan(-1);
    expect(mainAssetFilter).toBeGreaterThan(targetFilter);
    expect(normalized).toContain("asset.workspace_id = job.workspace_id");
    expect(mainResultFilter).toBeGreaterThan(targetFilter);
    expect(layerAssetFilter).toBeGreaterThan(mainAssetFilter);
    expect(normalized).toContain("layer_asset.workspace_id = job.workspace_id");
    expect(layerResultFilter).toBeGreaterThan(layerAssetFilter);
    expect(deletionFilter).toBeGreaterThan(layerAssetFilter);
    expect(order).toBeGreaterThan(deletionFilter);
    expect(limit).toBeGreaterThan(order);
    expect(normalized).toContain("auth.role() is distinct from 'service_role'");
    expect(normalized).toContain("revoke all on function public.loomic_recoverable_canvas_image_jobs(integer)");
    expect(normalized).toContain("grant execute on function public.loomic_recoverable_canvas_image_jobs(integer) to service_role");
    expect(normalized).toContain("create or replace function public.loomic_recoverable_design_image_chats(");
    const terminalDesignFilter = normalized.indexOf("finalization.status in ('completed', 'needs_attention', 'failed')");
    const designOrder = normalized.indexOf("order by job.completed_at asc nulls first, job.id asc", limit + 1);
    const designLimit = normalized.indexOf("limit p_limit", designOrder);
    expect(terminalDesignFilter).toBeGreaterThan(limit);
    expect(designOrder).toBeGreaterThan(terminalDesignFilter);
    expect(designLimit).toBeGreaterThan(designOrder);
    expect(normalized).toContain("grant execute on function public.loomic_recoverable_design_image_chats(integer) to service_role");
  });
});
