import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../../../supabase/migrations/20260906000001_agent_design_tool_audit.sql",
    import.meta.url,
  ),
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string, nextMarker: string) {
  return sql.slice(
    sql.indexOf(name),
    sql.indexOf(nextMarker, sql.indexOf(name)),
  );
}

describe("Stage 6 agent design tool audit migration", () => {
  it("keeps the execution ledger private and tool-execution idempotent", () => {
    expect(sql).toContain("CREATE TABLE public.design_agent_tool_requests");
    expect(sql).toContain("tool_execution_id uuid PRIMARY KEY");
    expect(sql).toContain(
      "REFERENCES public.tool_executions(id) ON DELETE RESTRICT",
    );
    expect(sql).toContain(
      "ALTER TABLE public.design_agent_tool_requests ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "ALTER TABLE public.design_agent_tool_requests FORCE ROW LEVEL SECURITY",
    );
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("design_document_versions_tool_execution_key");
  });

  it("binds every agent version to its run, tool, actor, workspace and request", () => {
    const validator = functionBody(
      "CREATE OR REPLACE FUNCTION private.loomic_validate_agent_design_version",
      "DROP TRIGGER IF EXISTS design_document_versions_validate_agent",
    );
    expect(validator).toContain("NEW.actor_kind = 'agent'");
    expect(validator).toContain("agent_design_audit_required");
    expect(validator).toContain(
      "request.tool_execution_id = NEW.tool_execution_id",
    );
    expect(validator).toContain("request.agent_run_id = NEW.agent_run_id");
    expect(validator).toContain("request.actor_user_id = NEW.actor_user_id");
    expect(validator).toContain("request.design_id = NEW.design_id");
    expect(validator).toContain(
      "request.idempotency_key = NEW.idempotency_key",
    );
    expect(validator).toContain("agent_design_workspace_mismatch");
    expect(validator).toContain("non_agent_design_audit_invalid");
  });

  it("validates the authoritative live run and tool execution context", () => {
    const context = functionBody(
      "CREATE OR REPLACE FUNCTION private.loomic_agent_design_context_workspace",
      "REVOKE ALL ON FUNCTION private.loomic_agent_design_context_workspace",
    );
    expect(context).toContain("execution.run_id = p_agent_run_id");
    expect(context).toContain("execution.requested_by = p_actor_user_id");
    expect(context).toContain("execution.tool_name = p_tool_name");
    expect(context).toContain(
      "OR (p_allow_completed AND execution.status = 'completed')",
    );
    expect(context).toContain("run.created_by = p_actor_user_id");
    expect(context).toContain(
      "OR (p_allow_completed AND run.status = 'completed')",
    );
    expect(context).toContain(
      "JOIN public.canvases c ON c.id = session.canvas_id",
    );
  });

  it("uses the canonical mutator after confirmation, CAS and template checks", () => {
    const mutate = functionBody(
      "CREATE OR REPLACE FUNCTION public.loomic_agent_design_mutate",
      "REVOKE ALL ON FUNCTION public.loomic_agent_design_mutate",
    );
    expect(mutate).toContain("agent_design_confirmation_required");
    expect(mutate).toContain("agent_design_confirmation_invalid");
    expect(mutate).toContain("p_expected_revision");
    expect(mutate).toContain("design_template_revision_conflict");
    expect(mutate).toContain("agent_design_template_scene_mismatch");
    expect(mutate).toContain("agent_design_workspace_mismatch");
    expect(mutate).toContain("agent_design_idempotency_conflict");
    expect(mutate.indexOf("RETURN jsonb_set(request_row.result")).toBeLessThan(
      mutate.indexOf("private.loomic_agent_design_context_workspace"),
    );
    expect(mutate).toContain("public.loomic_design_mutate(");
    expect(mutate).toContain("'agent'");
    expect(mutate).toContain("p_agent_run_id");
    expect(mutate).toContain("p_tool_execution_id");
    expect(mutate).not.toContain("INSERT INTO public.design_documents");
    expect(mutate).not.toContain("INSERT INTO public.design_event_outbox");
  });

  it("exposes only the service-role mutation entry point", () => {
    expect(sql).toContain(
      "FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION public.loomic_agent_design_mutate",
    );
    expect(sql).toContain(") TO service_role;");
  });
});
