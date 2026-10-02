import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startStandaloneAdapter(): Promise<ChildProcess> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-main-ipc-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: await closedPort(), token: 'ipc-test' },
    notifications: { desktop: false, sound: false },
    webhooks: [],
    codex: { command: path.join(home, 'no-such-codex.exe') },
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_ALARM_HUB_HOST;
  delete env.CLAUDE_ALARM_HUB_PORT;
  delete env.CLAUDE_ALARM_HUB_TOKEN;
  return spawn(process.execPath, ['--import', 'tsx', path.join('src', 'codex', 'main.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function firstMessage(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no IPC message within 20s')), 20_000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`adapter exited (code ${code})`)); });
  });
}

test('a standalone adapter reports its first connection to the parent over IPC', async () => {
  const child = await startStandaloneAdapter();
  try {
    const message = await firstMessage(child);
    assert.equal(message.type, 'codex-first-connect');
    assert.equal(message.connected, false);
    assert.equal(message.notFound, true);
    assert.match(message.error, /ENOENT/);
  } finally {
    child.kill();
  }
});

test('the adapter keeps running after the parent closes the IPC channel', async () => {
  const child = await startStandaloneAdapter();
  try {
    await firstMessage(child);
    child.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill();
  }
});
