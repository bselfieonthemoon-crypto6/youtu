import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../../../../supabase/migrations/20260908000007_agent_design_task_intent.sql", import.meta.url), "utf8");
const body = (name: string) => sql.slice(sql.indexOf(`CREATE FUNCTION ${name}`)).split("END $$;")[0]!;

describe("durable intent transaction boundaries", () => {
  it("serializes correction and final commits on the same task row", () => {
    expect(body("private.loomic_agent_task_lock")).toContain("WHERE id=mapped.task_id FOR UPDATE");
    expect(body("public.loomic_agent_task_begin")).toContain("WHERE session_id=p_session FOR UPDATE");
    expect(body("private.loomic_agent_task_guard_design_version")).toContain("private.loomic_agent_task_lock(origin)");
    expect(body("private.loomic_agent_task_guard_canvas_content")).toContain("private.loomic_agent_task_lock(origin)");
    expect(sql).toContain("BEFORE INSERT ON public.design_document_versions");
    expect(sql).toContain("BEFORE UPDATE OF content ON public.canvases");
  });
  it("authorizes task owner, active workspace membership and canvas-bound design", () => {
    const begin = body("public.loomic_agent_task_begin");
    expect(begin).toContain("s.created_by=p_user AND s.canvas_id=p_canvas FOR UPDATE");
    expect(begin).toContain("m.workspace_id=canvas.workspace_id AND m.user_id=p_user");
    expect(begin).toContain("d.workspace_id=canvas.workspace_id AND d.deleted_at IS NULL");
    expect(begin).toContain("n.design_id=d.id AND n.canvas_id=p_canvas");
    expect(begin).toContain("task.current_run_id<>p_correction_of");
  });
  it("tracks only explicit task runs and freezes job attribution at insertion", () => {
    expect(body("private.loomic_agent_task_lock")).toContain("IF mapped.run_id IS NULL THEN RETURN NULL");
    const bind = body("private.loomic_agent_task_bind_job");
    expect(bind).toContain("SELECT origin_run_id INTO origin FROM public.image_generation_proposals WHERE id=NEW.id");
    expect(bind).toContain("NEW.payload->>'origin_run_id'");
    expect(bind).toContain("agent_task_job_immutable");
    expect(bind).toContain("INSERT INTO public.agent_design_task_jobs");
  });
  it("rejects unrelated design objects and canvas destinations in commit transactions", () => {
    const design = body("private.loomic_agent_task_guard_design_version");
    expect(design).toContain("unnest(NEW.changed_object_ids)");
    expect(design).toContain("('scene.replace','canvas.update')");
    expect(design).toContain("f.command_id=NEW.idempotency_key AND f.target_id=NEW.design_id");
    expect(body("private.loomic_agent_task_guard_canvas_content")).toContain("task.canvas_id IS DISTINCT FROM NEW.id");
  });
  it("keeps intent tables and entry points inaccessible to direct authenticated writes", () => {
    for (const table of ["agent_design_tasks", "agent_design_task_runs", "agent_design_task_jobs"]) {
      expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("TO service_role");
  });
});
