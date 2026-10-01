// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7992;
const TOKEN = 'choice-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function register(ws: WebSocket, id: string, extra: object = {}) {
  ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true, ...extra } }));
}

const choices = [{ id: '0', label: 'Allow once' }, { id: '1', label: 'Cancel task' }];

function request(ws: WebSocket, sessionId: string, requestId: string, withChoices = true) {
  ws.send(JSON.stringify({
    type: 'permission_request',
    sessionId,
    requestId,
    toolName: 'Command',
    description: 'Allow?',
    inputPreview: '{"command":"ls"}',
    timestamp: 0,
    ...(withChoices ? { choices } : {}),
  }));
}

const responses = (inbox: any[]) => inbox.filter((m) => m.type === 'permission_response');
const answer = (ws: WebSocket, body: object) => ws.send(JSON.stringify({ type: 'permission_response', ...body }));

test('choice requests reach dashboards with their choices and only a listed choiceId is forwarded', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c1');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c1', 'r1');
  await settle();
  assert.deepEqual(dash.inbox.find((m) => m.type === 'permission_request')?.choices, choices);
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', behavior: 'allow' });
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', choiceId: '7' });
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', choiceId: '1' });
  await settle();
  assert.deepEqual(responses(ch.inbox), [{ type: 'permission_response', sessionId: 'codex:c1', requestId: 'r1', choiceId: '1' }]);
  dash.ws.close();
  ch.ws.close();
});

test('Claude requests still take allow or deny and drop choice ids', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'claude-1');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'claude-1', 'r2', false);
  await settle();
  assert.equal(dash.inbox.find((m) => m.type === 'permission_request')?.choices, undefined);
  answer(dash.ws, { sessionId: 'claude-1', requestId: 'r2', choiceId: '0' });
  answer(dash.ws, { sessionId: 'claude-1', requestId: 'r2', behavior: 'deny' });
  await settle();
  assert.deepEqual(responses(ch.inbox), [{ type: 'permission_response', sessionId: 'claude-1', requestId: 'r2', behavior: 'deny' }]);
  dash.ws.close();
  ch.ws.close();
});

test('a resolved choice request is announced once and takes no more answers', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c2');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c2', 'r3');
  await settle();
  ch.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' }));
  ch.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' }));
  await settle();
  assert.deepEqual(dash.inbox.filter((m) => m.type === 'permission_resolved'), [
    { type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' },
  ]);
  answer(dash.ws, { sessionId: 'codex:c2', requestId: 'r3', choiceId: '0' });
  await settle();
  assert.deepEqual(responses(ch.inbox), []);
  dash.ws.close();
  ch.ws.close();
});

test('a session that disconnects expires its pending choice requests', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c3');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c3', 'r4');
  await settle();
  ch.ws.close();
  await settle();
  assert.deepEqual(dash.inbox.find((m) => m.type === 'permission_resolved'), {
    type: 'permission_resolved', sessionId: 'codex:c3', requestId: 'r4', state: 'expired',
  });
  dash.ws.close();
});

test('another connection cannot resolve a session it does not own', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c4');
  const other = await open('/ws/channel');
  register(other.ws, 'codex:other');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c4', 'r5');
  await settle();
  other.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c4', requestId: 'r5', state: 'resolved' }));
  await settle();
  assert.equal(dash.inbox.filter((m) => m.type === 'permission_resolved').length, 0);
  answer(dash.ws, { sessionId: 'codex:c4', requestId: 'r5', choiceId: '0' });
  await settle();
  assert.equal(responses(ch.inbox).length, 1);
  dash.ws.close();
  ch.ws.close();
  other.ws.close();
});

test('Codex sessions never take allow or deny, even after a choice request resolved', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c5', { agentKind: 'codex' });
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c5', 'r6');
  await settle();
  ch.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c5', requestId: 'r6', state: 'resolved' }));
  await settle();
  answer(dash.ws, { sessionId: 'codex:c5', requestId: 'r6', behavior: 'allow' });
  answer(dash.ws, { sessionId: 'codex:c5', requestId: 'r7', behavior: 'deny' });
  await settle();
  assert.deepEqual(responses(ch.inbox), []);
  dash.ws.close();
  ch.ws.close();
});
