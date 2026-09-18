-- Read-only transaction boundary for run-mastra-image-authorization-parity.mjs.
-- The runner supplies shared TypeScript cases as query parameters, so this file
-- deliberately contains no duplicated authorization vectors or TS patterns.
-- Run it only against a database with migration 20260915000006 applied.
BEGIN READ ONLY;
ROLLBACK;
