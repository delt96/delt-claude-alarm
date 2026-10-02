import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { waitForHub } from '../src/hub/readiness.js';

const alive = () => true;

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api/status`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('ready when the hub answers with the pid that was started', async () => {
  const hub = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: 'Unauthorized' });
    json(res, 200, { running: true, pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, token: 'tok', pid: 4242, isAlive: alive, timeoutMs: 2000, intervalMs: 50 }), 'ready');
  } finally {
    await hub.close();
  }
});

test('a hub that answers only after a few tries is still ready', async () => {
  let calls = 0;
  const hub = await serve((_req, res) => {
    calls += 1;
    if (calls < 3) return json(res, 503, {});
    json(res, 200, { pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: alive, timeoutMs: 2000, intervalMs: 50 }), 'ready');
    assert.ok(calls >= 3);
  } finally {
    await hub.close();
  }
});

test('another process answering on the port is not the hub that was started', async () => {
  const hub = await serve((_req, res) => json(res, 200, { pid: 999 }));
  try {
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  } finally {
    await hub.close();
  }
});

test('a wrong token never counts as ready', async () => {
  const hub = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: 'Unauthorized' });
    json(res, 200, { pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, token: 'nope', pid: 4242, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  } finally {
    await hub.close();
  }
});

test('nothing listening times out after the given time', async () => {
  const hub = await serve((_req, res) => json(res, 200, {}));
  const url = hub.url;
  await hub.close();
  const started = Date.now();
  assert.equal(await waitForHub({ url, pid: 1, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  assert.ok(Date.now() - started >= 350);
});

test('a server that never responds still times out on schedule', async () => {
  const hub = await serve(() => {});
  try {
    const started = Date.now();
    assert.equal(await waitForHub({ url: hub.url, pid: 1, isAlive: alive, timeoutMs: 500, intervalMs: 50 }), 'timeout');
    assert.ok(Date.now() - started < 1500);
  } finally {
    await hub.close();
  }
});

test('stops waiting as soon as the process has exited', async () => {
  const hub = await serve((_req, res) => json(res, 200, { pid: 999 }));
  try {
    let checks = 0;
    const started = Date.now();
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: () => ++checks < 3, timeoutMs: 5000, intervalMs: 50 }), 'exited');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await hub.close();
  }
});

test('the hub module run directly starts a hub that answers with its own pid', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-direct-hub-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: 7990, token: 'direct-tok' },
    notifications: { desktop: false, sound: false },
    webhooks: [],
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'hub', 'server.ts')], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'ignore',
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  try {
    const startup = await waitForHub({
      url: 'http://127.0.0.1:7990/api/status',
      token: 'direct-tok',
      pid: child.pid!,
      isAlive: () => !exited,
      timeoutMs: 15_000,
    });
    assert.equal(startup, 'ready');
  } finally {
    if (!exited) child.kill();
    await exit;
  }
});
