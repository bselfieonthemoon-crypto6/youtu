// Recovery scans must not hold the queue consumer hostage; keep one scan in flight.
export function createBackgroundMaintenance(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let pending: Promise<void> | null = null;
  return {
    trigger() {
      if (pending) return;
      pending = Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(() => {
          pending = null;
        });
    },
    idle() {
      return pending ?? Promise.resolve();
    },
  };
}
