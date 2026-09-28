import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7998;

function channel(id: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/channel?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true, peerName: `${id}-1` } }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test('hub ignores peer_name for a session owned by another socket', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any);
  await hub.start();
  try {
    const a = await channel('a');
    const b = await channel('b');
    await settle();
    b.send(JSON.stringify({ type: 'peer_name', sessionId: 'a', peerName: 'hijacked' }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.peerName, 'a-1');
    a.send(JSON.stringify({ type: 'peer_name', sessionId: 'a', peerName: 'a-2' }));
    await settle();
    assert.equal((hub as any).sessions.get('a')?.peerName, 'a-2');
    a.close();
    b.close();
  } finally {
    await hub.stop();
  }
});
