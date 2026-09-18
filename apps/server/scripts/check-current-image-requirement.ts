/** Local-replica read probe. Does not create a proposal, run, job or image. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createImageProposalStore } from "../src/features/agent-actions/image-proposal-store.js";

async function main() {
  const url = process.env.SUPABASE_URL;
  assert.equal(url, "http://127.0.0.1:54421", "local_replica_required");
  const sessionId = "940093d9-5dda-4479-8366-d6ce698090a9";
  const canvasId = "00725a33-1afc-4b8a-b827-4889173750c7";
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url!, process.env.SUPABASE_SERVICE_ROLE_KEY!, options);
  const auth = createClient(url!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, options);
  const { data: session, error } = await admin.from("chat_sessions").select("created_by,canvas_id")
    .eq("id", sessionId).single();
  assert(!error && session?.canvas_id === canvasId, "fixture_session_unavailable");
  const { data: account } = await admin.auth.admin.getUserById(session.created_by);
  assert(account.user?.email, "fixture_owner_unavailable");
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: account.user.email });
  assert(!linkError && link.properties?.hashed_token, "fixture_login_unavailable");
  const { data: login, error: loginError } = await auth.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  assert(!loginError && login.session, "fixture_login_failed");
  const store = createImageProposalStore(token => createClient(url!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    ...options, global: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const context = { access_token: login.session.access_token, user_id: session.created_by,
    session_id: sessionId, canvas_id: canvasId, run_id: randomUUID() };
  const historical = await store.latest(context);
  const current = await store.latestForCurrentRequirement(context);
  assert.equal(historical?.id, "af4d66be-6c36-46bb-930a-4e0385196989", "fixture_changed_recheck_before_asserting");
  assert.equal(current, null, "old_promo_must_not_resolve_as_landing_proposal");
  console.log(JSON.stringify({ oldPromoExcludedFromCurrentRequirement: true, databaseReads: true,
    proposalsCreated: 0, jobsSubmitted: 0, providerCalls: 0 }));
}
main().catch(() => { console.error("current_requirement_probe_failed_no_secrets_logged"); process.exitCode = 1; });
