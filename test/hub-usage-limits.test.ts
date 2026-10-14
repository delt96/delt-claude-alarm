// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import type { UsageLimits } from '../src/shared/types.js';

const PORT = 7986;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function connect(inbox: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=t`);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const limitsMsgs = (inbox: any[]) => inbox.filter((m) => m.type === 'usage_limits');

test('hub sends usage limits on connect and only again when they change', async () => {
  let current: UsageLimits = { claude: { fiveHour: { usedPercent: 42, resetsAt: null }, updatedAt: 1 }, codex: null };
  let reads = 0;
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any, {
    readUsageLimits: () => {
      reads++;
      return current;
    },
    usageLimitsIntervalMs: 50,
  });
  await hub.start();
  try {
    const inbox: any[] = [];
    const d = await connect(inbox);
    await settle();
    assert.equal(limitsMsgs(inbox).length, 1);
    assert.deepEqual(limitsMsgs(inbox)[0].limits, current);

    await settle(200);
    assert.ok(reads >= 3, `reads ${reads}`);
    assert.equal(limitsMsgs(inbox).length, 1);

    current = { ...current, codex: { sevenDay: { usedPercent: 35, resetsAt: 9 }, updatedAt: 2 } };
    await settle(200);
    assert.equal(limitsMsgs(inbox).length, 2);
    assert.deepEqual(limitsMsgs(inbox)[1].limits, current);

    const second: any[] = [];
    const d2 = await connect(second);
    await settle();
    assert.deepEqual(limitsMsgs(second).map((m) => m.limits), [current]);
    assert.equal(limitsMsgs(inbox).length, 2);

    d.close();
    d2.close();
  } finally {
    await hub.stop();
  }
});

test('a failing reader does not break the hub or dashboards', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any, {
    readUsageLimits: () => {
      throw new Error('boom');
    },
    usageLimitsIntervalMs: 50,
  });
  await hub.start();
  try {
    const inbox: any[] = [];
    const d = await connect(inbox);
    await settle(200);
    assert.deepEqual(limitsMsgs(inbox).map((m) => m.limits), [{ claude: null, codex: null }]);
    assert.ok(inbox.some((m) => m.type === 'sessions_list'));
    d.close();
  } finally {
    await hub.stop();
  }
});
