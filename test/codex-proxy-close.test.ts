import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, defaultSpawn, spawnedThroughShell, treeKiller, type KillTreeFn, type ProcessIdentity, type RunFn, type SpawnFn } from '../src/codex/transport.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

interface FakeChild { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kills: number; kill(): boolean }

function fakeChild(state: Partial<Pick<FakeChild, 'pid' | 'exitCode' | 'signalCode'>> = {}, events?: string[]): FakeChild {
  const child: FakeChild = { pid: 4242, exitCode: null, signalCode: null, kills: 0, kill: () => { child.kills++; events?.push('shell'); return true; }, ...state };
  return child;
}

function recorder(fail?: Error, events?: string[]) {
  const runs: Array<{ file: string; args: string[]; options: { windowsHide: boolean } }> = [];
  const run: RunFn = (file, args, options, callback) => {
    assert.equal(args.includes('/T'), false, `taskkill ${args.join(' ')} would also end processes that name a reused PID as parent`);
    runs.push({ file, args, options });
    events?.push(args[1]);
    callback(fail ?? null);
  };
  return { runs, run };
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;
const row = (pid: number, parentPid: number, second: number): ProcessIdentity => ({ pid, parentPid, creationTime: `2026-10-05T00:00:0${second}.0000000Z` });
const taskkill = (pid: number) => ({ file: 'taskkill', args: ['/PID', String(pid), '/F'], options: { windowsHide: true } });
const viaShell = () => true;
const direct = () => false;
const silentChild = () => spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' });

test('a live codex.cmd shell has its descendants ended one PID at a time, deepest first, then the shell itself', async () => {
  const events: string[] = [];
  const { runs, run } = recorder(undefined, events);
  const child = fakeChild({}, events);
  const rows = [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3), row(5003, 4242, 2), row(6000, 1, 1)];
  await treeKiller('win32', run, async () => rows, viaShell)(asChild(child));
  assert.deepEqual(runs, [taskkill(5002), taskkill(5001), taskkill(5003)]);
  assert.deepEqual(events, ['5002', '5001', '5003', 'shell']);
});

test('older processes that name the live shell PID as their parent are never ended, at any level', async () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  const rows = [row(4242, 1, 3), row(5001, 4242, 1), row(5002, 4242, 4), row(5003, 5001, 5), row(5004, 5002, 2), row(5005, 5002, 5)];
  await treeKiller('win32', run, async () => rows, viaShell)(asChild(child));
  assert.deepEqual(runs, [taskkill(5005), taskkill(5002)]);
  assert.equal(child.kills, 1);
});

test('the kill settles only after every taskkill has finished and the shell is ended', async () => {
  const callbacks: Array<(err: Error | null) => void> = [];
  const run: RunFn = (_file, _args, _options, callback) => { callbacks.push(callback); };
  const child = fakeChild();
  let settled = false;
  const killing = treeKiller('win32', run, async () => [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)], viaShell)(asChild(child))
    .then(() => { settled = true; });
  await until(() => callbacks.length === 1);
  callbacks[0](null);
  await until(() => callbacks.length === 2);
  assert.equal(settled, false);
  assert.equal(child.kills, 0);
  callbacks[1](null);
  await killing;
  assert.equal(child.kills, 1);
});

test('when the process snapshot fails, only the shell is ended and the failure is logged', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { runs, run } = recorder();
  const child = fakeChild();
  await treeKiller('win32', run, async () => { throw new Error('query failed'); }, viaShell)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('query failed')), true);
});

test('a snapshot without the live shell row ends only the shell', async () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  await treeKiller('win32', run, async () => [row(5001, 4242, 3)], viaShell)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a shell that exits while the snapshot is taken is not matched against that snapshot', async () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  const query = async () => {
    child.exitCode = 0;
    return [row(4242, 1, 5), row(5001, 4242, 6)];
  };
  await treeKiller('win32', run, query, viaShell)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 0);
});

test('a codex.exe started without a shell is ended with child.kill() alone, even on Windows', async () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  let queried = false;
  const killer = treeKiller('win32', run, async () => { queried = true; return []; }, direct);
  await killer.track!(asChild(child));
  await killer(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
  assert.equal(queried, false);
});

test('elsewhere the proxy is ended with child.kill()', async () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  await treeKiller('linux', run, async () => [], viaShell)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a proxy that has already exited is left alone, since its pid may now belong to another process', async () => {
  const { runs, run } = recorder();
  for (const throughShell of [viaShell, direct]) {
    for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' as const }]) {
      const child = fakeChild(state);
      await treeKiller('win32', run, async () => [row(4242, 1, 1), row(5001, 4242, 2)], throughShell)(asChild(child));
      await treeKiller('linux', run, async () => [], throughShell)(asChild(child));
      assert.equal(child.kills, 0);
    }
  }
  assert.deepEqual(runs, []);
});

test('a proxy that never got a pid is ended with child.kill() even on Windows', async () => {
  const { runs, run } = recorder();
  const child = fakeChild({ pid: undefined });
  await treeKiller('win32', run, async () => [], viaShell)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a failed taskkill is only logged', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { run } = recorder(new Error('The process "5001" not found.'));
  const child = fakeChild();
  await treeKiller('win32', run, async () => [row(4242, 1, 1), row(5001, 4242, 2)], viaShell)(asChild(child));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('5001')), true);
  assert.equal(child.kills, 1);
});

test('defaultSpawn marks only the children it starts through a shell', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-mark-')), 'codex.cmd');
  fs.writeFileSync(file, '@echo off\r\n');
  const children = [defaultSpawn(file, ['app-server', 'proxy']), defaultSpawn(process.execPath, ['-e', ''])];
  try {
    assert.deepEqual(children.map(spawnedThroughShell), [true, false]);
  } finally {
    await Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? undefined : new Promise((resolve) => c.once('exit', resolve)))));
  }
});

test('closing a connection ends the proxy stdin first, then its process tree, and settles when the kill does', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = (command, args) => (spawned = daemon.spawnFn(command, args));
  const killed: Array<{ child: ChildProcess; stdinEnded: boolean }> = [];
  let finish!: () => void;
  try {
    const conn = await connectProxy('codex', spawnFn, 5000, (child) => {
      killed.push({ child, stdinEnded: child.stdin?.writableEnded === true });
      child.kill();
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    let closed = false;
    const closing = conn.close().then(() => { closed = true; });
    assert.equal(killed.length, 1);
    assert.equal(killed[0].child, spawned);
    assert.equal(killed[0].stdinEnded, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    finish();
    await closing;
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
    await daemon.stop();
  }
});

test('closing a connection twice ends its process tree once', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  const killed: ChildProcess[] = [];
  try {
    const conn = await connectProxy('codex', (command, args) => (spawned = daemon.spawnFn(command, args)), 5000, async (child) => {
      killed.push(child);
      child.kill();
    });
    const first = conn.close();
    const second = conn.close();
    assert.equal(first, second);
    await second;
    assert.equal(killed.length, 1);
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
    await daemon.stop();
  }
});

test('a handshake timeout ends the proxy tree through the same function', async () => {
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (spawned = silentChild());
  const killed: ChildProcess[] = [];
  try {
    await assert.rejects(
      connectProxy('codex', spawnFn, 300, async (child) => {
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

test('a failed handshake is reported only once the proxy tree has been ended', async () => {
  let spawned: ChildProcess | undefined;
  let finish!: () => void;
  let rejected = false;
  try {
    const pending = connectProxy('codex', () => (spawned = silentChild()), 300, (child) => {
      child.kill();
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    pending.catch(() => { rejected = true; });
    await until(() => finish !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rejected, false);
    finish();
    await assert.rejects(pending, /^Error: codex daemon did not answer within 0.3s$/);
  } finally {
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
  }
});

test('the process tree is recorded right after the spawn, before any handshake, and again once the proxy answers', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  const tracked: ChildProcess[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const killer: KillTreeFn = async (child) => { child.kill(); };
  killer.track = (child) => { tracked.push(child); return pending; };
  try {
    const connecting = connectProxy('codex', (command, args) => (spawned = daemon.spawnFn(command, args)), 5000, killer);
    assert.deepEqual(tracked, [spawned]);
    const conn = await connecting;
    assert.deepEqual(tracked, [spawned, spawned]);
    await conn.close();
  } finally {
    finish();
    if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill();
    await daemon.stop();
  }
});

test('recordings taken at spawn and after the handshake are merged', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  const snapshots = [
    [row(4242, 1, 1), row(5001, 4242, 2)],
    [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)],
    [row(5001, 1, 2), row(5002, 5001, 3)],
  ];
  const killer = treeKiller('win32', run, async () => snapshots.shift()!, viaShell);
  await killer.track!(asChild(child));
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(runs, [taskkill(5002), taskkill(5001)]);
  assert.equal(child.kills, 0);
});

test('recorded descendants survive shell exit and only matching creation times are killed', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const query = async () => ++calls === 1
    ? [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3), row(5003, 4242, 2), row(6000, 1, 1)]
    : [row(4242, 1, 4), row(5001, 1, 4), row(5002, 1, 3), row(6000, 1, 1)];
  const killer = treeKiller('win32', run, query, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(runs, [taskkill(5002)]);
  assert.equal(child.kills, 0);
});

test('failed descendant queries are logged and record no processes', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { runs, run } = recorder();
  const killer = treeKiller('win32', run, async () => { throw new Error('query failed'); }, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('query failed')), true);
});

test('a snapshot finishing after shell exit is not recorded', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  const rows = [row(4242, 1, 1), row(5001, 4242, 2)];
  let calls = 0;
  let finish!: (rows: ProcessIdentity[]) => void;
  const killer = treeKiller('win32', run, () => ++calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(rows), viaShell);
  const pending = killer.track!(asChild(child));
  child.exitCode = 0;
  finish(rows);
  await pending;
  await killer(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(calls, 1);
});

test('a failed verification query leaves recorded descendants alone', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const killer = treeKiller('win32', run, async () => {
    if (++calls === 1) return [row(4242, 1, 1), row(5001, 4242, 2)];
    throw new Error('verification failed');
  }, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('verification failed')), true);
  assert.deepEqual(runs, []);
});

test('tracking on other platforms never queries processes', async () => {
  const child = fakeChild();
  let queried = false;
  const { run } = recorder();
  const killer = treeKiller('linux', run, async () => { queried = true; return []; }, viaShell);
  await killer.track!(asChild(child));
  await killer(asChild(child));
  assert.equal(queried, false);
  assert.equal(child.kills, 1);
});

test('older processes naming reused parent PIDs are left out of the recording at every level', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  const rows = [row(4242, 1, 2), row(5001, 4242, 1), row(5002, 5001, 4), row(5003, 4242, 3), row(5004, 5003, 2), row(5005, 5003, 3)];
  const killer = treeKiller('win32', run, async () => rows, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(runs, [taskkill(5005), taskkill(5003)]);
});

test('a snapshot missing the shell row records nothing', async () => {
  const child = fakeChild();
  const { runs, run } = recorder();
  let calls = 0;
  const killer = treeKiller('win32', run, async () => {
    calls++;
    return [row(5001, 4242, 3)];
  }, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(calls, 1);
});
