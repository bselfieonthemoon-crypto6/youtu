import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260909000017_agent_task_continuations.sql",
  import.meta.url,
);

describe("agent continuation migration", () => {
  it("binds the server continuation run before insert and preserves only that run", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("continuation_run_id uuid");
    expect(sql).toContain("create unique index agent_task_continuations_run_id");
    expect(sql).toContain("create function public.loomic_bind_agent_continuation_run");
    expect(sql).toContain("where e.job_id=p_job and e.created_by=p_user for update of t");
    expect(sql).toContain("event.status<>'running' or event.claim_token is distinct from p_token");
    expect(sql).toContain("task.current_run_id is distinct from event.origin_run_id");
    expect(sql).toContain("create trigger supersede_continuations_on_new_run before insert on public.agent_runs");
    expect(sql).toContain("where session_id=new.session_id and created_by=new.created_by for update");
    expect(sql).toContain("and continuation_run_id is distinct from new.id");
  });

  it("makes stop terminal for queued and in-flight checks without exposing leases to browsers", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("new.status not in ('succeeded','failed','canceled','dead_letter')");
    expect(sql).toContain("status in ('pending','running')");
    expect(sql).toContain("outcome='{\"reason\":\"review_stopped\"");
    expect(sql).toContain("revoke all on function public.loomic_agent_continuation_active");
    expect(sql).toContain("public.loomic_bind_agent_continuation_run(uuid,uuid,uuid,uuid)");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("to service_role");
  });
});
