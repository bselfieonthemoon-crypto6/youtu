import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260910000002_agent_confirmation_resume.sql",
  import.meta.url,
);

describe("durable action confirmation migration", () => {
  it("persists frozen scope, fences task revisions and supports idempotent recovery", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create table public.agent_action_confirmations");
    expect(sql).toContain("origin_run_id uuid not null");
    expect(sql).toContain("tool_execution_id uuid not null references public.tool_executions(id)");
    expect(sql).toContain("payload jsonb not null");
    expect(sql).toContain("task.current_run_id is distinct from row_value.origin_run_id");
    expect(sql).toContain("task.revision is distinct from row_value.task_revision");
    expect(sql).toContain("e.id=p_tool_execution");
    expect(sql).toContain("row_value.status='executing' and row_value.claimed_at>=now()-interval '3 minutes'");
    expect(sql).toContain("set status='pending',claim_token=null,claimed_at=null");
    expect(sql).toContain("status='pending' and c.confirmed_at is not null");
    expect(sql).toContain("status='pending' and row_value.confirmed_at is null and row_value.expires_at<=now()");
    expect(sql).toContain("create function public.loomic_list_agent_action_confirmation_recovery");
    expect(sql).toContain("completion_done=true");
    expect(sql).toContain("revoke all on public.agent_action_confirmations");
  });
});
