// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7996;
const TOKEN = 'own-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function register(ws: WebSocket, id: string) {
  ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
}

async function send(sessionId: string, content: string) {
  return fetch(`http://127.0.0.1:${PORT}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sessionId, content }),
  });
}

test('a reconnect replaces a half-open socket holding the same id', async () => {
  const a = await open('/ws/channel');
  const b = await open('/ws/channel');
  const aClosed = new Promise((r) => a.ws.on('close', r));
  register(a.ws, 'dup');
  await settle();
  register(b.ws, 'dup');
  await aClosed;
  await settle();
  await send('dup', 'hello');
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'message_to_session').length, 1);
  assert.equal(a.inbox.filter((m) => m.type === 'message_to_session').length, 0);
  const sessions = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
  assert.ok(sessions.sessions.some((s: any) => s.id === 'dup'));
  b.ws.close();
});

test('a socket cannot speak for a session it does not own', async () => {
  const dash = await open('/ws/dashboard');
  const a = await open('/ws/channel');
  const b = await open('/ws/channel');
  register(a.ws, 'owner');
  register(b.ws, 'intruder');
  await settle();
  b.ws.send(JSON.stringify({ type: 'reply', sessionId: 'owner', content: 'spoofed' }));
  a.ws.send(JSON.stringify({ type: 'reply', sessionId: 'owner', content: 'genuine' }));
  await settle();
  const replies = dash.inbox.filter((m) => m.type === 'reply_from_session').map((m) => m.content);
  assert.deepEqual(replies, ['genuine']);
  dash.ws.close(); a.ws.close(); b.ws.close();
});

test('a reconnect may reclaim an id whose old socket is closed', async () => {
  const a = await open('/ws/channel');
  register(a.ws, 'reco');
  await settle();
  a.ws.terminate();
  const b = await open('/ws/channel');
  register(b.ws, 'reco');
  await settle();
  await send('reco', 'after');
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'message_to_session').length, 1);
  b.ws.close();
});
