import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, defaultSpawn, endProcesses, processEnder, processQuery, queryProcesses, spawnedThroughShell, treeKiller, type KillTreeFn, type ProcessEndFn, type ProcessIdentity, type SpawnFn } from '../src/codex/transport.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

interface FakeChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kills: number;
  lingers: boolean;
  kill(): boolean;
  once(event: 'exit', listener: () => void): FakeChild;
  exit(): void;
}

function fakeChild(state: Partial<Pick<FakeChild, 'pid' | 'exitCode' | 'signalCode' | 'lingers'>> = {}, events?: string[]): FakeChild {
  const onExit: Array<() => void> = [];
  const child: FakeChild = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kills: 0,
    lingers: false,
    kill: () => {
      child.kills++;
      events?.push('shell');
      if (!child.lingers) child.exit();
      return true;
    },
    once: (_event, listener) => {
      onExit.push(listener);
      return child;
    },
    exit: () => {
      child.signalCode = 'SIGTERM';
      for (const listener of onExit.splice(0)) listener();
    },
    ...state,
  };
  return child;
}

function recorder(fail?: Error, events?: string[]) {
  const ends: ProcessIdentity[][] = [];
  const end: ProcessEndFn = async (targets) => {
    ends.push(targets);
    events?.push(...targets.map((t) => String(t.pid)));
    if (fail) throw fail;
  };
  return { ends, end };
}

// A process table whose processes end only through `end`, by identity, as the real one does.
function fakeSystem(rows: ProcessIdentity[]) {
  const running = [...rows];
  const ended: ProcessIdentity[] = [];
  const same = (a: ProcessIdentity, b: Pick<ProcessIdentity, 'pid' | 'creationTime'>) => a.pid === b.pid && a.creationTime === b.creationTime;
  const at = (pid: number) => {
    const i = running.findIndex((r) => r.pid === pid);
    assert.notEqual(i, -1, `no running process ${pid}`);
    return i;
  };
  const afterEnding: Array<{ process: ProcessIdentity; change: () => void }> = [];
  let pending: (() => void) | undefined;
  const settle = () => {
    const change = pending;
    pending = undefined;
    change?.();
  };
  const end: ProcessEndFn = async (targets) => {
    settle();
    for (const t of targets) {
      const i = running.findIndex((r) => same(r, t));
      if (i < 0) continue;
      const [gone] = running.splice(i, 1);
      ended.push(gone);
      afterEnding.find((a) => same(a.process, gone))?.change();
    }
  };
  return {
    ended,
    end,
    query: async () => {
      const seen = running.map((r) => ({ ...r }));
      settle();
      return seen;
    },
    exit: (pid: number) => { running.splice(at(pid), 1); },
    // The process holding this PID exits and Windows gives the PID to `next`.
    reuse: (next: ProcessIdentity) => { running.splice(at(next.pid), 1, next); },
    whenEnded: (process: ProcessIdentity, change: () => void) => { afterEnding.push({ process, change }); },
    // A change that lands at the worst moment: right after the next snapshot was taken, or before the next end.
    soon: (change: () => void) => { pending = change; },
    isRunning: (p: ProcessIdentity) => running.some((r) => same(r, p)),
  };
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;
const row = (pid: number, parentPid: number, second: number): ProcessIdentity => ({ pid, parentPid, creationTime: `2026-10-05T00:00:0${second}.0000000Z` });
const viaShell = () => true;
const direct = () => false;
const silentChild = () => spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' });
const CONSTRAINED = "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n";
// Whichever way the script asks for a termination, it is refused.
const REFUSED = "Update-TypeData -TypeName System.Diagnostics.Process -MemberType ScriptMethod -MemberName Kill -Value { throw 'refused' } -Force\nfunction Stop-Process { throw 'refused' }\n";

test('a wrapper that exits once its child is ended is not ended again after its PID goes to a new process', async () => {
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3), row(6000, 1, 1)]);
  const newcomer = row(5001, 1, 9);
  sys.whenEnded(row(5002, 5001, 3), () => sys.reuse(newcomer));
  const child = fakeChild();
  await treeKiller('win32', sys.end, sys.query, viaShell)(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal(sys.isRunning(newcomer), true);
  assert.equal(child.kills, 1);
});

test('after the shell has exited, a recorded wrapper that exits once its child is ended is not ended again under a reused PID', async () => {
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)]);
  const newcomer = row(5001, 1, 9);
  sys.whenEnded(row(5002, 5001, 3), () => sys.reuse(newcomer));
  const child = fakeChild();
  const killer = treeKiller('win32', sys.end, sys.query, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  sys.exit(4242);
  await killer(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal(sys.isRunning(newcomer), true);
  assert.equal(child.kills, 0);
});

test('a recorded descendant whose PID goes to a new process after the shell has exited is never ended, whenever the PID changes hands', async () => {
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)]);
  const newcomer = row(5001, 1, 9);
  const child = fakeChild();
  const killer = treeKiller('win32', sys.end, sys.query, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  sys.exit(4242);
  sys.soon(() => sys.reuse(newcomer));
  await killer(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal(sys.isRunning(newcomer), true);
});

test('a live codex.cmd shell has its descendants ended by identity in one batch, then the shell itself', async () => {
  const events: string[] = [];
  const { ends, end } = recorder(undefined, events);
  const child = fakeChild({}, events);
  const rows = [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3), row(5003, 4242, 2), row(6000, 1, 1)];
  await treeKiller('win32', end, async () => rows, viaShell)(asChild(child));
  assert.deepEqual(ends, [[row(5002, 5001, 3), row(5001, 4242, 2), row(5003, 4242, 2)]]);
  assert.deepEqual(events, ['5002', '5001', '5003', 'shell']);
});

test('older processes that name the live shell PID as their parent are never ended, at any level', async () => {
  const { ends, end } = recorder();
  const child = fakeChild();
  const rows = [row(4242, 1, 3), row(5001, 4242, 1), row(5002, 4242, 4), row(5003, 5001, 5), row(5004, 5002, 2), row(5005, 5002, 5)];
  await treeKiller('win32', end, async () => rows, viaShell)(asChild(child));
  assert.deepEqual(ends, [[row(5005, 5002, 5), row(5002, 4242, 4)]]);
  assert.equal(child.kills, 1);
});

test('the kill settles only after the descendants have been ended and the shell has exited', async () => {
  let finish: (() => void) | undefined;
  const end: ProcessEndFn = () => new Promise((resolve) => { finish = resolve; });
  const child = fakeChild({ lingers: true });
  let settled = false;
  const killing = treeKiller('win32', end, async () => [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)], viaShell)(asChild(child))
    .then(() => { settled = true; });
  await until(() => finish !== undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.equal(child.kills, 0);
  finish!();
  await until(() => child.kills === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  child.exit();
  await killing;
});

test('a shell that has not exited soon after it is ended still lets the kill settle, with a debug log', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { end } = recorder();
  const child = fakeChild({ lingers: true });
  await treeKiller('win32', end, async () => [row(4242, 1, 1)], viaShell)(asChild(child));
  assert.equal(child.kills, 1);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('4242')), true);
});

test('a live shell also has its recorded descendants ended when its current tree no longer reaches them', async () => {
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)]);
  const child = fakeChild();
  const killer = treeKiller('win32', sys.end, sys.query, viaShell);
  await killer.track!(asChild(child));
  sys.exit(5001);
  await killer(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal(child.kills, 1);
});

test('a live shell whose snapshot fails at close still has its recorded descendants ended by identity', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)]);
  const newcomer = row(5001, 1, 9);
  const child = fakeChild();
  let failing = false;
  const killer = treeKiller('win32', sys.end, async () => { if (failing) throw new Error('query failed'); return sys.query(); }, viaShell);
  await killer.track!(asChild(child));
  sys.reuse(newcomer);
  failing = true;
  await killer(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal(sys.isRunning(newcomer), true);
  assert.equal(child.kills, 1);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('query failed')), true);
});

test('when the process snapshot fails, only the shell is ended and the failure is logged', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { ends, end } = recorder();
  const child = fakeChild();
  await treeKiller('win32', end, async () => { throw new Error('query failed'); }, viaShell)(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 1);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('query failed')), true);
});

test('a snapshot without the live shell row ends only the shell', async () => {
  const { ends, end } = recorder();
  const child = fakeChild();
  await treeKiller('win32', end, async () => [row(5001, 4242, 3)], viaShell)(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 1);
});

test('a shell that exits while the snapshot is taken is not matched against that snapshot', async () => {
  const { ends, end } = recorder();
  const child = fakeChild();
  const query = async () => {
    child.exitCode = 0;
    return [row(4242, 1, 5), row(5001, 4242, 6)];
  };
  await treeKiller('win32', end, query, viaShell)(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 0);
});

test('a codex.exe started without a shell is ended with child.kill() alone, even on Windows', async () => {
  const { ends, end } = recorder();
  const child = fakeChild();
  let queried = false;
  const killer = treeKiller('win32', end, async () => { queried = true; return []; }, direct);
  await killer.track!(asChild(child));
  await killer(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 1);
  assert.equal(queried, false);
});

test('elsewhere the proxy is ended with child.kill()', async () => {
  const { ends, end } = recorder();
  const child = fakeChild();
  await treeKiller('linux', end, async () => [], viaShell)(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 1);
});

test('a proxy that has already exited is left alone, since its pid may now belong to another process', async () => {
  const { ends, end } = recorder();
  for (const throughShell of [viaShell, direct]) {
    for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' as const }]) {
      const child = fakeChild(state);
      await treeKiller('win32', end, async () => [row(4242, 1, 1), row(5001, 4242, 2)], throughShell)(asChild(child));
      await treeKiller('linux', end, async () => [], throughShell)(asChild(child));
      assert.equal(child.kills, 0);
    }
  }
  assert.deepEqual(ends, []);
});

test('a proxy that never got a pid is ended with child.kill() even on Windows', async () => {
  const { ends, end } = recorder();
  const child = fakeChild({ pid: undefined });
  await treeKiller('win32', end, async () => [], viaShell)(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(child.kills, 1);
});

test('a failed end of the descendants is only logged, and the shell is still ended', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { end } = recorder(new Error('ending 5001 failed'));
  const child = fakeChild();
  await treeKiller('win32', end, async () => [row(4242, 1, 1), row(5001, 4242, 2)], viaShell)(asChild(child));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('5001')), true);
  assert.equal(child.kills, 1);
});

test('ending by identity leaves a process alone while its PID belongs to a process with another creation time', { skip: process.platform !== 'win32' }, async () => {
  const child = silentChild();
  try {
    const identity = await until(async () => (await queryProcesses()).find((r) => r.pid === child.pid), 5000);
    await endProcesses([{ ...identity, creationTime: '2000-01-01T00:00:00.0000000Z' }]);
    assert.equal((await queryProcesses()).some((r) => r.pid === identity.pid && r.creationTime === identity.creationTime), true);
    await endProcesses([identity]);
    await until(() => child.exitCode !== null || child.signalCode !== null, 2000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('ending a process that has already exited is only logged at debug level', { skip: process.platform !== 'win32' }, async (t) => {
  const child = silentChild();
  try {
    const identity = await until(async () => (await queryProcesses()).find((r) => r.pid === child.pid), 5000);
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 2000);
    const debug = t.mock.method(logger, 'debug');
    const warn = t.mock.method(logger, 'warn');
    const error = t.mock.method(logger, 'error');
    await endProcesses([identity]);
    assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes(String(identity.pid))), true);
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('once a target is proven ours, a refused termination is still followed by a wait for that process', { skip: process.platform !== 'win32' }, async (t) => {
  const child = silentChild();
  try {
    const identity = await until(async () => (await queryProcesses()).find((r) => r.pid === child.pid), 5000);
    const debug = t.mock.method(logger, 'debug');
    await processEnder(REFUSED)([identity]);
    const notes = debug.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(notes.includes(`codex process ${identity.pid} has not exited yet`), true, notes.join('\n'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('the creation time check and the termination go through the handle that was opened, not through the PID', { skip: process.platform !== 'win32' }, async () => {
  const opened = silentChild();
  const named = silentChild();
  try {
    const identity = await until(async () => (await queryProcesses()).find((r) => r.pid === opened.pid), 5000);
    // Get-Process hands back `opened` with its handle already open, but reporting the PID of `named`, as if that PID had changed hands.
    const swapped = [
      'function Get-Process { [CmdletBinding()] param($Id)',
      `  $p = [Diagnostics.Process]::GetProcessById(${opened.pid}); $null = $p.Handle`,
      "  [Diagnostics.Process].GetField('processId', [Reflection.BindingFlags]'NonPublic,Instance').SetValue($p, $Id); $p }",
      '',
    ].join('\n');
    await processEnder(swapped)([{ ...identity, pid: named.pid! }]);
    await until(() => opened.exitCode !== null || opened.signalCode !== null, 2000);
    assert.equal(named.exitCode === null && named.signalCode === null, true);
  } finally {
    for (const c of [opened, named]) if (c.exitCode === null && c.signalCode === null) c.kill();
  }
});

test('under Constrained Language Mode the process snapshot still works', { skip: process.platform !== 'win32' }, async () => {
  const rows = await processQuery(CONSTRAINED)();
  assert.equal(rows.some((r) => r.pid === process.pid && r.parentPid === process.ppid), true);
});

test('under Constrained Language Mode processes are still ended by identity, and only by identity', { skip: process.platform !== 'win32' }, async () => {
  const child = silentChild();
  try {
    const identity = await until(async () => (await queryProcesses()).find((r) => r.pid === child.pid), 5000);
    const end = processEnder(CONSTRAINED);
    await end([{ ...identity, creationTime: '2000-01-01T00:00:00.0000000Z' }]);
    assert.equal((await queryProcesses()).some((r) => r.pid === identity.pid && r.creationTime === identity.creationTime), true);
    await end([identity]);
    await until(() => child.exitCode !== null || child.signalCode !== null, 2000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('a target whose ending runs past the time limit does not keep the others from being ended, and only by identity', { skip: process.platform !== 'win32' }, async (t) => {
  const children = Array.from({ length: 4 }, silentChild);
  const [stuck, first, second, other] = children;
  const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
  try {
    const [stuckId, firstId, secondId, otherId] = await until(async () => {
      const rows = await queryProcesses();
      const found = children.map((c) => rows.find((r) => r.pid === c.pid));
      return found.every(Boolean) && (found as ProcessIdentity[]);
    }, 5000);
    // Stop-Process never returns for `stuck`, so its turn runs into the PowerShell time limit.
    const stalling = `function Stop-Process { [CmdletBinding()] param($InputObject, [switch]$Force) if ($InputObject.Id -eq ${stuck.pid}) { Start-Sleep 30 } else { Microsoft.PowerShell.Management\\Stop-Process -InputObject $InputObject -Force } }\n`;
    const debug = t.mock.method(logger, 'debug');
    const started = Date.now();
    const outcome = await processEnder(stalling)([stuckId, firstId, secondId, { ...otherId, creationTime: '2000-01-01T00:00:00.0000000Z' }])
      .then(() => 'settled', () => 'rejected');
    const elapsed = Date.now() - started;
    await until(() => exited(first) && exited(second), 2000);
    assert.deepEqual([exited(stuck), exited(other), outcome], [false, false, 'settled']);
    assert.equal(elapsed < 8000, true, `took ${elapsed} ms`);
    assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes(`${stuck.pid} failed: timed out`)), true);
  } finally {
    for (const c of children) if (!exited(c)) c.kill();
  }
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
  const { ends, end } = recorder();
  const snapshots = [
    [row(4242, 1, 1), row(5001, 4242, 2)],
    [row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3)],
  ];
  const killer = treeKiller('win32', end, async () => snapshots.shift()!, viaShell);
  await killer.track!(asChild(child));
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(ends, [[row(5002, 5001, 3), row(5001, 4242, 2)]]);
  assert.equal(child.kills, 0);
});

test('recorded descendants survive shell exit and only matching creation times are killed', async () => {
  const child = fakeChild();
  const sys = fakeSystem([row(4242, 1, 1), row(5001, 4242, 2), row(5002, 5001, 3), row(5003, 4242, 2), row(6000, 1, 1)]);
  const killer = treeKiller('win32', sys.end, sys.query, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  sys.reuse(row(4242, 1, 4));
  sys.reuse(row(5001, 1, 4));
  sys.exit(5003);
  await killer(asChild(child));
  assert.deepEqual(sys.ended, [row(5002, 5001, 3)]);
  assert.equal([row(4242, 1, 4), row(5001, 1, 4), row(6000, 1, 1)].every(sys.isRunning), true);
  assert.equal(child.kills, 0);
});

test('failed descendant queries are logged and record no processes', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { ends, end } = recorder();
  const killer = treeKiller('win32', end, async () => { throw new Error('query failed'); }, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('query failed')), true);
});

test('a snapshot finishing after shell exit is not recorded', async () => {
  const child = fakeChild();
  const { ends, end } = recorder();
  const rows = [row(4242, 1, 1), row(5001, 4242, 2)];
  let calls = 0;
  let finish!: (rows: ProcessIdentity[]) => void;
  const killer = treeKiller('win32', end, () => ++calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(rows), viaShell);
  const pending = killer.track!(asChild(child));
  child.exitCode = 0;
  finish(rows);
  await pending;
  await killer(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(calls, 1);
});

test('after the shell has exited, a failed end of the recorded descendants is only logged', async (t) => {
  const debug = t.mock.method(logger, 'debug');
  const child = fakeChild();
  const { ends, end } = recorder(new Error('verification failed'));
  const killer = treeKiller('win32', end, async () => [row(4242, 1, 1), row(5001, 4242, 2)], viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('verification failed')), true);
  assert.deepEqual(ends, [[row(5001, 4242, 2)]]);
  assert.equal(child.kills, 0);
});

test('tracking on other platforms never queries processes', async () => {
  const child = fakeChild();
  let queried = false;
  const { end } = recorder();
  const killer = treeKiller('linux', end, async () => { queried = true; return []; }, viaShell);
  await killer.track!(asChild(child));
  await killer(asChild(child));
  assert.equal(queried, false);
  assert.equal(child.kills, 1);
});

test('older processes naming reused parent PIDs are left out of the recording at every level', async () => {
  const child = fakeChild();
  const { ends, end } = recorder();
  const rows = [row(4242, 1, 2), row(5001, 4242, 1), row(5002, 5001, 4), row(5003, 4242, 3), row(5004, 5003, 2), row(5005, 5003, 3)];
  const killer = treeKiller('win32', end, async () => rows, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(ends, [[row(5005, 5003, 3), row(5003, 4242, 3)]]);
});

test('a snapshot missing the shell row records nothing', async () => {
  const child = fakeChild();
  const { ends, end } = recorder();
  let calls = 0;
  const killer = treeKiller('win32', end, async () => {
    calls++;
    return [row(5001, 4242, 3)];
  }, viaShell);
  await killer.track!(asChild(child));
  child.exitCode = 0;
  await killer(asChild(child));
  assert.deepEqual(ends, []);
  assert.equal(calls, 1);
});
