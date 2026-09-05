# Stage 3 browser acceptance

This suite uses the real Loomic web app, Fastify API, Supabase authentication,
database, and persistence paths. It does not intercept or mock production API
requests.

## Local run

1. Start the local Supabase stack and apply migrations.
2. Seed or create a disposable test account.
3. Set its credentials in the shell (do not commit them):

   ```powershell
   $env:LOOMIC_E2E_EMAIL = "e2e-user@example.test"
   $env:LOOMIC_E2E_PASSWORD = "..."
   pnpm --filter @loomic/web test:e2e:stage3
   ```

The Playwright config reads the existing repository `.env.local` and starts the
API and web dev servers. Set `LOOMIC_E2E_EXTERNAL_STACK=true` when those servers
are already managed elsewhere. `LOOMIC_E2E_BASE_URL` and
`LOOMIC_E2E_SERVER_URL` can point the test at another disposable environment.

The test creates a temporary project through the real UI and deletes it through
the authenticated project API in cleanup. It validates background mutation
persistence, blocks raw Canvas copy/paste, exercises the supported “复制设计”
action, reloads both distinct Design identities, and performs 20 editor
open/close resource-lifecycle cycles. The browser project explicitly uses the
locally installed Google Chrome channel.
