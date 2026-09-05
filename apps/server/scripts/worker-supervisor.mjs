/** Supervise the actual worker, not a --watch wrapper that stays alive after failure. */
export function superviseWorker({ spawnWorker, log = console.error, schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let stopped = false;
  let child;
  let timer;
  let failures = 0;
  function start() {
    if (stopped) return;
    const started = now();
    let handled = false;
    const retry = (reason) => {
      if (handled || stopped) return;
      handled = true;
      child = undefined;
      if (now() - started > 60_000) failures = 0;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      log(`[dev:worker] ${reason}; restarting in ${delay}ms`);
      timer = schedule(start, delay);
    };
    try {
      child = spawnWorker();
      child.once('error', error => retry(error.message));
      child.once('exit', (code, signal) => retry(`exited (${signal ?? code})`));
    } catch (error) { retry(error.message); }
  }
  start();
  return { stop() {
    stopped = true;
    if (timer) cancel(timer);
    if (child && !child.killed) child.kill();
  } };
}
