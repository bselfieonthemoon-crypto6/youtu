import { describe, expect, it, vi } from 'vitest';
import { trackTask } from './track-task.js';

describe('queue task isolation', () => {
  it('catches claim failures immediately and releases capacity', async () => {
    const tasks = new Set<Promise<void>>();
    const error = new Error('database disconnected during claim');
    const log = vi.fn();
    const task = trackTask(tasks, async () => { throw error; }, log);
    expect(tasks.size).toBe(1);
    await expect(task).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(error);
    expect(tasks.size).toBe(0);
    const next = vi.fn(async () => {});
    await trackTask(tasks, next, log);
    expect(next).toHaveBeenCalledOnce();
  });
  it('contains synchronous errors and logging failures', async () => {
    const tasks = new Set<Promise<void>>();
    await expect(trackTask(tasks, () => { throw Error('sync'); }, () => { throw Error('log'); })).resolves.toBeUndefined();
    expect(tasks.size).toBe(0);
  });
  it('waits for in-flight work without retrying successful tasks', async () => {
    const tasks = new Set<Promise<void>>();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const task = trackTask(tasks, run, vi.fn());
    await Promise.resolve();
    expect(tasks.size).toBe(1);
    finish();
    await task;
    expect(tasks.size).toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });
});
