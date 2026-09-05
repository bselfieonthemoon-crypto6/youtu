import { describe, expect, it, vi } from "vitest";

import {
  createCropSaveGuard,
  monitorCanvasGenerationJob,
} from "../src/components/canvas-tool-menu";

describe("CanvasToolMenu async guards", () => {
  it("invalidates an in-flight crop save when the crop session is canceled", () => {
    const guard = createCropSaveGuard();
    const first = guard.begin();

    expect(first).not.toBeNull();
    expect(guard.begin()).toBeNull();
    expect(guard.isCurrent(first as number)).toBe(true);

    guard.cancel();
    expect(guard.isCurrent(first as number)).toBe(false);

    const second = guard.begin();
    expect(second).not.toBeNull();
    guard.complete(first as number);
    expect(guard.begin()).toBeNull();
    guard.complete(second as number);
    expect(guard.begin()).not.toBeNull();
  });

  it("clears each failed monitor attempt and retries transient fetch failures with backoff", async () => {
    const waitForJob = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValueOnce({
        id: "job-1",
        status: "canceled",
        result: null,
      });
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const onAttemptStarted = vi.fn();
    const onAttemptFinished = vi.fn();

    const result = await monitorCanvasGenerationJob("token", "job-1", {
      waitForJob,
      sleep,
      onAttemptStarted,
      onAttemptFinished,
    });

    expect(result.status).toBe("canceled");
    expect(waitForJob).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(onAttemptStarted).toHaveBeenCalledTimes(2);
    expect(onAttemptFinished).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when job fetches keep failing", async () => {
    const waitForJob = vi.fn().mockRejectedValue(new TypeError("offline"));
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const onAttemptFinished = vi.fn();

    await expect(
      monitorCanvasGenerationJob("token", "job-2", {
        waitForJob,
        sleep,
        onAttemptFinished,
        maxTransientRetries: 2,
      }),
    ).rejects.toThrow("offline");

    expect(waitForJob).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      500, 1_000,
    ]);
    expect(onAttemptFinished).toHaveBeenCalledTimes(3);
  });

  it("retries a transient finalization fetch and closes on the succeeded job", async () => {
    const waitForJob = vi
      .fn()
      .mockResolvedValueOnce({ id: "job-3", status: "succeeded", result: null })
      .mockResolvedValueOnce({
        id: "job-3",
        status: "succeeded",
        result: { canvas_element_id: "element-3" },
      });
    const fetchJobById = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("replica unavailable"));
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const onAttemptFinished = vi.fn();

    const result = await monitorCanvasGenerationJob("token", "job-3", {
      waitForJob,
      fetchJobById,
      sleep,
      onAttemptFinished,
    });

    expect(result.result).toEqual({ canvas_element_id: "element-3" });
    expect(fetchJobById).toHaveBeenCalledOnce();
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000, 500,
    ]);
    expect(onAttemptFinished).toHaveBeenCalledTimes(2);
  });
});
