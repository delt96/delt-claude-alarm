import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, controlEndpoint, requestStop } from '../src/codex/instance-lock.js';
import { until } from './helpers/fake-codex-daemon.js';
import { createAdapterShutdown, closeWithinLimit, ADAPTER_SHUTDOWN_MS, RUN_CLOSE_MS, SUPERVISOR_STOP_GRACE_MS } from '../src/codex/shutdown.js';
import { HANDSHAKE_TIMEOUT_MS, PROXY_TREE_CLOSE_BUDGET_MS } from '../src/codex/transport.js';
import { shutdownClock, flush } from './helpers/shutdown-clock.js';
import { CodexSupervisor } from '../src/hub/codex-supervisor.js';
import { HubServer } from '../src/hub/server.js';
import { logger } from '../src/shared/logger.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

for (const trigger of ['SIGINT', 'SIGTERM', 'end', 'close']) {
  test(`${trigger} waits for a kill longer than the old three-second limit`, async (t) => {
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
    (trigger === 'end' || trigger === 'close' ? stdin : signals).emit(trigger);
    await clock.tick(3050);
    assert.equal(exits, 0);
    await clock.tick(250);
    assert.equal(exits, 1);
    shutdown();
    assert.equal(exits, 1);
  });
}

test('codex stop reaches the adapter shutdown through the instance lock, which exits only after the kill', async () => {
  const endpoint = controlEndpoint(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stop-lock-')));
  let shutdown: (() => void) | undefined;
  const lock = await acquireLock(endpoint, { pid: process.pid, token: 'stop-token', onStop: () => shutdown?.() });
  assert.equal(lock.kind, 'owner');
  if (lock.kind !== 'owner') return;
  let finishKill: (() => void) | undefined;
  let exits = 0;
  shutdown = createAdapterShutdown({
    signals: new EventEmitter(),
    stop: () => new Promise<void>((resolve) => { finishKill = resolve; }),
    release: lock.close,
    exit: () => { exits++; },
  });
  try {
    assert.deepEqual(await requestStop(endpoint, 'stop-token'), { state: 'stopping', pid: process.pid });
    await until(() => finishKill !== undefined);
    await sleep(50);
    assert.equal(exits, 0);
  } finally {
    finishKill?.();
  }
  await until(() => exits === 1);
});

test('stuck shutdown and run close reach their stated bounds, and the adapter warns as it exits at its deadline', async (t) => {
  const clock = shutdownClock(t);
  const warn = t.mock.method(logger, 'warn', () => {});
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
  assert.equal(warn.mock.callCount(), 0);
  await clock.tick(1);
  assert.equal(exited, true);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), [`Codex adapter shutdown did not finish within ${ADAPTER_SHUTDOWN_MS}ms; exiting`]);
});

test('lock release starts while the proxy stop is still pending, and the adapter exits once both are done', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => ({} as any));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let release = false;
  let exited = false;
  let finish!: () => void;
  createAdapterShutdown({ signals: new EventEmitter(), stop: () => new Promise<void>((resolve) => { finish = resolve; }), release: async () => { release = true; }, exit() { exited = true; } })();
  await flush();
  try { assert.equal(release, true); assert.equal(exited, false); } finally { finish(); await flush(); }
  assert.equal(exited, true);
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

test('supervisor stop waits for adapter exit or its force deadline, and warns when it force-kills', async (t) => {
  const clock = shutdownClock(t);
  const warn = t.mock.method(logger, 'warn', () => {});
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end() {} }), kill() { killed = true; return true; } });
  let killed = false;
  const supervisor = new CodexSupervisor('/fake/main.js', { spawnFn: () => child as any, stopGraceMs: 50 });
  supervisor.start();
  let settled = false;
  const stopped = supervisor.stop().then(() => { settled = true; });
  await clock.tick(20);
  assert.equal(settled, false);
  assert.equal(killed, false);
  assert.equal(warn.mock.callCount(), 0);
  await clock.tick(30);
  await stopped;
  assert.equal(killed, true);
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments[0]), ['Codex adapter did not exit within 50ms of stop; killing it']);
});

test('a supervisor given no stop grace waits SUPERVISOR_STOP_GRACE_MS before force-killing the adapter', async (t) => {
  const clock = shutdownClock(t);
  t.mock.method(logger, 'warn', () => {});
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { end() {} }), kill() { killed = true; return true; } });
  let killed = false;
  const supervisor = new CodexSupervisor('/fake/main.js', { spawnFn: () => child as any });
  supervisor.start();
  const stopped = supervisor.stop();
  await clock.tick(SUPERVISOR_STOP_GRACE_MS - 1);
  assert.equal(killed, false);
  await clock.tick(1);
  await stopped;
  assert.equal(killed, true);
});

test('a second hub stop settles only when the first one has finished waiting for the adapter', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => ({} as any));
  t.mock.method(logger, 'info', () => {});
  let finish!: () => void;
  let stops = 0;
  const server: any = {
    codexSupervisor: { stop: () => { stops++; return new Promise<void>((resolve) => { finish = resolve; }); } },
    channelSockets: new Map(), dashboardSockets: new Map(), codexAdapters: new Map(),
    wssChannel: { close() {} }, wssDashboard: { close() {} }, wssCodex: { close() {} },
    httpServer: { close(callback: () => void) { callback(); } },
  };
  let firstDone = false;
  const first = HubServer.prototype.stop.call(server).then(() => { firstDone = true; });
  let secondDone = false;
  const second = HubServer.prototype.stop.call(server).then(() => { secondDone = true; });
  await flush();
  try { assert.deepEqual([firstDone, secondDone, stops], [false, false, 1]); } finally { finish(); await Promise.all([first, second]); }
  assert.deepEqual([firstDone, secondDone], [true, true]);
});
