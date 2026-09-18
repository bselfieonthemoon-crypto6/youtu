/**
 * Controlled membership-revocation subscription probe.
 * This does not mutate the database. It models a live canvas subscription,
 * then models workspace_members deletion and asks the current connection
 * manager to broadcast. It documents whether the manager rechecks membership.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConnectionManager } from "../src/ws/connection-manager.js";
import { createWorkspaceMemberService } from "../src/features/members/workspace-member-service.js";

const sent: string[] = [];
const socket = { readyState: 1, send(value: string) { sent.push(value); } };
const manager = new ConnectionManager();
const memberConnection = manager.register("member-connection", "member-user", socket as never);
manager.bindCanvas(memberConnection, "shared-canvas");

// Exercise the actual service with controlled DB responses. No real DB delete.
let membershipExists = true;
const memberQuery = { eq() { return this; }, async maybeSingle() { return { data: { role: "member" }, error: null }; } };
const ownerQuery = { eq() { return this; }, async maybeSingle() { return { data: { role: "owner" }, error: null }; } };
const members = createWorkspaceMemberService({
  createUserClient: (() => ({ from: () => ({ select: () => ownerQuery }) })) as never,
  getAdminClient: (() => ({ from: () => ({
    select: () => memberQuery,
    delete: () => ({ eq: () => ({ eq: async () => { membershipExists = false; return { error: null }; } }) }),
  }) })) as never,
});
await members.remove({ id: "owner", accessToken: "controlled", email: "owner@qa.invalid", userMetadata: {} }, "shared-workspace", "member-user");
manager.pushToCanvas("shared-canvas", {
  runId: "controlled-run",
  canvasId: "shared-canvas",
  status: "progress",
  message: "controlled post-revocation event",
} as never);

const checks = [{
  name: "revoked member cannot receive subsequent canvas broadcast",
  passed: sent.length === 0,
  detail: `membershipExists=${membershipExists}; deliveredFrames=${sent.length}`,
}];
console.log(`${checks[0]!.passed ? "PASS" : "FAIL"} ${checks[0]!.name} (${checks[0]!.detail})`);

const reportPath = resolve("../../artifacts/saas-boundary/ws-membership-revocation-controlled.json");
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  kind: "controlled-in-process-membership-revocation-subscription",
  realNetwork: false,
  databaseMutation: false,
  providerRequests: 0,
  applicationDataWrites: 0,
  codePath: {
    removal: "apps/server/src/features/members/workspace-member-service.ts:139-146",
    broadcast: "apps/server/src/ws/connection-manager.ts:153-166",
    finding: "remove deletes workspace_members only; pushToCanvas uses cached canvasIndex without membership recheck",
  },
  checks,
}, null, 2));
console.log(JSON.stringify({ report: reportPath, checks: checks.length, failed: checks.filter((item) => !item.passed).length }));
if (checks.some((item) => !item.passed)) process.exitCode = 1;
