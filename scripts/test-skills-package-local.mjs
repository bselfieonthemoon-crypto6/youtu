/** Fixed local replica only. No credentials, paid API, persistent fixtures or migration application. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const replacements = Object.fromEntries(["OWNER", "MEMBER", "OUTSIDER", "WORKSPACE", "OUTSIDE_WORKSPACE", "NONCE"].map(key => [key, randomUUID()]));
const sql = readFileSync(new URL("./test-skills-package-local.sql", import.meta.url), "utf8")
  .replace(/__([A-Z_]+)__/g, (_match, key) => {
    if (!replacements[key]) throw new Error("Unexpected QA placeholder");
    return replacements[key];
  });
const result = spawnSync("docker", ["exec", "-i", "supabase_db_thtdhcvjppuvlvahfmga", "psql", "-X", "-qAt",
  "-U", "supabase_admin", "-d", "loomic_replica_light_20260907"], { input: sql, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.error?.message || "Local skill QA failed.\n");
  process.exitCode = 1;
} else {
  for (const line of result.stdout.split(/\r?\n/).filter(line => line.startsWith("{"))) process.stdout.write(line + "\n");
}
