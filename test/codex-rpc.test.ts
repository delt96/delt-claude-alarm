import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RpcClient, RpcError } from '../src/codex/rpc.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: any[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
}

test('request resolves with the matching response', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const pending = rpc.request('thread/read', { threadId: 't' });
  assert.deepEqual(ws.sent[0], { id: 1, method: 'thread/read', params: { threadId: 't' } });
  ws.emit('message', JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
});

test('error responses reject with RpcError', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const pending = rpc.request('thread/resume', { threadId: 't' });
  ws.emit('message', JSON.stringify({ id: 1, error: { code: -32600, message: 'no rollout found' } }));
  await assert.rejects(pending, (err: unknown) => err instanceof RpcError && err.code === -32600 && /no rollout/.test(err.message));
});

test('server requests and notifications are emitted', () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const seen: unknown[] = [];
  rpc.on('notification', (method, params) => seen.push(['n', method, params]));
  rpc.on('request', (id, method, params) => seen.push(['r', id, method, params]));
  ws.emit('message', JSON.stringify({ method: 'turn/started', params: { threadId: 't' } }));
  ws.emit('message', JSON.stringify({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } }));
  ws.emit('message', 'not json');
  assert.deepEqual(seen, [
    ['n', 'turn/started', { threadId: 't' }],
    ['r', 7, 'item/commandExecution/requestApproval', { threadId: 't' }],
  ]);
});

test('notify sends a message without id', () => {
  const ws = new FakeWs();
  new RpcClient(ws as any).notify('initialized');
  assert.deepEqual(ws.sent[0], { method: 'initialized' });
});

test('closing the socket rejects pending requests and emits close', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  let closed = false;
  rpc.on('close', () => { closed = true; });
  const pending = rpc.request('thread/loaded/list', {});
  ws.emit('close');
  await assert.rejects(pending, /closed/);
  assert.equal(closed, true);
});

test('requests time out', async () => {
  const rpc = new RpcClient(new FakeWs() as any, 20);
  await assert.rejects(rpc.request('initialize', {}), /timed out/);
});

test('request rejects immediately when the socket is not open', async () => {
  const ws = new FakeWs();
  ws.readyState = 3;
  await assert.rejects(new RpcClient(ws as any).request('initialize', {}), /closed/);
});
