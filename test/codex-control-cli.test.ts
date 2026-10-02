import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterStatus, stopAdapter, type ControlDeps } from '../src/codex/control-cli.js';
import type { OwnerState, StopResult } from '../src/codex/instance-lock.js';

const PIDFILE = 'C:\\home\\.claude-alarm\\codex.pid';
const CONFIG = 'C:\\home\\.claude-alarm\\config.json';
const note = (pid: number) =>
  `Note: ${PIDFILE} names a running process (PID: ${pid}). claude-alarm 1.2.0 and earlier wrote this file; if that process is an old Codex adapter, restart the hub or end it yourself.`;

function deps(o: { owners?: OwnerState[]; stop?: StopResult; legacy?: number; alive?: number[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const owners: OwnerState[] = [...(o.owners ?? [{ state: 'absent' }])];
  let removed = 0;
  let stops = 0;
  const d: ControlDeps = {
    queryOwner: async () => (owners.length > 1 ? owners.shift()! : owners[0]),
    requestStop: async () => { stops++; return o.stop ?? { state: 'absent' }; },
    legacyPid: () => o.legacy,
    isRunning: (pid) => (o.alive ?? []).includes(pid),
    removeLegacyPidFile: () => { removed++; },
    legacyPidFile: PIDFILE,
    configFile: CONFIG,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async () => {},
    stopWaitMs: 500,
  };
  return { d, out, err, removed: () => removed, stops: () => stops };
}

test('stop with nothing running says so and sends no stop request', async () => {
  const t = deps();
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running']);
  assert.equal(t.stops(), 0);
});

test('a live process in an old codex.pid is pointed out, never stopped or removed', async () => {
  const t = deps({ legacy: 4321, alive: [4321] });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running', note(4321)]);
  assert.equal(t.removed(), 0);
});

test('an old codex.pid naming a dead process is removed silently', async () => {
  const t = deps({ legacy: 4321 });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running']);
  assert.equal(t.removed(), 1);
});

test('stop waits until the adapter is gone', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }, { state: 'running', pid: 10 }, { state: 'absent' }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter stopped (PID: 10)']);
  assert.deepEqual(t.err, []);
});

test('a waiting hub adapter taking over still counts as stopped', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }, { state: 'running', pid: 11 }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter stopped (PID: 10)']);
});

test('a refused stop names the config file', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }], stop: { state: 'unauthorized' } });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, [`Codex adapter refused to stop: the token in ${CONFIG} does not match the one it started with`]);
});

test('an adapter that does not go away in time is reported', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, ['Stop requested, but the Codex adapter (PID: 10) is still running. Check with: claude-alarm codex status']);
});

test('an unanswering endpoint is an error for stop', async () => {
  const t = deps({ owners: [{ state: 'unknown', error: 'no answer within 1000ms' }] });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, ['Codex adapter control endpoint is unavailable: no answer within 1000ms']);
  assert.equal(t.stops(), 0);
});

test('status lines', async () => {
  const running = deps({ owners: [{ state: 'running', pid: 10 }] });
  assert.equal(await adapterStatus(running.d, true), 0);
  assert.deepEqual(running.out, ['Codex adapter: running (PID: 10)', 'Start with hub: enabled']);

  const stopped = deps({ legacy: 4321, alive: [4321] });
  await adapterStatus(stopped.d, false);
  assert.deepEqual(stopped.out, ['Codex adapter: not running', note(4321), 'Start with hub: disabled']);

  const unknown = deps({ owners: [{ state: 'unknown', error: 'EACCES' }] });
  await adapterStatus(unknown.d, false);
  assert.deepEqual(unknown.out, ['Codex adapter: unknown (EACCES)', 'Start with hub: disabled']);
});
