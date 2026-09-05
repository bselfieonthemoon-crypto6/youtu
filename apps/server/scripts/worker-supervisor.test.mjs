import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { superviseWorker } from './worker-supervisor.mjs';

test('worker crash restarts once, with bounded backoff; stop prevents restart', () => {
  const timers = [];
  const children = [];
  const supervisor = superviseWorker({
    spawnWorker: () => { const c = new EventEmitter(); c.kill = () => { c.killed = true; }; children.push(c); return c; },
    log: () => {}, now: () => 0,
    schedule: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
    cancel: t => { t.canceled = true; },
  });
  children[0].emit('error', Error('spawn failure'));
  children[0].emit('exit', 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  timers[0].fn();
  assert.equal(children.length, 2);
  children[1].emit('exit', 1);
  assert.equal(timers[1].delay, 2000);
  supervisor.stop();
  assert.equal(timers[1].canceled, true);
  timers[1].fn();
  assert.equal(children.length, 2);
});

test('normal shutdown terminates active worker without scheduling restart', () => {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  const supervisor = superviseWorker({ spawnWorker: () => child, schedule: () => { throw Error('unexpected restart'); } });
  supervisor.stop();
  assert.equal(child.killed, true);
});

test('restarts an actual crashed Node child and can stop the replacement', { timeout: 10000 }, async () => {
  let starts = 0;
  let replacement;
  let notify;
  const ready = new Promise(resolve => { notify = resolve; });
  const supervisor = superviseWorker({
    spawnWorker: () => {
      const child = spawn(process.execPath, ['-e', starts++ === 0 ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (starts === 2) { replacement = child; child.once('spawn', notify); }
      return child;
    },
    log: () => {},
  });
  try { await ready; assert.equal(starts, 2); }
  finally { supervisor.stop(); }
  assert.equal(replacement.killed, true);
});
