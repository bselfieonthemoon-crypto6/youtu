import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../../../supabase/migrations/20260910000005_agent_correction_scope.sql",
  import.meta.url,
);

describe("agent correction target scope migration", () => {
  it("inherits only an unchanged prior scope after fresh resource validation", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("create function public.loomic_agent_target_scope_prepare_correction");
    expect(sql).toContain("where current_run_id=p_correction_of");
    expect(sql).toContain("p_task_revision is distinct from task.revision+1");
    expect(sql.match(/loomic_agent_target_subset\(/g)).toHaveLength(2);
    expect(sql).toContain("scope.task_revision=task.revision");
    expect(sql).toContain("jsonb_agg(scope.target order by scope.target_index)");
    expect(sql).toContain("not private.loomic_agent_target_scope_is_current(task,p_user,candidate)");
    expect(sql).toContain("design.project_id=origin_canvas.project_id");
    expect(sql).toContain("target_canvas.project_id=origin_canvas.project_id");
    expect(sql).toContain("agent_target_scope_forbidden");
  });

  it("keeps the correction preflight server-only and read-only", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("returns jsonb language plpgsql stable security definer");
    expect(sql).not.toMatch(/insert into public\.agent_task_target_scopes/);
    expect(sql).toContain("revoke all on function private.loomic_agent_target_scope_is_current");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("to service_role");
  });
});
