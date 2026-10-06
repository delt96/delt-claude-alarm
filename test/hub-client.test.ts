// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HubServer } from '../src/hub/server.js';
import { HubClient } from '../src/channel/hub-client.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7993;
const TOKEN = 'client-test';
const config = { hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any;
let hub: HubServer;

before(async () => { hub = new HubServer(config); await hub.start(); });
after(async () => { await hub.stop(); });

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

async function sessionsOrEmpty(): Promise<any[]> {
  try { return await sessions(); } catch { return []; }
}

test('registration extras are sent and can be refreshed', async () => {
  let title = 'First';
  const client = new HubClient('x1', 'x1', '127.0.0.1', PORT, TOKEN, () => undefined, () => ({ agentKind: 'codex', title, cwd: 'C:\\w\\proj', status: 'working' }));
  client.connect();
  try {
    const first = await until(async () => (await sessions()).find((s) => s.id === 'x1'));
    assert.equal(first.agentKind, 'codex');
    assert.equal(first.displayName, 'First');
    assert.equal(first.cwd, 'C:\\w\\proj');
    assert.equal(first.status, 'working');
    title = 'Second';
    client.reregister();
    await until(async () => (await sessions()).find((s) => s.id === 'x1' && s.displayName === 'Second'));
  } finally {
    client.disconnect();
  }
});

test('disconnect does not schedule a reconnect', async () => {
  const client = new HubClient('x2', 'x2', '127.0.0.1', PORT, TOKEN);
  client.connect();
  await until(async () => (await sessions()).find((s) => s.id === 'x2'));
  client.disconnect();
  await until(async () => !(await sessions()).some((s) => s.id === 'x2'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((client as any).reconnectTimer, null);
});

test('a hub restart re-registers the session with its extras', async () => {
  const client = new HubClient('x3', 'x3', '127.0.0.1', PORT, TOKEN, () => undefined, () => ({ title: 'Kept' }));
  client.connect();
  try {
    await until(async () => (await sessions()).find((s) => s.id === 'x3'));
    await hub.stop();
    hub = new HubServer(config);
    await hub.start();
    const back = await until(async () => (await sessionsOrEmpty()).find((s) => s.id === 'x3'), 9000);
    assert.equal(back.displayName, 'Kept');
  } finally {
    client.disconnect();
  }
});

test('reconnecting right after disconnect leaves no stale reconnect', async () => {
  const client = new HubClient('x4', 'x4', '127.0.0.1', PORT, TOKEN);
  client.connect();
  try {
    await until(async () => (await sessions()).find((s) => s.id === 'x4'));
    client.disconnect();
    client.connect();
    await until(async () => (await sessions()).find((s) => s.id === 'x4'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((client as any).reconnectTimer, null);
    assert.equal((client as any).connected, true);
  } finally {
    client.disconnect();
  }
});

test('send reports whether a message went out, was queued, or was dropped because the queue is full', () => {
  const client = new HubClient('x9', 'x9', '127.0.0.1', PORT, TOKEN);
  const msg = { type: 'status', sessionId: 'x9', status: 'idle' } as const;
  for (let i = 0; i < 100; i++) assert.equal(client.send(msg), 'queued');
  assert.equal(client.send(msg), 'dropped');
});
