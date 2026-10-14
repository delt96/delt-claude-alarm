// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7999;
const settle = () => new Promise((r) => setTimeout(r, 150));

function connect(path: string, inbox: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=t`);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const register = (ws: WebSocket, id: string) =>
  ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));

test('hub keeps control state, forwards commands to an idle session and relays results', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any);
  await hub.start();
  try {
    const aIn: any[] = [];
    const a = await connect('/ws/channel', aIn);
    register(a, 'a');
    const bIn: any[] = [];
    const b = await connect('/ws/channel', bIn);
    register(b, 'b');
    const dash: any[] = [];
    const d = await connect('/ws/dashboard', dash);
    await settle();
    assert.ok(aIn.some((m) => m.type === 'hub_info' && m.features.includes('session_control')));

    d.send(JSON.stringify({ type: 'session_command', sessionId: 'a', requestId: 'r1', kind: 'compact' }));
    await settle();
    assert.deepEqual(dash.filter((m) => m.type === 'session_command_result').pop(),
      { type: 'session_command_result', sessionId: 'a', requestId: 'r1', ok: false, reason: 'the session cannot run commands from the dashboard' });

    a.send(JSON.stringify({ type: 'session_control', sessionId: 'a', control: { busy: true, advice: 'clear', junk: 1 } }));
    await settle();
    assert.deepEqual((hub as any).sessions.get('a')?.control, { busy: true, advice: 'clear' });
    assert.deepEqual(dash.filter((m) => m.type === 'session_updated').pop()?.session.control, { busy: true, advice: 'clear' });

    d.send(JSON.stringify({ type: 'session_command', sessionId: 'a', requestId: 'r2', kind: 'compact' }));
    await settle();
    assert.equal(dash.filter((m) => m.type === 'session_command_result').pop()?.reason, 'the session is busy');

    a.send(JSON.stringify({ type: 'session_control', sessionId: 'a', control: { busy: false } }));
    await settle();
    d.send(JSON.stringify({ type: 'session_command', sessionId: 'a', requestId: 'r3', kind: 'clear' }));
    d.send(JSON.stringify({ type: 'session_command', sessionId: 'a', requestId: 'r4', kind: 'exit' }));
    d.send(JSON.stringify({ type: 'session_command', sessionId: 'a', requestId: '../x', kind: 'clear' }));
    await settle();
    assert.deepEqual(aIn.filter((m) => m.type === 'session_command'), [{ type: 'session_command', sessionId: 'a', requestId: 'r3', kind: 'clear' }]);

    b.send(JSON.stringify({ type: 'session_command_result', sessionId: 'a', requestId: 'r3', ok: true }));
    await settle();
    assert.ok(!dash.some((m) => m.type === 'session_command_result' && m.requestId === 'r3'));
    a.send(JSON.stringify({ type: 'session_command_result', sessionId: 'a', requestId: 'r3', ok: true }));
    await settle();
    assert.deepEqual(dash.filter((m) => m.type === 'session_command_result').pop(), { type: 'session_command_result', sessionId: 'a', requestId: 'r3', ok: true });

    a.send(JSON.stringify({ type: 'session_control', sessionId: 'a', control: null }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.control, undefined);

    a.close();
    b.close();
    d.close();
  } finally {
    await hub.stop();
  }
});
