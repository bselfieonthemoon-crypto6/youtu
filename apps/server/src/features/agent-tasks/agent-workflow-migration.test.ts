import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260909000018_agent_workflow_cas.sql",
  import.meta.url,
);

describe("agent workflow CAS migration", () => {
  it("preserves server workflow metadata and compares both task and workflow revisions", async () => {
    const normalized = (await readFile(migrationUrl, "utf8"))
      .replace(/\s+/g, " ")
      .toLowerCase();
    expect(normalized).toContain("create or replace function public.loomic_agent_task_update_brief");
    expect(normalized).toContain("(p_brief - 'agentworkflow')");
    expect(normalized).toContain("preserved_workflow := task.brief->'agentworkflow'");
    expect(normalized).toContain("create or replace function public.loomic_agent_task_update_workflow");
    expect(normalized).toContain("task.revision is distinct from p_task_revision");
    expect(normalized).toContain("current_revision is distinct from p_expected_workflow_revision");
    expect(normalized).toContain("task.current_run_id::text");
    expect(normalized).toContain("grant execute on function public.loomic_agent_task_update_workflow");
    expect(normalized).toContain("to service_role");
  });
});
