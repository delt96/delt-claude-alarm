// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexHubLink } from '../src/codex/hub-link.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7981;
const TOKEN = 'codex-link-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
const BASE = `http://127.0.0.1:${PORT}`;
const newHub = () => new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
let hub: HubServer;

before(async () => {
  hub = newHub();
  await hub.start();
});
after(async () => { await hub.stop(); });

async function adapters(): Promise<any[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
  try {
    return await new Promise((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'codex_adapters') resolve(m.adapters);
      });
      ws.on('error', reject);
    });
  } finally {
    ws.close();
  }
}

const listed = (pred: (a: any) => boolean) => until(async () => (await adapters()).find(pred));
const absent = (id: string) => until(async () => !(await adapters()).some((a) => a.id === id));

test('the link says hello, follows ready changes and answers calls through the hub', async () => {
  const link = new CodexHubLink(HUB, { id: 'L1', host: 'pc-x' }, async (call) => {
    if (call.kind === 'folders') return { folders: ['C:\\p'] };
    throw new Error(`Folder not found on pc-x: ${call.cwd}`);
  }, 50);
  link.connect();
  try {
    await listed((a) => a.id === 'L1' && a.host === 'pc-x' && a.ready === false);
    link.setReady(true);
    await listed((a) => a.id === 'L1' && a.ready === true);
    const ok = await fetch(`${BASE}/api/codex/folders?adapterId=L1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { folders: ['C:\\p'] });
    const bad = await fetch(`${BASE}/api/codex/threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'L1', cwd: 'C:\\nope' }),
    });
    assert.equal(bad.status, 422);
    assert.deepEqual(await bad.json(), { error: 'Folder not found on pc-x: C:\\nope' });
  } finally {
    link.disconnect();
  }
  await absent('L1');
});

test('the link reconnects to a restarted hub and says hello again', async () => {
  const link = new CodexHubLink(HUB, { id: 'L2', host: 'pc-y' }, async () => ({}), 50);
  link.connect();
  link.setReady(true);
  try {
    await listed((a) => a.id === 'L2' && a.ready === true);
    await hub.stop();
    hub = newHub();
    await hub.start();
    await listed((a) => a.id === 'L2' && a.ready === true);
  } finally {
    link.disconnect();
  }
  await absent('L2');
});

test('a disconnected link stays away', async () => {
  const link = new CodexHubLink(HUB, { id: 'L3', host: 'pc-z' }, async () => ({}), 50);
  link.connect();
  await listed((a) => a.id === 'L3');
  link.disconnect();
  await absent('L3');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await adapters()).some((a) => a.id === 'L3'));
});
