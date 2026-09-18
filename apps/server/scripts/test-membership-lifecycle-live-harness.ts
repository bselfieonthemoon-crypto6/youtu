/**
 * Isolated service/protocol orchestration for membership revocation.
 * Uses the real WorkspaceMemberService, member HTTP routes, WS handler and
 * ConnectionManager with an in-memory DB double. No external DB, QA workspace,
 * provider, worker, or original user canvas is touched.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createAgentRunService } from "../src/agent/runtime.js";
import type { ServerEnv } from "../src/config/env.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../src/supabase/user.js";
import { createWorkspaceMemberService } from "../src/features/members/workspace-member-service.js";
import { registerWorkspaceMemberRoutes } from "../src/http/workspace-members.js";
import { ConnectionManager } from "../src/ws/connection-manager.js";
import { registerWsRoute } from "../src/ws/handler.js";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const memberId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const canvasId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const rows = new Map<string, { role: "owner" | "member"; created_at: string }>([
  [ownerId, { role: "owner", created_at: "2026-01-01T00:00:00Z" }],
  [memberId, { role: "member", created_at: "2026-01-02T00:00:00Z" }],
]);

function query(table: string) {
  const state: { workspace?: string; user?: string } = {};
  const chain: Record<string, any> = {
    select: () => chain,
    eq: (column: string, value: string) => { if (column === "workspace_id") state.workspace = value; if (column === "user_id") state.user = value; return chain; },
    order: async () => ({ data: [], error: null }),
    maybeSingle: async () => {
      if (table !== "workspace_members" || state.workspace !== workspaceId || !state.user) return { data: null, error: null };
      const row = rows.get(state.user);
      return { data: row ? { role: row.role } : null, error: null };
    },
    delete: () => chain,
  };
  chain.delete = () => ({
    eq: (_column: string, value: string) => ({
      eq: async (_column2: string, value2: string) => {
        if (table === "workspace_members" && value === workspaceId) rows.delete(value2);
        return { error: null };
      },
    }),
  });
  return chain;
}

const adminClient = { from: (table: string) => query(table) } as never;
const memberService = createWorkspaceMemberService({
  createUserClient: () => ({ from: (table: string) => query(table) } as never),
  getAdminClient: () => adminClient,
  onMembershipInvalidated: ({ workspaceId, userId }) => manager.revokeWorkspaceUser(workspaceId, userId),
});

const users: Record<string, AuthenticatedUser> = {
  "owner-token": { accessToken: "owner-token", email: "owner@example.test", id: ownerId, userMetadata: {} },
  "member-token": { accessToken: "member-token", email: "member@example.test", id: memberId, userMetadata: {} },
};
const auth: RequestAuthenticator = {
  async authenticate(request) {
    const raw = request.headers.authorization;
    const token = raw?.startsWith("Bearer ") ? raw.slice(7) : undefined;
    return token ? users[token] ?? null : null;
  },
};
const viewerService = { async ensureViewer(user: AuthenticatedUser) { return { workspace: { id: workspaceId }, user }; } } as never;
const canvasService = {
  async getCanvasWorkspaceId(user: AuthenticatedUser, requestedCanvasId: string) {
    if (requestedCanvasId !== canvasId || !rows.has(user.id)) throw new Error("not found");
    return workspaceId;
  },
  async getCanvas(user: AuthenticatedUser, requestedCanvasId: string) {
    if (requestedCanvasId !== canvasId || !rows.has(user.id)) throw new Error("not found");
    return { id: canvasId };
  },
} as never;
const env: ServerEnv = { agentModel: "test-model", port: 3002, version: "test", webOrigin: "http://localhost:3002" };
const manager = new ConnectionManager({ authorizeCanvas: async ({ userId, canvasId: requested }) => requested === canvasId && rows.has(userId) });
const app = Fastify();
await app.register(websocket);
await registerWorkspaceMemberRoutes(app, { auth, memberService, viewerService });
await registerWsRoute(app, {
  agentRuns: createAgentRunService({ env }), auth, canvasService, connectionManager: manager,
});
await app.ready();

const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
const check = (name: string, passed: boolean, detail?: string) => {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sockets: any[] = [];
function waitMessage(socket: any, predicate: (message: Record<string, unknown>) => boolean, timeout = 2000) {
  return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), timeout);
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off("message", listener); resolveMessage(message);
    };
    socket.on("message", listener);
  });
}

const memberSocket = await app.injectWS("/api/ws?token=member-token&connectionId=member-before-revoke");
sockets.push(memberSocket);
const beforeAck = waitMessage(memberSocket, (message) => message.type === "command.ack" && message.action === "canvas.resume");
memberSocket.send(JSON.stringify({ type: "command", action: "canvas.resume", payload: { canvasId, lastSeq: 0 } }));
await beforeAck;
check("member can subscribe before removal", true);

const removeResponse = await app.inject({ method: "DELETE", url: `/api/workspace/members/${memberId}`, headers: { authorization: "Bearer owner-token" } });
check("real member remove route returns 204", removeResponse.statusCode === 204, `status=${removeResponse.statusCode}`);
check("in-memory membership row is deleted", !rows.has(memberId));

const newMemberSocket = await app.injectWS("/api/ws?token=member-token&connectionId=member-after-revoke");
sockets.push(newMemberSocket);
const afterError = waitMessage(newMemberSocket, (message) => message.type === "error");
newMemberSocket.send(JSON.stringify({ type: "command", action: "canvas.resume", payload: { canvasId, lastSeq: 0 } }));
const denied = await afterError;
check("new subscription is denied after removal", denied.message === "Canvas not found or access denied", String(denied.message));

const oldEvent = waitMessage(memberSocket, (message) => message.type === "event", 400).then(() => true).catch(() => false);
await manager.pushToCanvas(canvasId, { type: "canvas.sync", runId: "controlled-run", timestamp: new Date().toISOString() });
const oldReceived = await oldEvent;
check("old subscription is revoked from future broadcasts", !oldReceived, oldReceived ? "old socket received post-removal event" : undefined);

for (const socket of sockets) socket.close();
await app.close();
const reportPath = resolve("../../artifacts/saas-boundary/ws-membership-lifecycle-harness-retest.json");
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  kind: "isolated-fastify-real-member-service-real-ws-handler",
  realDatabase: false,
  realApiProtocol: false,
  realMemberService: true,
  realWsHandler: true,
  realConnectionManager: true,
  providerRequests: 0,
  applicationDataWrites: 0,
  credentialsPrinted: false,
  checks,
}, null, 2));
console.log(JSON.stringify({ report: reportPath, checks: checks.length, failed: checks.filter((item) => !item.passed).length }));
if (checks.some((item) => !item.passed)) process.exitCode = 1;
