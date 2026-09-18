// Non-billable connection/discovery regression against the existing local QA provider.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const auth = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
const account = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
assert(account.data.user?.email);
const link = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.data.user.email });
assert(!link.error);
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
assert(login.data.session && !login.error);
const base = 'http://127.0.0.1:3002/api/workspace/provider-configs/95e5b26e-b906-4dce-8745-ad0c1638b6f6';
const authHeaders = { Authorization: `Bearer ${login.data.session.access_token}` };
const listUrl = 'http://127.0.0.1:3002/api/workspace/provider-configs';
const before = await (await fetch(listUrl, { headers: authHeaders })).json();
const draft = await fetch(`${listUrl}/discover-models`, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'https://api.apiyi.com/v1', configId: '95e5b26e-b906-4dce-8745-ad0c1638b6f6' }), signal: AbortSignal.timeout(30000) });
assert.equal(draft.status, 200, 'draft discovery failed');
const draftModels = await draft.json();
const after = await (await fetch(listUrl, { headers: authHeaders })).json();
assert.deepEqual(after, before, 'draft discovery changed persisted config or connection status');
console.log(`PASS live draft discovery ${draftModels.models.length} models; stored config and status unchanged`);
for (const endpoint of ['test', 'discover-models']) {
  const response = await fetch(`${base}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${login.data.session.access_token}` }, signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  assert.equal(response.status, 200, `${endpoint} status ${response.status}, code ${result.error?.code ?? result.code ?? 'unknown'}`);
  console.log(`PASS existing provider ${endpoint}: HTTP 200${Array.isArray(result.models) ? `, ${result.models.length} models` : ''}`);
}
