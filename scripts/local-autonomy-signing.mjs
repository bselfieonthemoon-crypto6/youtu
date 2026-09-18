import { execFileSync } from 'node:child_process';

// Opt-in bootstrap for the fixed local development replica only. Secrets stay
// in process memory, are never printed, and are never copied to task records.
if ((process.env.LOOMIC_LOCAL_AUTONOMY_SIGNING === 'true' || process.env.LOOMIC_AGENT_AUTONOMY_TEST_DEFAULT === 'true') && !process.env.LOOMIC_AGENT_AUTONOMY_SIGNING_KEY) {
  const api = new URL(process.env.SUPABASE_URL ?? 'https://invalid.invalid');
  const db = new URL(process.env.SUPABASE_DB_URL ?? 'postgres://invalid.invalid/invalid');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) || db.pathname !== '/loomic_replica_light_20260907')
    throw new Error('Local autonomy signing bootstrap refuses non-local replica');
  const raw = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', 'loomic_replica_auth'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = JSON.parse(raw);
  const key = entries.find(value => typeof value === 'string' && value.startsWith('GOTRUE_JWT_SECRET='))?.slice('GOTRUE_JWT_SECRET='.length);
  if (!key || key.length < 32) throw new Error('Local auth signing configuration unavailable');
  // Do not replace the browser's asymmetric/remote verification configuration.
  process.env.LOOMIC_AGENT_AUTONOMY_SIGNING_KEY = key;
}
