import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local replica only');
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY!, opts);
const designId = '4e9585ba-2f23-41d6-86aa-4fe01436511d';
const { data: account } = await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: account.user!.email! });
if (error) throw error;
const login = await auth.auth.verifyOtp({ type: 'magiclink', token_hash: link!.properties.hashed_token });
if (login.error) throw login.error;
try {
  const headers = { Authorization: `Bearer ${login.data.session!.access_token}`, 'Content-Type': 'application/json' };
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:3002/api/designs/${designId}`, { headers });
    if (!response.ok) throw Error(`Design read failed: ${response.status}`);
    return ((await response.json()) as any).design;
  };
  const before = await read();
  console.log('BEFORE', JSON.stringify({ revision: before.revision, previewRevision: before.preview_revision, status: before.preview_status }));
  const response = await fetch(`http://127.0.0.1:3002/api/designs/${designId}/preview`, { method: 'POST', headers, body: JSON.stringify({ design_id: designId, expected_revision: before.revision, idempotency_key: randomUUID() }) });
  if (!response.ok) throw Error(`Preview enqueue failed: ${response.status}`);
  console.log('QUEUED', JSON.stringify(await response.json()));
  for (let n = 0; n < 90; n++) {
    const after = await read();
    if (after.preview_status === 'ready' && after.preview_revision === after.revision) {
      if (before.revision !== after.revision || JSON.stringify(before.scene) !== JSON.stringify(after.scene)) throw Error('Design changed concurrently; review before declaring unchanged');
      console.log('PASS', JSON.stringify({ revision: after.revision, previewRevision: after.preview_revision, status: after.preview_status, sceneUnchanged: true }));
      break;
    }
    if (n === 89) throw Error(`Preview not ready: ${after.preview_status}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await auth.auth.signOut({ scope: 'local' }); }
