/** Two independent app-instance components with a controlled shared repository.
 * Uses the real outbox service, broadcaster and connection manager. No network,
 * real DB, running server, or provider is touched. Not a multi-process load test.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DesignEventOutboxDto } from "@loomic/shared";
import { ConnectionManager } from "../src/ws/connection-manager.js";
import { DesignOutboxService, createConnectionManagerDesignBroadcaster, type DesignOutboxRepository } from "../src/features/designs/design-outbox-service.js";

const designId = "10000000-0000-4000-8000-000000000001";
const checks: Array<{ name: string; passed: boolean; detail: unknown }> = [];
for (const aHasViewer of [true, false]) {
  const managers = [new ConnectionManager(), new ConnectionManager()];
  const frames: string[][] = [[], []];
  for (let index = 0; index < 2; index++) {
    if (index === 0 && !aHasViewer) continue;
    const id = managers[index]!.register(`qa-${index}`, `qa-user-${index}`, {
      readyState: 1, send(value: string) { frames[index]!.push(value); },
    } as never);
    managers[index]!.bindCanvas(id, "qa-shared-canvas");
  }
  const rows: DesignEventOutboxDto[] = [{
    id: "30000000-0000-4000-8000-000000000001", design_id: designId,
    workspace_id: "20000000-0000-4000-8000-000000000001", revision: 4,
    event_type: "design.sync", payload: { type: "design.sync", designId, revision: 4, updateType: "mutated", changedObjectIds: [] },
    status: "publishing", attempt_count: 1, available_at: new Date().toISOString(),
    claimed_at: new Date().toISOString(), claim_token: "40000000-0000-4000-8000-000000000001",
    published_at: null, last_error: null, created_at: new Date().toISOString(),
  }];
  let published = 0;
  const repository: DesignOutboxRepository = {
    claim: async () => rows.splice(0, 1), // Models one globally claimed row.
    markPublished: async () => { published++; return true; },
    markFailed: async () => true, reconcile: async () => 0,
  };
  const services = managers.map(connections => new DesignOutboxService(repository,
    createConnectionManagerDesignBroadcaster({ connections, getAdminClient: (() => ({ from: () => ({
      select: () => ({ eq: async () => ({ data: [{ canvas_id: "qa-shared-canvas" }], error: null }) }),
    }) })) as never })));
  const first = await services[0]!.publishBatch();
  const second = await services[1]!.publishBatch();
  checks.push({ name: aHasViewer ? "both instances receive shared design event" : "publisher without local viewers does not lose remote delivery",
    passed: frames[1]!.length === 1, detail: { aHasViewer, first, second, published, framesA: frames[0]!.length, framesB: frames[1]!.length } });
  managers.forEach(manager => manager.dispose());
}
const report = { kind: "controlled-two-instance-components", realNetwork: false, realDatabase: false, providerRequests: 0, checks };
await writeFile(resolve("../../artifacts/saas-boundary/design-outbox-multi-instance-controlled.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (checks.some(check => !check.passed)) process.exitCode = 1;
