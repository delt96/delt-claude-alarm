import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exitAfterFlush, CLI_EXIT_FLUSH_MS } from '../src/codex/shutdown.js';
import { shutdownClock } from './helpers/shutdown-clock.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-run-shutdown.mjs', import.meta.url));

async function cliFixture(mode: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './test/isolate-home.ts', fixture, mode], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env } });
  let proxyPid: number | undefined;
  let stdout = '';
  let stderr = '';
  let daemonStopped = false;
  child.on('message', (m: any) => { proxyPid = m.pid; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!daemonStopped && stdout.includes('"threadId"') && child.connected) {
      daemonStopped = true;
      child.send('stop-daemon', () => {});
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end('Finish the fake task');
  let timer: ReturnType<typeof setTimeout>;
  try {
    const exited = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => child.once('exit', (code) => resolve({ code }))),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    return { exited, stdout, stderr };
  } finally {
    clearTimeout(timer!);
    child.kill();
    if (proxyPid !== undefined) { try { process.kill(proxyPid); } catch {} }
  }
}

test('codex run exits once the close has resolved, even while a surviving proxy still holds its pipes', async () => {
  const result = await cliFixture('survivor');
  assert.equal(JSON.parse(result.stdout).finalText, 'Finished', result.stderr);
  assert.notEqual(result.exited, null, 'CLI retained proxy pipe handles after its result was printed');
  assert.equal(result.exited?.code, 0);
});

test('codex run keeps a finished turn\'s result and exits when the proxy close never settles', { skip: process.platform !== 'win32' }, async () => {
  const result = await cliFixture('stuck');
  assert.equal(result.exited?.code, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.threadId, 'review-thread');
  assert.equal(output.turnId, 'review-turn');
  assert.equal(output.status, 'completed');
  assert.equal(output.finalText, 'Finished');
  assert.match(result.stderr, /warning: Codex proxy cleanup failed: Codex proxy cleanup timed out/);
  assert.deepEqual(output.approvals, []);
});

for (const code of [0, 1, 2]) {
  test(`CLI flushes both outputs before explicit exit ${code}`, async (t) => {
    const clock = shutdownClock(t);
    const callbacks: Array<() => void> = [];
    const stream = { write: (_text: string, callback: () => void) => { callbacks.push(callback); return true; } };
    const exits: number[] = [];
    exitAfterFlush(code, stream as any, stream as any, (value) => { exits.push(value); });
    assert.deepEqual(exits, []);
    callbacks[0]();
    assert.deepEqual(exits, []);
    callbacks[1]();
    assert.deepEqual(exits, [code]);
    await clock.tick(CLI_EXIT_FLUSH_MS);
    assert.deepEqual(exits, [code]);
    assert.equal(clock.pending(), 0);
  });
}

test('CLI bounds output flushing when a pipe never drains', async (t) => {
  const clock = shutdownClock(t);
  const exits: number[] = [];
  const stream = { write() { return false; } };
  exitAfterFlush(0, stream as any, stream as any, (code) => { exits.push(code); });
  await clock.tick(CLI_EXIT_FLUSH_MS - 1);
  assert.deepEqual(exits, []);
  await clock.tick(1);
  assert.deepEqual(exits, [0]);
});
