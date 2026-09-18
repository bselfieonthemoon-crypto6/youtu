/** Local production acceptance/cancel probe. Does not consume an Agent stream. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const url = process.env.SUPABASE_URL;
  assert.equal(url, "http://127.0.0.1:54421");
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url!, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const auth = createClient(url!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);
  const { data: source, error } = await admin.from("canvases").select("project_id,created_by")
    .eq("id", "00725a33-1afc-4b8a-b827-4889173750c7").single();
  assert(!error && source);
  const { data: account } = await admin.auth.admin.getUserById(source.created_by);
  assert(account.user?.email);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: account.user.email });
  assert(link.properties?.hashed_token);
  const { data: login } = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  assert(login.session);
  const headers = { Authorization: `Bearer ${login.session.access_token}`, "Content-Type": "application/json" };
  const canvasId = randomUUID(), sessionId = randomUUID();
  let created = false, runId: string | undefined;
  try {
    const inserted = await admin.from("canvases").insert({ id: canvasId, project_id: source.project_id,
      created_by: source.created_by, name: "Isolated HTTP request QA", is_primary: false,
      content: { elements: [], files: {}, appState: {} } });
    assert(!inserted.error, "qa_canvas_creation_failed"); created = true;
    const session = await admin.from("chat_sessions").insert({ id: sessionId, canvas_id: canvasId,
      created_by: source.created_by, title: "HTTP request QA", thread_id: `qa-http:${sessionId}` });
    assert(!session.error, "qa_session_creation_failed");
    const prompt = "Isolated request binding probe. Do not generate images or execute tools.";
    const response = await fetch("http://127.0.0.1:3002/api/agent/runs", { method: "POST", headers,
      body: JSON.stringify({ sessionId, canvasId, conversationId: canvasId, prompt, executionMode: "thinking" }) });
    const result = await response.json() as { runId?: string };
    assert.equal(response.status, 202, "production_request_acceptance_failed");
    runId = result.runId; assert(runId);
    const { data: run } = await admin.from("agent_runs").select("request_message_id,request_prompt,status").eq("id", runId).single();
    assert(run?.request_message_id && run.request_prompt === prompt && run.status === "accepted");
    const { data: message } = await admin.from("chat_messages").select("session_id,role,content").eq("id", run.request_message_id).single();
    assert(message?.session_id === sessionId && message.role === "user" && message.content === prompt);
    const stopped = await fetch(`http://127.0.0.1:3002/api/agent/runs/${runId}/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(stopped.status, 202);
    const { data: canceled } = await admin.from("agent_runs").select("status").eq("id", runId).single();
    assert.equal(canceled?.status, "canceled");
    const { count: jobs } = await admin.from("background_jobs").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
    assert.equal(jobs, 0);
    console.log(JSON.stringify({ productionHttp: true, exactRequestBinding: true, stoppedBeforeExecution: true, jobs: 0, agentStreamConsumed: false }));
  } finally {
    if (runId) await fetch(`http://127.0.0.1:3002/api/agent/runs/${runId}/cancel`, { method: "POST", headers, body: "{}" });
    if (created) {
      const removed = await admin.from("canvases").delete().eq("id", canvasId).eq("created_by", source.created_by);
      assert(!removed.error, "qa_canvas_cleanup_failed");
      console.log("Removed only the disposable HTTP QA canvas and its session.");
    }
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "request_binding_http_probe_failed"); process.exitCode = 1; });
