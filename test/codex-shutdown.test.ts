import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdapterShutdown, closeWithinLimit, ADAPTER_SHUTDOWN_MS, RUN_CLOSE_MS, SUPERVISOR_STOP_GRACE_MS } from '../src/codex/shutdown.js';
import { HANDSHAKE_TIMEOUT_MS, PROXY_TREE_CLOSE_BUDGET_MS } from '../src/codex/transport.js';
import { shutdownClock } from './helpers/shutdown-clock.js';
import { CodexSupervisor } from '../src/hub/codex-supervisor.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

for (const path of ['SIGINT', 'SIGTERM', 'end', 'close', 'control']) {
  test(`${path} waits for a kill longer than the old three-second limit`, async (t) => {
    const clock = shutdownClock(t);
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    let killed = false;
    let exits = 0;
    const shutdown = createAdapterShutdown({
      signals, stdin,
      stop: async () => { await sleep(3200); killed = true; },
      release: async () => { throw new Error('lock release failed'); },
      exit: () => { assert.equal(killed, true); exits++; },
    });
    if (path === 'control') shutdown();
    else (path === 'end' || path === 'close' ? stdin : signals).emit(path);
    await clock.tick(3050);
    assert.equal(exits, 0);
    await clock.tick(250);
    assert.equal(exits, 1);
    shutdown();
    assert.equal(exits, 1);
  });
}

test('stuck shutdown and run close reach their stated bounds', async (t) => {
  const clock = shutdownClock(t);
  let exited = false;
  createAdapterShutdown({ signals: new EventEmitter(), stop: () => new Promise(() => {}), release: async () => {}, exit: () => { exited = true; } })();
  const pending = assert.rejects(closeWithinLimit(() => new Promise(() => {})), /Codex proxy cleanup timed out/);
  await clock.tick(RUN_CLOSE_MS - 1);
  assert.equal(exited, false);
  await clock.tick(1);
  await pending;
  assert.equal(exited, false);
  await clock.tick(ADAPTER_SHUTDOWN_MS - RUN_CLOSE_MS - 1);
  assert.equal(exited, false);
  await clock.tick(1);
  assert.equal(exited, true);
  assert.equal(clock.pending(), 0);
});

test('run close waits for slow cleanup and clears its deadline', async (t) => {
  const clock = shutdownClock(t);
  let killed = false;
  const pending = closeWithinLimit(async () => { await sleep(3200); killed = true; });
  await clock.tick(3199);
  assert.equal(killed, false);
  await clock.tick(1);
  await pending;
  assert.equal(killed, true);
  assert.equal(clock.pending(), 0);
});

test('shutdown bounds leave room for the eleven-second tree kill and the adapter', () => {
  assert.equal(ADAPTER_SHUTDOWN_MS, 25_000);
  assert.equal(RUN_CLOSE_MS, 15_000);
  assert.equal(SUPERVISOR_STOP_GRACE_MS, 30_000);
  assert.equal(ADAPTER_SHUTDOWN_MS > HANDSHAKE_TIMEOUT_MS + PROXY_TREE_CLOSE_BUDGET_MS, true);
  assert.equal(RUN_CLOSE_MS > PROXY_TREE_CLOSE_BUDGET_MS, true);
  assert.equal(SUPERVISOR_STOP_GRACE_MS > ADAPTER_SHUTDOWN_MS, true);
});

test('supervisor stop waits for adapter exit or its force deadline', async (t) => {
  const clock = shutdownClock(t);
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end() {} }), kill() { killed = true; return true; } });
  let killed = false;
  const supervisor = new CodexSupervisor('/fake/main.js', { spawnFn: () => child as any, stopGraceMs: 50 });
  supervisor.start();
  let settled = false;
  const stopped = supervisor.stop().then(() => { settled = true; });
  await clock.tick(20);
  assert.equal(settled, false);
  assert.equal(killed, false);
  await clock.tick(30);
  await stopped;
  assert.equal(killed, true);
});
