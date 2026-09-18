import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260911000003_agent_continuation_commit_fence.sql",
  import.meta.url,
);

describe("agent continuation metadata commit fence", () => {
  it.each([
    "loomic_agent_continuation_update_brief",
    "loomic_agent_continuation_update_workflow",
  ])("locks the task then continuation and rejects a stopped claim in %s", async functionName => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    const start = sql.indexOf(`create function public.${functionName}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf("end; $$;", start));
    expect(body.indexOf("for update of t")).toBeLessThan(body.indexOf("for update;"));
    expect(body).toContain("event.status <> 'running'");
    expect(body).toContain("event.claim_token is distinct from p_token");
    expect(body).toContain("task.current_run_id is distinct from event.origin_run_id");
    expect(body).toContain("task.revision is distinct from event.task_revision");
    expect(body).toContain("run.status in ('canceled', 'failed')");
  });

  it("keeps both metadata writers server-only", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("revoke all on function public.loomic_agent_continuation_update_brief");
    expect(sql).toContain("public.loomic_agent_continuation_update_workflow");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
