/**
 * The worker heartbeat is what makes "no work queued" different from "nobody is
 * consuming the queue". These tests cover the write the worker performs and the
 * promise semantics the caller relies on.
 */
import { describe, expect, it, vi } from "vitest";

import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKER_HEARTBEAT_TABLE,
  startWorkerHeartbeat,
  writeWorkerHeartbeat,
} from "./worker-heartbeat.js";

function fakeHeartbeatClient(result: { error: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(result));
  return { client: { rpc } as never, rpc };
}

describe("worker heartbeat writer", () => {
  it("records the worker id, queues and version through the heartbeat RPC", async () => {
    const { client, rpc } = fakeHeartbeatClient({ error: null });
    await expect(
      writeWorkerHeartbeat(client, {
        queues: ["image_generation_jobs"],
        version: "1.2.3",
        workerId: "w1",
      }),
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("loomic_worker_heartbeat_write", {
      p_queues: ["image_generation_jobs"],
      p_version: "1.2.3",
      p_worker_id: "w1",
    });
  });

  it("sends a null version when it is not reported instead of an empty string", async () => {
    const { client, rpc } = fakeHeartbeatClient({ error: null });
    await writeWorkerHeartbeat(client, {
      queues: [],
      version: "",
      workerId: "w1",
    });
    const [, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args).toMatchObject({ p_version: null });
  });

  it("reports a failed write as false rather than throwing at the worker", async () => {
    const { client } = fakeHeartbeatClient({ error: { message: "permission denied" } });
    await expect(
      writeWorkerHeartbeat(client, { queues: [], version: "1", workerId: "w1" }),
    ).resolves.toBe(false);
  });

  it("does not let a transport rejection escape", async () => {
    const client = {
      rpc: () => Promise.reject(new Error("socket hang up")),
    } as never;
    await expect(
      writeWorkerHeartbeat(client, { queues: [], version: "1", workerId: "w1" }),
    ).resolves.toBe(false);
  });

  it("documents a threshold of three missed beats", () => {
    expect(WORKER_HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(WORKER_HEARTBEAT_STALE_AFTER_MS).toBe(3 * WORKER_HEARTBEAT_INTERVAL_MS);
    // The RPC and the table it writes must stay in the same `private` schema.
    expect(WORKER_HEARTBEAT_TABLE).toBe("loomic_worker_heartbeats");
  });
});

describe("worker heartbeat loop", () => {
  it("beats immediately, then on the interval, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const { client, rpc } = fakeHeartbeatClient({ error: null });
      const heartbeat = startWorkerHeartbeat({
        getAdminClient: () => client,
        intervalMs: 1_000,
        version: "1",
        workerId: "w1",
      });

      // The immediate beat runs before the first interval fires.
      await vi.advanceTimersByTimeAsync(0);
      expect(rpc).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(rpc).toHaveBeenCalledTimes(4);

      heartbeat.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rpc).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a failed beat through onError without stopping the loop", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const client = {
        rpc: () => Promise.reject(new Error("db down")),
      } as never;
      const heartbeat = startWorkerHeartbeat({
        getAdminClient: () => client,
        intervalMs: 1_000,
        onError,
        version: "1",
        workerId: "w1",
      });

      await vi.advanceTimersByTimeAsync(2_500);
      expect(onError).toHaveBeenCalled();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
