import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../supabase/migrations/20260911000013_durable_realtime_fanout.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("durable realtime fanout migration", () => {
  it("serializes append and cursor registration under the same transaction lock", () => {
    expect(migration.match(/pg_advisory_xact_lock\(589855969625973\)/g)).toHaveLength(2);
    expect(migration).toContain("ORDER BY e.id");
    expect(migration).toContain("SET last_event_id = p_event_id");
  });

  it("captures design and membership mutations without an unreliable notify-only path", () => {
    expect(migration).toContain("AFTER INSERT ON public.design_event_outbox");
    expect(migration).toContain("AFTER DELETE ON public.workspace_members");
    expect(migration).toContain("AFTER UPDATE OF role ON public.workspace_members");
    expect(migration).not.toMatch(/pg_notify|NOTIFY\s/i);
  });

  it("keeps internal tables and authorization RPC service-role only", () => {
    expect(migration).toContain("ALTER TABLE public.realtime_event_log ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("loomic_realtime_canvas_authorized");
    expect(migration).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(migration).toContain("JOIN public.workspace_members m ON m.workspace_id = p.workspace_id");
    expect(migration).toContain("SET search_path = ''");
  });
});
