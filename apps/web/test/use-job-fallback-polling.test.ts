import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchJobMock } = vi.hoisted(() => ({ fetchJobMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({ fetchJob: fetchJobMock }));

import { waitForGenerationJob } from "../src/hooks/use-job-fallback-polling";

describe("waitForGenerationJob", () => {
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
});
