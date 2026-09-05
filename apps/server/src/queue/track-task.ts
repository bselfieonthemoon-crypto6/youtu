/** Attach rejection handling immediately, even when the queue has spare capacity. */
export function trackTask(
  tasks: Set<Promise<void>>,
  run: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const task = Promise.resolve()
    .then(run)
    .catch((error) => {
      // Infrastructure failures leave the durable queue message for recovery.
      // Do not mark failed or resubmit here: execution may have already succeeded.
      try { onError(error); } catch { /* Logging must not reject the task. */ }
    })
    .finally(() => tasks.delete(task));
  tasks.add(task);
  return task;
}
