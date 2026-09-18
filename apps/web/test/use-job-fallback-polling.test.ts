import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchJobMock } = vi.hoisted(() => ({ fetchJobMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({ fetchJob: fetchJobMock }));

import { waitForGenerationJob } from "../src/hooks/use-job-fallback-polling";

describe("waitForGenerationJob", () => {
  it("keeps two jobs isolated when one query fails and later succeeds", async () => {
    vi.useFakeTimers();
    let secondAttempts = 0;
    fetchJobMock.mockImplementation(async (_token, id) => {
      if (id === "second" && ++secondAttempts === 1) throw new Error("Failed to query job.");
      return { job: { id, status: "succeeded", target_kind: "canvas", result: { canvas_element_id: `node-${id}` } } };
    });
    const first = waitForGenerationJob("token", "first");
    const second = waitForGenerationJob("token", "second");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).result?.canvas_element_id).toBe("node-first");
    expect((await second).result?.canvas_element_id).toBe("node-second");
    expect(secondAttempts).toBe(2);
  });
  afterEach(() => {
    vi.useRealTimers();
    fetchJobMock.mockReset();
  });

  it("keeps polling a retryable failed attempt until the same job succeeds", async () => {
    vi.useFakeTimers();
    fetchJobMock
      .mockResolvedValueOnce({
        job: { status: "failed", attempt_count: 1, max_attempts: 3 },
      })
      .mockResolvedValueOnce({
        job: { status: "succeeded", attempt_count: 2, max_attempts: 3 },
      });

    const resultPromise = waitForGenerationJob("token", "job-retrying");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toMatchObject({
      status: "succeeded",
      attempt_count: 2,
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(2);
  });
  it("waits for canvas delivery after provider success", async () => {
    vi.useFakeTimers();
    fetchJobMock
      .mockResolvedValueOnce({
        job: { status: "succeeded", target_kind: "canvas", result: {} },
      })
      .mockResolvedValueOnce({
        job: {
          status: "succeeded",
          target_kind: "canvas",
          result: { canvas_element_id: "element" },
        },
      });
    const waiting = waitForGenerationJob("token", "delivery-pending");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await waiting).result?.canvas_element_id).toBe("element");
    expect(fetchJobMock).toHaveBeenCalledTimes(2);
  });
  it("stops on submission failure even before the first provider attempt", async () => {
    fetchJobMock.mockResolvedValue({
      job: {
        status: "failed",
        error_code: "submission_failed",
        attempt_count: 0,
        max_attempts: 3,
      },
    });
    expect(
      (await waitForGenerationJob("token", "submission-failed")).status,
    ).toBe("failed");
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });
});
