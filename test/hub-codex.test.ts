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

test('the codex socket needs the hub token', async () => {
  const outcome = await new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/codex`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
  assert.equal(outcome, 401);
});
