// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7984;
const settle = () => new Promise((r) => setTimeout(r, 150));

function connect(path: string, inbox: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=t`);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('hub stores context_tokens, tells dashboards, and ignores other sockets', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any);
  await hub.start();
  try {
    const aIn: any[] = [];
    const a = await connect('/ws/channel', aIn);
    a.send(JSON.stringify({ type: 'register', session: { id: 'a', name: 'a', status: 'idle', connectedAt: 0, lastActivity: 0, cwd: '/w/a', channelEnabled: true } }));
    const b = await connect('/ws/channel', []);
    b.send(JSON.stringify({ type: 'register', session: { id: 'b', name: 'b', status: 'idle', connectedAt: 0, lastActivity: 0, cwd: '/w/b', channelEnabled: true } }));
    const dash: any[] = [];
    const d = await connect('/ws/dashboard', dash);
    await settle();

    assert.ok(aIn.some((m) => m.type === 'hub_info' && m.features.includes('context_tokens')));

    a.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: 132854 }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, 132854);
    const update = dash.filter((m) => m.type === 'session_updated').pop();
    assert.equal(update?.session.id, 'a');
    assert.equal(update?.session.contextTokens, 132854);

    b.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: 1 }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, 132854);

    a.send(JSON.stringify({ type: 'context_tokens', sessionId: 'a', tokens: null }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.contextTokens, undefined);

    a.close();
    b.close();
    d.close();
  } finally {
    await hub.stop();
  }
});
