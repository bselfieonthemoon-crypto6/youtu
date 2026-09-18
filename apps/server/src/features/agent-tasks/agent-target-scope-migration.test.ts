import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260910000003_agent_target_scope.sql",
  import.meta.url,
);

describe("agent target scope migration", () => {
  it("freezes authenticated targets to current task identity and revision", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create table public.agent_task_target_scopes");
    expect(sql).toContain("primary key(task_id,task_revision,target_index)");
    expect(sql).toContain("task:=private.loomic_agent_task_lock(p_run)");
    expect(sql).toContain("task.created_by is distinct from p_user");
    expect(sql).toContain("task.session_id is distinct from p_session");
    expect(sql).toContain("task.revision is distinct from p_task_revision");
    expect(sql).toContain("agent_target_scope_conflict");
    expect(sql).toContain("agent_target_scope_primary_missing");
    expect(sql).toContain("design.workspace_id=origin_canvas.workspace_id and design.project_id=origin_canvas.project_id");
    expect(sql).toContain("target_canvas.project_id=origin_canvas.project_id");
  });

  it("enforces target subsets again at durable image and native design write boundaries", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create or replace function private.loomic_agent_task_bind_job");
    expect(sql).toContain("create or replace function private.loomic_agent_task_guard_design_version");
    expect(sql).toContain("create or replace function private.loomic_record_agent_continuation");
    expect(sql).toContain("create or replace function public.loomic_create_agent_action_confirmation");
    expect(sql).toContain("create or replace function public.loomic_claim_agent_action_confirmation");
    expect(sql.match(/private\.loomic_agent_task_target_authorized\(task,candidate\)/g)).toHaveLength(6);
    expect(sql).toContain("command->>'action' in ('scene.replace','canvas.update')");
    expect(sql).toContain("not scene_wide and cardinality(new.changed_object_ids)>0");
    expect(sql).toContain("revoke all on function public.loomic_agent_target_scope_activate");
    expect(sql).toContain("public.loomic_agent_target_scope_assert(uuid,uuid,uuid,bigint,jsonb)");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("to service_role");
  });
});
