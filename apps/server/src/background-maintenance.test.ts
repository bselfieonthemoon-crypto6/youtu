import { it, expect, vi } from "vitest";
import { createBackgroundMaintenance } from "./background-maintenance.js";
it("does not block queue polling or overlap a slow recovery scan", async () => {
  let resolve!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const m = createBackgroundMaintenance(task, vi.fn());
  m.trigger();
  m.trigger();
  await Promise.resolve();
  expect(task).toHaveBeenCalledTimes(1);
  resolve();
  await m.idle();
  m.trigger();
  await Promise.resolve();
  expect(task).toHaveBeenCalledTimes(2);
  resolve();
  await m.idle();
});
it("contains recovery rejection and permits a later scan", async () => {
  const error = vi.fn();
  const task = vi.fn().mockRejectedValue(new Error("offline"));
  const m = createBackgroundMaintenance(task, error);
  m.trigger();
  await m.idle();
  expect(error).toHaveBeenCalledTimes(1);
  m.trigger();
  await m.idle();
  expect(task).toHaveBeenCalledTimes(2);
});
