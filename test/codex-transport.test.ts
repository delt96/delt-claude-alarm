import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connectProxy, findCodex, findOnPath, resolveCommand, type SpawnFn } from '../src/codex/transport.js';
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

test('findOnPath tells whether codex is installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  assert.equal(findOnPath('codex', process.platform, { PATH: dir }), undefined);
  fs.writeFileSync(path.join(dir, name), '');
  assert.equal(findOnPath('codex', process.platform, { PATH: dir }), path.join(dir, name));
});

test('resolveCommand leaves explicit paths and other platforms alone', () => {
  assert.deepEqual(resolveCommand('C:/tools/codex.exe', 'win32', { PATH: '' }), { file: 'C:/tools/codex.exe', shell: false });
  assert.deepEqual(resolveCommand('codex', 'linux', { PATH: '/usr/bin' }), { file: 'codex', shell: false });
});

function winInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-find-'));
  const env = { PATH: path.join(root, 'path'), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') };
  const put = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  return {
    env,
    put,
    standalone: path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    npm: path.join(env.APPDATA, 'npm', 'codex.cmd'),
    onPath: (name: string) => path.join(env.PATH, name),
  };
}

test('findCodex looks in the standalone install when codex is not on PATH', () => {
  const w = winInstall();
  w.put(w.standalone);
  assert.equal(findCodex('codex', 'win32', w.env), w.standalone);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: w.standalone, shell: false });
});

test('findCodex falls back to the npm global shim, which runs through a shell', () => {
  const w = winInstall();
  w.put(w.npm);
  assert.equal(findCodex('codex', 'win32', w.env), w.npm);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: w.npm, shell: true });
});

test('findCodex prefers the standalone install over the npm shim', () => {
  const w = winInstall();
  w.put(w.standalone);
  w.put(w.npm);
  assert.equal(findCodex('codex', 'win32', w.env), w.standalone);
});

test('codex on PATH wins over the standard install locations', () => {
  const w = winInstall();
  w.put(w.standalone);
  const shim = w.put(w.onPath('codex.cmd'));
  assert.equal(findCodex('codex', 'win32', w.env), shim);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: shim, shell: true });
});

test('codex is nowhere: findCodex returns undefined and resolveCommand keeps the bare name', () => {
  const w = winInstall();
  assert.equal(findCodex('codex', 'win32', w.env), undefined);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: 'codex', shell: false });
  assert.equal(findCodex('codex', 'win32', { PATH: '' }), undefined);
});

test('findCodex looks only on PATH outside Windows', () => {
  const w = winInstall();
  w.put(w.standalone);
  w.put(w.npm);
  assert.equal(findCodex('codex', 'linux', w.env), undefined);
});
