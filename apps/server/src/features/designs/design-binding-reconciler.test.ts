import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createDesignBindingReconciler } from "./design-binding-reconciler.js";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260904000002_design_binding_reconciler.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

describe("design binding reconciler", () => {
  it("CAN-03 calls one service-only atomic reconciliation RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        scanned_canvases: 2,
        attached: 1,
        orphaned: 1,
        rejected: 0,
        deleted_nodes: 0,
        normalized: 1,
        busy: false,
      },
      error: null,
    });
    const reconciler = createDesignBindingReconciler({
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(reconciler.reconcile(25)).resolves.toMatchObject({
      attached: 1,
      orphaned: 1,
    });
    expect(rpc).toHaveBeenCalledWith("loomic_design_binding_reconcile", {
      p_limit: 25,
    });
  });

  it("CAN-04 retires a binding and soft-deletes its design when the node is gone", () => {
    expect(sql).toContain("design-shaped element is an");
    expect(sql).toContain("SET deleted_at = now(), deleted_by = NULL");
    expect(sql).toContain("purge_after = now() + interval '30 days'");
    expect(sql).toContain("'updateType', 'deleted'");
  });

  it("CAN-07 attaches metadata only after same workspace/project and unbound checks", () => {
    expect(sql).toContain("d.workspace_id = canvas_row.workspace_id");
    expect(sql).toContain("d.project_id = canvas_row.project_id");
    expect(sql).toContain("d.deleted_at IS NULL");
    expect(sql).toContain(
      "n.design_id = design_row.id AND n.deleted_at IS NULL",
    );
  });

  it("CAN-08 rejects malicious, duplicate, deleted, and malformed metadata", () => {
    expect(sql).toContain("EXCEPTION WHEN invalid_text_representation");
    expect(sql).toContain("EXCEPTION WHEN unique_violation");
    expect(sql).toContain(
      "element := jsonb_set(element, '{isDeleted}', 'true'::jsonb, true)",
    );
    expect(sql).toContain("rejected_count := rejected_count + 1");
  });

  it("CAN-09 serializes concurrent runs and makes repeat passes idempotent", () => {
    expect(sql).toContain("pg_try_advisory_xact_lock");
    expect(sql).toContain("FOR UPDATE OF c SKIP LOCKED");
    expect(sql).toContain("WHERE public.design_nodes.deleted_at IS NOT NULL");
    expect(sql).toContain("IF canvas_changed THEN");
  });

  it("advances a durable cursor so candidates beyond the batch limit remain reachable", () => {
    expect(sql).toContain("CREATE TABLE public.design_binding_reconcile_state");
    expect(sql).toContain(
      "(c.updated_at, c.id) > (v_cursor_updated_at, v_cursor_canvas_id)",
    );
    expect(sql).toContain("CASE WHEN scanned_count = 0 THEN NULL");
  });

  it("enforces project identity for every authoritative design node binding", () => {
    expect(sql).toContain("private.loomic_validate_design_node_project");
    expect(sql).toContain("design_node_project_mismatch");
    expect(sql).toContain(
      "design_row.project_id IS DISTINCT FROM canvas_row.project_id",
    );
  });

  it("rejects invalid batch sizes before touching the database", async () => {
    const rpc = vi.fn();
    const reconciler = createDesignBindingReconciler({
      getAdminClient: () => ({ rpc }) as never,
    });

    await expect(reconciler.reconcile(0)).rejects.toThrow(
      "design_binding_reconcile_limit_invalid",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});
