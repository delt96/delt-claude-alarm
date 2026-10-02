// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7982;
const TOKEN = 'codex-new-thread-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm 새 대화-'));
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;
let hostCount = 0;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => {
  await hub.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
});
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
const created = (id: string, cwd: string) => thread(id, { name: null, cwd });

async function sessions(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}
const session = (id: string, pred: (s: any) => boolean = () => true) => until(async () => (await sessions()).find((s) => s.id === id && pred(s)));
const gone = (id: string) => until(async () => !(await sessions()).some((s) => s.id === id));
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (p: string) => fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

function openDashboard(): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

async function adapterInfo(host: string, ready: boolean): Promise<any> {
  const dash = await openDashboard();
  try {
    return await until(() => dash.inbox.filter((m) => m.type === 'codex_adapters').at(-1)?.adapters.find((a: any) => a.host === host && a.ready === ready));
  } finally {
    dash.ws.close();
  }
}

interface Started { d: FakeDaemon; threads: any[]; host: string; adapterId: string }

async function startAdapter(
  threads: any[],
  setup?: (d: FakeDaemon, threads: any[]) => void,
  opts: { idleReleaseMs?: number; rpcTimeoutMs?: number; waitReady?: boolean } = {},
): Promise<Started> {
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
  d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('thread/list', () => ({ data: threads, nextCursor: null }));
  let n = 0;
  d.handle('thread/start', (p) => {
    const t = created(`n${++n}`, p.cwd);
    threads.push(t);
    return { thread: t };
  });
  setup?.(d, threads);
  const host = `pc-${++hostCount}`;
  adapter = new CodexAdapter({
    command: 'codex',
    hub: HUB,
    spawnFn: d.spawnFn,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    linkReconnectMs: 50,
    hostName: host,
    idleReleaseMs: opts.idleReleaseMs,
    rpcTimeoutMs: opts.rpcTimeoutMs,
  });
  adapter.start();
  const info = await adapterInfo(host, opts.waitReady !== false);
  return { d, threads, host, adapterId: info.id };
}

const create = (s: Started, cwd: string = WORK) => post('/api/codex/threads', { adapterId: s.adapterId, cwd });

test('the adapter is ready only after discovery and refuses to create before that', async () => {
  let release!: () => void;
  const listed = new Promise<void>((r) => { release = r; });
  const s = await startAdapter([thread('t1')], (dm, threads) =>
    dm.handle('thread/loaded/list', () => listed.then(() => ({ data: threads.map((t) => t.id), nextCursor: null }))),
  { waitReady: false });
  await until(() => s.d.calls('thread/loaded/list').length === 1);
  const res = await create(s);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: `Codex is not connected on ${s.host}.` });
  assert.equal(s.d.calls('thread/start').length, 0);
  release();
  await adapterInfo(s.host, true);
});

test('recent folders come from the Codex history, newest first, without duplicates, at most ten', async () => {
  const cwds = ['C:\\a', 'C:\\b', 'C:\\a', ...Array.from({ length: 10 }, (_, i) => `C:\\f${i}`)];
  const history = cwds.map((cwd, i) => thread(`h${i}`, { cwd }));
  const s = await startAdapter([], (dm) => dm.handle('thread/list', () => ({ data: history, nextCursor: null })));
  const res = await get(`/api/codex/folders?adapterId=${s.adapterId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { folders: ['C:\\a', 'C:\\b', 'C:\\f0', 'C:\\f1', 'C:\\f2', 'C:\\f3', 'C:\\f4', 'C:\\f5', 'C:\\f6', 'C:\\f7'] });
  assert.deepEqual(s.d.calls('thread/list')[0].params, { limit: 50, sortKey: 'updated_at' });
});

test('creating starts a full-access conversation in the cleaned folder and shows it as closable', async () => {
  const s = await startAdapter([]);
  const res = await create(s, `  "${WORK}" `);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sessionId: 'codex:n1' });
  assert.deepEqual(s.d.calls('thread/start')[0].params, { cwd: WORK, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const sess = await session('codex:n1', (x) => x.closable === true);
  assert.equal(sess.agentKind, 'codex');
  assert.equal(sess.displayName, path.basename(WORK));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a created conversation stays subscribed through its turns', async () => {
  const s = await startAdapter([], undefined, { idleReleaseMs: 50 });
  await create(s);
  await session('codex:n1');
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'active', activeFlags: [] } });
  await session('codex:n1', (x) => x.status === 'working');
  s.d.notify('turn/completed', { threadId: 'n1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'idle' } });
  await session('codex:n1', (x) => x.status === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.d.calls('thread/unsubscribe').length, 0);
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a thread/started broadcast that beats the answer still ends up closable', async () => {
  const s = await startAdapter([], (dm, threads) => dm.handle('thread/start', (p) => {
    const t = created('n9', p.cwd);
    threads.push(t);
    dm.notify('thread/started', { thread: t });
    return { thread: t };
  }));
  assert.equal((await create(s)).status, 200);
  await session('codex:n9', (x) => x.closable === true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a slow thread/start is not cut off by the RPC timeout', async () => {
  const s = await startAdapter([], (dm, threads) => dm.handle('thread/start', (p) => new Promise((resolve) => setTimeout(() => {
    const t = created('n7', p.cwd);
    threads.push(t);
    resolve({ thread: t });
  }, 300))), { rpcTimeoutMs: 100 });
  const res = await create(s);
  assert.equal(res.status, 200);
  await session('codex:n7', (x) => x.closable === true);
});

test('relative paths, missing folders and files are refused before Codex is asked', async () => {
  const s = await startAdapter([]);
  const file = path.join(WORK, 'note.txt');
  fs.writeFileSync(file, 'x');
  for (const cwd of ['relative\\dir', path.join(WORK, 'missing'), file]) {
    const res = await create(s, cwd);
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: `Folder not found on ${s.host}: ${cwd}` });
  }
  assert.equal(s.d.calls('thread/start').length, 0);
});

test('a thread/start that Codex rejects is reported', async () => {
  const s = await startAdapter([], (dm) => dm.handle('thread/start', () => {
    throw new Error('model not available');
  }));
  const res = await create(s);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'Codex could not start the conversation: model not available' });
});
