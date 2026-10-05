import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, treeKiller, type RunFn, type SpawnFn } from '../src/codex/transport.js';
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
    await daemon.stop();
  }
});

test('a handshake timeout ends the proxy tree through the same function', async () => {
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (spawned = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' }));
  const killed: ChildProcess[] = [];
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
});
