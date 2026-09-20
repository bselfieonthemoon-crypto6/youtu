import { bootstrap } from "global-agent";

// Enable HTTP proxy for all outbound requests if http_proxy / https_proxy is set
bootstrap();

// Native fetch() proxy — needed for @google/generative-ai SDK
if (process.env.GLOBAL_AGENT_HTTP_PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(process.env.GLOBAL_AGENT_HTTP_PROXY));
}

import { buildApp } from "./app.js";
import { loadServerEnv } from "./config/env.js";
import { createAdminSupabaseClient } from "./supabase/admin.js";
import { warnIfNoPlatformAdmin } from "./features/admin/platform-admin-bootstrap.js";

const env = loadServerEnv();
const app = buildApp({
  env,
});

const host = process.env.HOST ?? "127.0.0.1";

try {
  await app.listen({
    host,
    port: env.port,
  });

  console.log(`@loomic/server listening on http://${host}:${env.port}`);

  // A fresh install has no platform admin, which means nobody can open the
  // operations console at all. Say so loudly at boot (and how to fix it) instead
  // of leaving it to be discovered when someone tries to log in to /admin.
  await warnIfNoPlatformAdmin(createAdminSupabaseClient(env), app.log);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
