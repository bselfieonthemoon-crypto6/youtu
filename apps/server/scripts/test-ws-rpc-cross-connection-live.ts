/**
 * Controlled in-process regression probe for RPC response ownership.
 * No server/provider/database call is made: two fake WebSocket connections are
 * registered in ConnectionManager and the second connection answers an RPC
 * issued to the first. The probe records whether connectionId is enforced.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConnectionManager } from "../src/ws/connection-manager.js";

type FakeSocket = { readyState: number; sent: string[]; send: (value: string) => void };
const socket = (): FakeSocket => {
  const result: FakeSocket = { readyState: 1, sent: [], send(value) { result.sent.push(value); } };
  return result;
};

const manager = new ConnectionManager();
const socketA = socket();
const socketB = socket();
const connectionA = manager.register("rpc-A", "user-A", socketA as never);
const connectionB = manager.register("rpc-B", "user-B", socketB as never);

const pending = manager.rpc<{ owner: string }>(connectionA, "qa.rpc.boundary", { fixture: "non-mutating" }, 2000);
const request = JSON.parse(socketA.sent[0]!) as { type: string; id: string; method: string };
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
const check = (name: string, passed: boolean, detail?: string) => {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

check("RPC request is sent only to A connection", socketA.sent.length === 1 && socketB.sent.length === 0, `a=${socketA.sent.length} b=${socketB.sent.length}`);
check("RPC request is protocol-shaped", request.type === "rpc.request" && request.method === "qa.rpc.boundary" && typeof request.id === "string");

// Deliberately answer using B's connection identity and A's request UUID.
// A secure manager must ignore this response, then accept A's real response.
manager.handleRpcResponse(connectionB, { type: "rpc.response", id: request.id, result: { owner: "B" } });
const stillPending = await Promise.race([
  pending.then(() => false),
  new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(true), 25)),
]);
check("foreign B connection cannot resolve A RPC", stillPending, "B response was not allowed to complete pending RPC");
manager.handleRpcResponse(connectionA, { type: "rpc.response", id: request.id, result: { owner: "A" } });
const result = await pending;
check("original A connection can still complete its RPC", result.owner === "A", `resolved=${result.owner}`);

manager.dispose();
const reportPath = resolve("../../artifacts/saas-boundary/ws-rpc-cross-connection-controlled-retest.json");
await writeFile(reportPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  kind: "controlled-in-process-websocket-rpc-ownership",
  realNetwork: false,
  providerRequests: 0,
  applicationDataWrites: 0,
  tokensPrinted: false,
  checks,
}, null, 2));
console.log(JSON.stringify({ report: reportPath, checks: checks.length, failed: checks.filter((item) => !item.passed).length }));
if (checks.some((item) => !item.passed)) process.exitCode = 1;
