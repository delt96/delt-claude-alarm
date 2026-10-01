// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7994;
const TOKEN = 'codex-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });
afterEach(async () => {
  adapter?.stop();
  adapter = undefined;
  await daemon?.stop();
  daemon = undefined;
  await until(async () => !(await sessions()).some((s) => s.id.startsWith('codex:')));
});

function thread(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Thread ${id}`, preview: '', cwd: 'C:\\w\\proj', status: { type: 'idle' }, parentThreadId: null, ephemeral: false, ...extra };
}

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

const session = (id: string, pred: (s: any) => boolean = () => true) =>
  until(async () => (await sessions()).find((s) => s.id === id && pred(s)));

async function startAdapter(threads: any[], setup?: (d: FakeDaemon) => void): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  await d.start();
  d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
  d.handle('thread/read', (p) => {
    const t = threads.find((x) => x.id === p.threadId);
    if (!t) throw new Error('thread not found');
    return { thread: t };
  });
  d.handle('thread/resume', () => ({}));
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  setup?.(d);
  adapter = new CodexAdapter({ command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200 });
  adapter.start();
  return d;
}

function openDashboard(): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

test('loaded threads become Codex sessions and are subscribed without overrides', async () => {
  const d = await startAdapter([thread('t1'), thread('sub', { parentThreadId: 't1' })]);
  const s = await session('codex:t1');
  assert.equal(s.agentKind, 'codex');
  assert.equal(s.displayName, 'Thread t1');
  assert.equal(s.cwd, 'C:\\w\\proj');
  assert.equal(s.status, 'idle');
  await until(() => d.calls('thread/resume').length > 0);
  assert.deepEqual(d.calls('thread/resume').map((c) => c.params), [{ threadId: 't1', excludeTurns: true }]);
  assert.ok(!(await sessions()).some((x) => x.id === 'codex:sub'));
});

test('status changes are mirrored and notLoaded removes the session', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  await session('codex:t1', (s) => s.status === 'waiting_input');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await session('codex:t1', (s) => s.status === 'working');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'notLoaded' } });
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t1'));
});

test('renamed and newly started threads are picked up, closed ones dropped', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.notify('thread/name/updated', { threadId: 't1', threadName: 'Renamed' });
  await session('codex:t1', (s) => s.displayName === 'Renamed');
  d.notify('thread/started', { thread: thread('t2', { name: null, preview: 'Write the release notes for version two' }) });
  const s2 = await session('codex:t2');
  assert.equal(s2.displayName, 'Write the release notes for ve…');
  d.notify('thread/closed', { threadId: 't2' });
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t2'));
});

test('a brand-new thread is subscribed once it has a rollout', async () => {
  let ready = false;
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    if (!ready) throw new Error('no rollout found for thread id t1');
    return {};
  }));
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  ready = true;
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await until(() => d.calls('thread/resume').length === 2);
});
