import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connectProxy, resolveCommand, type SpawnFn } from '../src/codex/transport.js';
import { FakeDaemon } from './helpers/fake-codex-daemon.js';

test('connectProxy speaks WebSocket over the proxy stdio', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const conn = await connectProxy('codex', daemon.spawnFn);
  try {
    const reply = new Promise<string>((resolve) => conn.ws.once('message', (d) => resolve(String(d))));
    conn.ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
    assert.equal(JSON.parse(await reply).result.userAgent, 'fake-codex/0');
    assert.deepEqual(daemon.calls('initialize').length, 1);
  } finally {
    conn.close();
    await daemon.stop();
  }
});

test('connectProxy rejects when the proxy exits before the handshake', async () => {
  const spawnFn: SpawnFn = () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
  await assert.rejects(connectProxy('codex', spawnFn));
});

test('connectProxy rejects when the command does not exist', async () => {
  await assert.rejects(connectProxy('claude-alarm-no-such-codex-binary'));
});

test('resolveCommand prefers codex.exe and falls back to the npm codex.cmd shim', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  assert.deepEqual(resolveCommand('codex', 'win32', { PATH: dir }), { file: path.join(dir, 'codex.cmd'), shell: true });
  fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  assert.deepEqual(resolveCommand('codex', 'win32', { PATH: dir }), { file: path.join(dir, 'codex.exe'), shell: false });
});

test('resolveCommand leaves explicit paths and other platforms alone', () => {
  assert.deepEqual(resolveCommand('C:/tools/codex.exe', 'win32', { PATH: '' }), { file: 'C:/tools/codex.exe', shell: false });
  assert.deepEqual(resolveCommand('codex', 'linux', { PATH: '/usr/bin' }), { file: 'codex', shell: false });
});
