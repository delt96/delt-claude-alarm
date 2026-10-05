import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, treeKiller, type KillTreeFn, type RunFn, type SpawnFn } from '../src/codex/transport.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

interface FakeChild { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kills: number; kill(): boolean }

function fakeChild(state: Partial<Pick<FakeChild, 'pid' | 'exitCode' | 'signalCode'>> = {}): FakeChild {
  const child: FakeChild = { pid: 4242, exitCode: null, signalCode: null, kills: 0, kill: () => { child.kills++; return true; }, ...state };
  return child;
}

function recorder(fail?: Error) {
  const runs: Array<{ file: string; args: string[]; options: { windowsHide: boolean } }> = [];
  const run: RunFn = (file, args, options, callback) => {
    runs.push({ file, args, options });
    callback(fail ?? null);
  };
  return { runs, run };
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;

test('on Windows the tree under the spawned pid is ended with a hidden taskkill', () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  treeKiller('win32', run)(asChild(child));
  assert.deepEqual(runs, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'], options: { windowsHide: true } }]);
  assert.equal(child.kills, 0);
});

test('elsewhere the proxy is ended with child.kill()', () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  treeKiller('linux', run)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a proxy that has already exited is left alone, since its pid may now belong to another process', () => {
  const { runs, run } = recorder();
  for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' as const }]) {
    const child = fakeChild(state);
    treeKiller('win32', run)(asChild(child));
    treeKiller('linux', run)(asChild(child));
    assert.equal(child.kills, 0);
  }
  assert.deepEqual(runs, []);
});

test('a proxy that never got a pid is ended with child.kill() even on Windows', () => {
  const { runs, run } = recorder();
  const child = fakeChild({ pid: undefined });
  treeKiller('win32', run)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a failed taskkill is only logged', (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { run } = recorder(new Error('The process "4242" not found.'));
  assert.doesNotThrow(() => treeKiller('win32', run)(asChild(fakeChild())));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('4242')), true);
});

test('closing a connection ends the proxy stdin first, then its process tree', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = (command, args) => (spawned = daemon.spawnFn(command, args));
  const killed: Array<{ child: ChildProcess; stdinEnded: boolean }> = [];
  try {
    const conn = await connectProxy('codex', spawnFn, 5000, (child) => {
      killed.push({ child, stdinEnded: child.stdin?.writableEnded === true });
      child.kill();
    });
    conn.close();
    assert.equal(killed.length, 1);
    assert.equal(killed[0].child, spawned);
    assert.equal(killed[0].stdinEnded, true);
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
    await daemon.stop();
  }
});

test('a handshake timeout ends the proxy tree through the same function', async () => {
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (spawned = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' }));
  const killed: ChildProcess[] = [];
  try {
    await assert.rejects(
      connectProxy('codex', spawnFn, 300, (child) => {
        killed.push(child);
        child.kill();
      }),
      /^Error: codex daemon did not answer within 0.3s$/,
    );
    assert.equal(killed.length, 1);
    assert.equal(killed[0], spawned);
    await until(() => spawned!.exitCode !== null || spawned!.signalCode !== null);
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
  }
});

test('recorded descendants survive shell exit and only matching creation times are killed', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const query = async () => ++calls === 1 ? [
    { pid: 4242, parentPid: 1, creationTime: '2026-10-05T00:00:01.0000000Z' },
    { pid: 5001, parentPid: 4242, creationTime: '2026-10-05T00:00:02.0000000Z' },
    { pid: 5002, parentPid: 5001, creationTime: '2026-10-05T00:00:03.0000000Z' },
    { pid: 5003, parentPid: 4242, creationTime: '2026-10-05T00:00:02.0000000Z' },
    { pid: 6000, parentPid: 1, creationTime: '2026-10-05T00:00:01.0000000Z' },
  ] : [
    { pid: 4242, parentPid: 1, creationTime: '2026-10-05T00:00:04.0000000Z' },
    { pid: 5001, parentPid: 1, creationTime: '2026-10-05T00:00:04.0000000Z' },
    { pid: 5002, parentPid: 1, creationTime: '2026-10-05T00:00:03.0000000Z' },
    { pid: 6000, parentPid: 1, creationTime: '2026-10-05T00:00:01.0000000Z' },
  ];
  const killer = treeKiller('win32', run, query);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  killer(asChild(child));
  await until(() => runs.length === 1);
  assert.deepEqual(runs, [{ file: 'taskkill', args: ['/PID', '5002', '/T', '/F'], options: { windowsHide: true } }]);
  assert.equal(child.kills, 0);
});

test('failed descendant queries are logged and record no processes', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { runs, run } = recorder();
  const killer = treeKiller('win32', run, async () => { throw new Error('query failed'); });
  await killer.track!(asChild(child));
  child.exitCode = 0;
  killer(asChild(child));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(runs, []);
  assert.equal(debug.mock.calls.some(c => String(c.arguments[0]).includes('query failed')), true);
});

test('a snapshot finishing after shell exit is not recorded', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  const rows = [
    { pid: 4242, parentPid: 1, creationTime: '2026-10-05T00:00:01.0000000Z' },
    { pid: 5001, parentPid: 4242, creationTime: '2026-10-05T00:00:02.0000000Z' },
  ];
  let calls = 0;
  let finish!: (rows: typeof rows) => void;
  const killer = treeKiller('win32', run, () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(rows));
  const pending = killer.track!(asChild(child));
  child.exitCode = 0;
  finish(rows);
  await pending;
  killer(asChild(child));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(runs, []);
  assert.equal(calls, 1);
});

test('a failed verification query leaves recorded descendants alone', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const killer = treeKiller('win32', run, async () => {
    if (++calls === 1) return [{ pid: 4242, parentPid: 1, creationTime: '2026-10-05T00:00:01.0000000Z' }, { pid: 5001, parentPid: 4242, creationTime: '2026-10-05T00:00:02.0000000Z' }];
    throw new Error('verification failed');
  });
  await killer.track!(asChild(child));
  child.exitCode = 0;
  killer(asChild(child));
  await until(() => debug.mock.calls.some(c => String(c.arguments[0]).includes('verification failed')));
  assert.deepEqual(runs, []);
});

test('tracking on other platforms never queries processes', async () => {
  const child = fakeChild();
  let queried = false;
  const { run } = recorder();
  const killer = treeKiller('linux', run, async () => { queried = true; return []; });
  await killer.track!(asChild(child));
  killer(asChild(child));
  assert.equal(queried, false);
  assert.equal(child.kills, 1);
});

test('a pending descendant query does not delay the handshake', { skip: process.platform !== 'win32' }, async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  let trackingStarted = false;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const killer: KillTreeFn = child => { child.kill(); };
  killer.track = () => { trackingStarted = true; return pending; };
  try {
    const conn = await connectProxy('fake-codex.cmd', (command, args) => (spawned = daemon.spawnFn(command, args)), 5000, killer);
    assert.equal(trackingStarted, true);
    conn.close();
  } finally {
    finish();
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
    await daemon.stop();
  }
});

test('older processes naming reused parent PIDs are excluded at every level', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  const rows = [
    { pid: 4242, parentPid: 1, creationTime: '2026-10-05T00:00:02.0000000Z' },
    { pid: 5001, parentPid: 4242, creationTime: '2026-10-05T00:00:01.0000000Z' },
    { pid: 5002, parentPid: 5001, creationTime: '2026-10-05T00:00:04.0000000Z' },
    { pid: 5003, parentPid: 4242, creationTime: '2026-10-05T00:00:03.0000000Z' },
    { pid: 5004, parentPid: 5003, creationTime: '2026-10-05T00:00:02.0000000Z' },
    { pid: 5005, parentPid: 5003, creationTime: '2026-10-05T00:00:03.0000000Z' },
  ];
  const killer = treeKiller('win32', run, async () => rows);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  killer(asChild(child));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(runs.map(row => row.args[1]), ['5003', '5005']);
});

test('a snapshot missing the shell row records nothing', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const killer = treeKiller('win32', run, async () => {
    calls++;
    return [{ pid: 5001, parentPid: 4242, creationTime: '2026-10-05T00:00:03.0000000Z' }];
  });
  await killer.track!(asChild(child));
  child.exitCode = 0;
  killer(asChild(child));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(runs, []);
  assert.equal(calls, 1);
});
