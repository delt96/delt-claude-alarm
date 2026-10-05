import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, defaultSpawn, treeKiller, findCodex, findOnPath, resolveCommand, type KillTreeFn, type SpawnFn } from '../src/codex/transport.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

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
  assert.deepEqual(resolveCommand('/opt/codex.cmd', 'linux', { PATH: '' }), { file: '/opt/codex.cmd', shell: false });
});

test('an explicit .cmd or .bat path runs through a shell', () => {
  assert.deepEqual(resolveCommand('C:\\tools\\codex.cmd', 'win32', { PATH: '' }), { file: 'C:\\tools\\codex.cmd', shell: true });
  assert.deepEqual(resolveCommand('D:/x/Codex.BAT', 'win32', { PATH: '' }), { file: 'D:/x/Codex.BAT', shell: true });
  assert.deepEqual(resolveCommand('codex.cmd', 'win32', { PATH: '' }), { file: 'codex.cmd', shell: true });
});

test('an explicit .cmd path in a folder with spaces really runs', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cmd-')), 'with space');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'fake codex.cmd');
  fs.writeFileSync(file, '@echo ran %1 %2\r\n');
  const child = defaultSpawn(file, ['app-server', 'proxy']);
  let output = '';
  child.stdout?.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /ran app-server proxy/);
});

test('connectProxy gives up on a daemon that never answers the handshake, and stops the proxy', async () => {
  let child: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' }));
  const started = Date.now();
  await assert.rejects(connectProxy('codex', spawnFn, 300), /^Error: codex daemon did not answer within 0.3s$/);
  assert.ok(Date.now() - started < 3000);
  await until(() => child!.exitCode !== null || child!.signalCode !== null);
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

const FAKE_PROXY = fileURLToPath(new URL('./fixtures/fake-codex-proxy.mjs', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | undefined {
  try {
    return Number(fs.readFileSync(file, 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}

function fakeCodexCmd(script: string, env: Record<string, string> = {}): { cmd: string; pidFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tree-'));
  const pidFile = path.join(dir, 'proxy.pid');
  const sets = Object.entries({ ...env, FAKE_CODEX_PID_FILE: pidFile }).map(([k, v]) => `set "${k}=${v}"`);
  const cmd = path.join(dir, 'codex.cmd');
  fs.writeFileSync(cmd, ['@echo off', ...sets, `"${process.execPath}" "${script}" %*`, ''].join('\r\n'));
  return { cmd, pidFile };
}

function silentProxy(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-silent-')), 'silent-proxy.mjs');
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  return file;
}

// Only what this test started, by the pid the proxy wrote and by our own handle; never by image name.
function stopLeftovers(proxy: { pid?: number; stopped?: boolean }, shell: ChildProcess | undefined, pidFile: string): void {
  if (!proxy.stopped && proxy.pid === undefined) proxy.pid = readPid(pidFile);
  if (proxy.pid !== undefined && alive(proxy.pid)) process.kill(proxy.pid);
  if (shell && shell.exitCode === null && shell.signalCode === null) shell.kill();
}

test('a codex.cmd proxy that never answers is ended with its shell at the handshake timeout', { skip: process.platform !== 'win32' }, async () => {
  const { cmd, pidFile } = fakeCodexCmd(silentProxy());
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number; stopped?: boolean } = {};
  try {
    const pending = connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 5000);
    pending.catch(() => {});
    proxy.pid = await until(() => readPid(pidFile), 5000);
    assert.notEqual(proxy.pid, shell!.pid);
    assert.equal(alive(proxy.pid), true);
    await assert.rejects(pending, /^Error: codex daemon did not answer within 5s$/);
    await until(() => !alive(proxy.pid!), 5000);
    // Seen gone: Windows may reuse the pid, so the cleanup must not touch it any more.
    proxy.pid = undefined;
    proxy.stopped = true;
  } finally {
    stopLeftovers(proxy, shell, pidFile);
  }
});

test('closing a connection to a codex.cmd proxy also ends the proxy under the shell', { skip: process.platform !== 'win32' }, async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const { cmd, pidFile } = fakeCodexCmd(FAKE_PROXY, { FAKE_CODEX_CONTROL: daemon.url, FAKE_CODEX_LINGER: '1' });
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number; stopped?: boolean } = {};
  try {
    const conn = await connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 10_000);
    proxy.pid = await until(() => readPid(pidFile), 5000);
    assert.equal(alive(proxy.pid), true);
    conn.close();
    await until(() => !alive(proxy.pid!), 5000);
    // Seen gone: Windows may reuse the pid, so the cleanup must not touch it any more.
    proxy.pid = undefined;
    proxy.stopped = true;
    await until(() => shell!.exitCode !== null || shell!.signalCode !== null, 5000);
  } finally {
    stopLeftovers(proxy, shell, pidFile);
    await daemon.stop();
  }
});

test('closing a connection whose shell has exited still ends the proxy that outlived it', { skip: process.platform !== 'win32' }, async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const { cmd, pidFile } = fakeCodexCmd(FAKE_PROXY, { FAKE_CODEX_CONTROL: daemon.url, FAKE_CODEX_LINGER: '1' });
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number; stopped?: boolean } = {};
  const killer = treeKiller();
  try {
    const conn = await connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 10_000, killer);
    proxy.pid = await until(() => readPid(pidFile), 5000);
    assert.equal(alive(proxy.pid), true);
    await killer.track!(shell!);
    shell!.kill();
    await until(() => shell!.exitCode !== null || shell!.signalCode !== null, 5000);
    assert.equal(alive(proxy.pid), true);
    conn.close();
    await until(() => !alive(proxy.pid!), 10_000);
    proxy.pid = undefined;
    proxy.stopped = true;
  } finally {
    stopLeftovers(proxy, shell, pidFile);
    await daemon.stop();
  }
});

test('a shell that exits before the handshake still has its proxy ended', { skip: process.platform !== 'win32' }, async () => {
  const { cmd, pidFile } = fakeCodexCmd(silentProxy());
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number; stopped?: boolean } = {};
  const real = treeKiller();
  const recordings: Array<Promise<void> | undefined> = [];
  const killer: KillTreeFn = Object.assign((child: ChildProcess) => real(child), {
    track: (child: ChildProcess) => {
      const recording = real.track?.(child);
      recordings.push(recording);
      return recording ?? Promise.resolve();
    },
  });
  try {
    const pending = connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 20_000, killer);
    pending.catch(() => {});
    proxy.pid = await until(() => readPid(pidFile), 5000);
    await Promise.all(recordings);
    shell!.kill();
    await assert.rejects(pending, /^Error: codex proxy exited/);
    await until(() => !alive(proxy.pid!), 10_000);
    proxy.pid = undefined;
    proxy.stopped = true;
  } finally {
    stopLeftovers(proxy, shell, pidFile);
  }
});

const TRANSPORT = new URL('../src/codex/transport.ts', import.meta.url).href;

test('a process that closes a codex.cmd proxy and exits right after leaves no proxy behind', { skip: process.platform !== 'win32' }, async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const { cmd, pidFile } = fakeCodexCmd(FAKE_PROXY, { FAKE_CODEX_CONTROL: daemon.url, FAKE_CODEX_LINGER: '1' });
  const script = path.join(path.dirname(pidFile), 'close-and-exit.mjs');
  fs.writeFileSync(script, [
    `import { connectProxy } from ${JSON.stringify(TRANSPORT)};`,
    'const conn = await connectProxy(process.argv[2]);',
    'await conn.close();',
    'process.exit(0);',
  ].join('\n'));
  let runner: ChildProcess | undefined;
  const proxy: { pid?: number; stopped?: boolean } = {};
  try {
    runner = spawn(process.execPath, ['--import', 'tsx', script, cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    runner.stdout?.on('data', (d) => { output += d; });
    runner.stderr?.on('data', (d) => { output += d; });
    const code = await new Promise((resolve) => runner!.once('exit', resolve));
    assert.equal(code, 0, output);
    proxy.pid = readPid(pidFile);
    assert.notEqual(proxy.pid, undefined);
    await until(() => !alive(proxy.pid!), 3000);
    proxy.pid = undefined;
    proxy.stopped = true;
  } finally {
    stopLeftovers(proxy, runner, pidFile);
    await daemon.stop();
  }
});
