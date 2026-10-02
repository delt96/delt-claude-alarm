import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { controlEndpoint, queryOwner, requestStop } from '../src/codex/instance-lock.js';
import { until } from './helpers/fake-codex-daemon.js';

const TOKEN = 'lock-test';

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function makeHome(): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-main-lock-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: await closedPort(), token: TOKEN },
    notifications: { desktop: false, sound: false },
    webhooks: [],
    codex: { command: path.join(home, 'no-such-codex.exe') },
  }));
  return home;
}

const endpointOf = (home: string) => controlEndpoint(path.join(home, '.claude-alarm'));

function adapterIn(home: string, supervised = false): { child: ChildProcess; inbox: any[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_ALARM_HUB_HOST;
  delete env.CLAUDE_ALARM_HUB_PORT;
  delete env.CLAUDE_ALARM_HUB_TOKEN;
  const args = ['--import', 'tsx', path.join('src', 'codex', 'main.ts'), ...(supervised ? ['--watch-stdin'] : [])];
  const child = spawn(process.execPath, args, { env, stdio: [supervised ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout?.resume();
  child.stderr?.resume();
  const inbox: any[] = [];
  child.on('message', (m) => inbox.push(m));
  return { child, inbox };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('of two adapters started at once, one runs and the other reports it and exits 0', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  const b = adapterIn(home);
  try {
    const loser = await until(() => [a, b].find((x) => x.inbox.some((m) => m.type === 'codex-already-running')), 30_000);
    const winner = loser === a ? b : a;
    assert.equal(await exited(loser.child), 0);
    assert.equal(loser.inbox.find((m) => m.type === 'codex-already-running').pid, winner.child.pid);
    assert.deepEqual(await queryOwner(endpointOf(home)), { state: 'running', pid: winner.child.pid });
    assert.equal(fs.existsSync(path.join(home, '.claude-alarm', 'codex.pid')), false);
  } finally {
    a.child.kill();
    b.child.kill();
  }
});

test('an adapter started by the hub waits while another runs and takes over when it stops', { timeout: 90_000 }, async () => {
  const home = await makeHome();
  const endpoint = endpointOf(home);
  const a = adapterIn(home);
  let b: ReturnType<typeof adapterIn> | undefined;
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    b = adapterIn(home, true);
    await sleep(3000);
    assert.equal(b.child.exitCode, null);
    assert.deepEqual(await queryOwner(endpoint), { state: 'running', pid: a.child.pid });
    assert.deepEqual(await requestStop(endpoint, TOKEN), { state: 'stopping', pid: a.child.pid });
    assert.equal(await exited(a.child), 0);
    const pidB = b.child.pid;
    await until(async () => {
      const o = await queryOwner(endpoint);
      return o.state === 'running' && o.pid === pidB;
    }, 45_000);
  } finally {
    a.child.kill();
    b?.child.kill();
  }
});

test('a waiting adapter exits when the hub closes its stdin', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  let b: ReturnType<typeof adapterIn> | undefined;
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    b = adapterIn(home, true);
    await sleep(2500);
    assert.equal(b.child.exitCode, null);
    b.child.stdin!.end();
    assert.equal(await exited(b.child), 0);
  } finally {
    a.child.kill();
    b?.child.kill();
  }
});

test('a stop request with the wrong token leaves the adapter running', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    assert.deepEqual(await requestStop(endpointOf(home), 'wrong'), { state: 'unauthorized' });
    await sleep(500);
    assert.equal(a.child.exitCode, null);
  } finally {
    a.child.kill();
  }
});
