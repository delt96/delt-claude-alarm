// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7980;
const TOKEN = 'codex-hub-test';
const BASE = `http://127.0.0.1:${PORT}`;
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any, { codexCallTimeoutMs: 300 });
  await hub.start();
});
after(async () => { await hub.stop(); });

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

const latestAdapters = (inbox: any[]): any[] | undefined => inbox.filter((m) => m.type === 'codex_adapters').at(-1)?.adapters;

async function adapterLink(id: string, ready = true, host = 'pc-1') {
  const link = await open('/ws/codex');
  link.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id, host, ready } }));
  return link;
}

async function waitAdapter(id: string, present = true): Promise<void> {
  const dash = await open('/ws/dashboard');
  try {
    await until(() => {
      const list = latestAdapters(dash.inbox);
      return list !== undefined && list.some((a) => a.id === id) === present;
    });
  } finally {
    dash.ws.close();
  }
}

const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', () => r())));

test('adapters that say hello are listed for dashboards, after the pending permissions', async () => {
  const dash = await open('/ws/dashboard');
  const link = await adapterLink('a1');
  try {
    const list = await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a1') && latestAdapters(dash.inbox));
    assert.deepEqual(list, [{ id: 'a1', host: 'pc-1', ready: true, isLocal: true }]);
    const late = await open('/ws/dashboard');
    try {
      const first = await until(() => latestAdapters(late.inbox));
      assert.deepEqual(first, [{ id: 'a1', host: 'pc-1', ready: true, isLocal: true }]);
      const types = late.inbox.map((m) => m.type);
      assert.equal(types.indexOf('codex_adapters'), types.indexOf('permission_pending') + 1);
    } finally {
      late.ws.close();
    }
  } finally {
    link.ws.close();
    dash.ws.close();
  }
  await waitAdapter('a1', false);
});

test('a new ready state updates the list and disconnecting removes the adapter', async () => {
  const dash = await open('/ws/dashboard');
  const link = await adapterLink('a2', false);
  try {
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a2' && a.ready === false));
    link.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id: 'a2', host: 'pc-1', ready: true } }));
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a2' && a.ready === true));
    link.ws.close();
    await until(() => latestAdapters(dash.inbox)?.every((a) => a.id !== 'a2'));
  } finally {
    dash.ws.close();
  }
});

test('a connection cannot switch adapter ids, and a reconnect with the same id replaces the old one', async () => {
  const dash = await open('/ws/dashboard');
  const first = await adapterLink('a3');
  try {
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a3'));
    first.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id: 'other', host: 'pc-1', ready: true } }));
    const second = await adapterLink('a3', true, 'pc-2');
    await closed(first.ws);
    const list = await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a3' && a.host === 'pc-2') && latestAdapters(dash.inbox));
    assert.ok(!list!.some((a) => a.id === 'other'));
    second.ws.close();
    await until(() => latestAdapters(dash.inbox)?.every((a) => a.id !== 'a3'));
  } finally {
    dash.ws.close();
  }
});

test('non-object JSON frames do not prevent an adapter from registering on the same socket', async () => {
  const dash = await open('/ws/dashboard');
  const link = await open('/ws/codex');
  try {
    link.ws.send('null');
    link.ws.send('1');
    link.ws.send('"x"');
    link.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id: 'a4', host: 'pc-1', ready: true } }));
    const adapter = await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a4'));
    assert.deepEqual(adapter, { id: 'a4', host: 'pc-1', ready: true, isLocal: true });
    assert.equal(link.ws.readyState, WebSocket.OPEN);
  } finally {
    link.ws.close();
    dash.ws.close();
  }
  await waitAdapter('a4', false);
});

test('the codex socket needs the hub token', async () => {
  const outcome = await new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/codex`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
  assert.equal(outcome, 401);
});
const json = { 'Content-Type': 'application/json' };
const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${BASE}${path}`, { headers: auth });

function answer(link: { ws: WebSocket }, reply: (call: any) => object | undefined) {
  link.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'adapter_call') return;
    const body = reply(m.call);
    if (body) link.ws.send(JSON.stringify({ type: 'adapter_result', requestId: m.requestId, ...body }));
  });
}

test('creating a conversation is routed to the chosen adapter and answers with its session id', async () => {
  const link = await adapterLink('b1');
  await waitAdapter('b1');
  answer(link, () => ({ ok: true, data: { sessionId: 'codex:new-1' } }));
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b1', cwd: 'C:\\work' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sessionId: 'codex:new-1' });
    const call = link.inbox.find((m) => m.type === 'adapter_call');
    assert.deepEqual(call.call, { kind: 'create', cwd: 'C:\\work' });
    assert.equal(typeof call.requestId, 'string');
  } finally {
    link.ws.close();
  }
});

test('recent folders are fetched from the adapter', async () => {
  const link = await adapterLink('b2');
  await waitAdapter('b2');
  answer(link, (call) => (call.kind === 'folders' ? { ok: true, data: { folders: ['C:\\a', 'C:\\b'] } } : undefined));
  try {
    const res = await get('/api/codex/folders?adapterId=b2');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { folders: ['C:\\a', 'C:\\b'] });
  } finally {
    link.ws.close();
  }
});

test('an adapter error becomes 422 with the adapter message', async () => {
  const link = await adapterLink('b3');
  await waitAdapter('b3');
  answer(link, () => ({ ok: false, error: 'Folder not found on pc-1: C:\\nope' }));
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b3', cwd: 'C:\\nope' });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'Folder not found on pc-1: C:\\nope' });
  } finally {
    link.ws.close();
  }
});

test('unknown adapters get 404 and bad requests 400', async () => {
  const unknown = await post('/api/codex/threads', { adapterId: 'nope', cwd: 'C:\\x' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Codex adapter is not connected' });
  assert.equal((await get('/api/codex/folders?adapterId=nope')).status, 404);
  const blank = await post('/api/codex/threads', { adapterId: 'b', cwd: '  ' });
  assert.equal(blank.status, 400);
  assert.deepEqual(await blank.json(), { error: 'adapterId and cwd are required' });
  assert.equal((await post('/api/codex/threads', { adapterId: 7, cwd: 'C:\\x' })).status, 400);
  const noId = await get('/api/codex/folders');
  assert.equal(noId.status, 400);
  assert.deepEqual(await noId.json(), { error: 'adapterId is required' });
});

test('a call times out with 504 and a late answer is ignored', async () => {
  const link = await adapterLink('b4');
  await waitAdapter('b4');
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b4', cwd: 'C:\\x' });
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: 'Codex did not respond in time. The conversation may still appear.' });
    const late = link.inbox.find((m) => m.type === 'adapter_call');
    link.ws.send(JSON.stringify({ type: 'adapter_result', requestId: late.requestId, ok: true, data: { sessionId: 'late' } }));
    answer(link, (call) => (call.kind === 'folders' ? { ok: true, data: { folders: [] } } : undefined));
    const again = await get('/api/codex/folders?adapterId=b4');
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { folders: [] });
  } finally {
    link.ws.close();
  }
});

test('an adapter that disconnects during a call fails it with 502', async () => {
  const link = await adapterLink('b5');
  await waitAdapter('b5');
  link.ws.on('message', (d) => {
    if (JSON.parse(d.toString()).type === 'adapter_call') link.ws.terminate();
  });
  const res = await post('/api/codex/threads', { adapterId: 'b5', cwd: 'C:\\x' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Codex adapter disconnected' });
});

test('only the adapter that was asked can answer a call', async () => {
  const asked = await adapterLink('b6');
  const other = await adapterLink('b7');
  await waitAdapter('b6');
  await waitAdapter('b7');
  asked.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'adapter_call') other.ws.send(JSON.stringify({ type: 'adapter_result', requestId: m.requestId, ok: true, data: { folders: ['C:\\spoofed'] } }));
  });
  try {
    assert.equal((await get('/api/codex/folders?adapterId=b6')).status, 504);
  } finally {
    asked.ws.close();
    other.ws.close();
  }
});

async function fakeChannel(session: Record<string, unknown>) {
  const ch = await open('/ws/channel');
  ch.ws.send(JSON.stringify({ type: 'register', session: { name: 'x', status: 'idle', connectedAt: Date.now(), lastActivity: Date.now(), ...session } }));
  await until(async () => ((await (await get('/api/sessions')).json()) as any).sessions.some((s: any) => s.id === session.id));
  return ch;
}

test('close is forwarded to a closable Codex session and refused otherwise', async () => {
  const closable = await fakeChannel({ id: 'codex:c1', agentKind: 'codex', closable: true });
  const plain = await fakeChannel({ id: 'codex:c2', agentKind: 'codex' });
  const claude = await fakeChannel({ id: 'claude-c3', closable: true });
  try {
    const res = await post('/api/codex/threads/close', { sessionId: 'codex:c1' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const msg = await until(() => closable.inbox.find((m) => m.type === 'codex_close'));
    assert.deepEqual(msg, { type: 'codex_close', sessionId: 'codex:c1' });
    for (const sessionId of ['codex:c2', 'claude-c3', 'codex:none']) {
      const r = await post('/api/codex/threads/close', { sessionId });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'No closable Codex conversation' });
    }
    const bad = await post('/api/codex/threads/close', {});
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'sessionId is required' });
    assert.ok(!plain.inbox.some((m) => m.type === 'codex_close'));
    assert.ok(!claude.inbox.some((m) => m.type === 'codex_close'));
  } finally {
    closable.ws.close();
    plain.ws.close();
    claude.ws.close();
  }
});

test('the Codex routes need the hub token', async () => {
  assert.equal((await fetch(`${BASE}/api/codex/folders?adapterId=x`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/codex/threads`, { method: 'POST', headers: json, body: '{}' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/codex/threads/close`, { method: 'POST', headers: json, body: '{}' })).status, 401);
});
