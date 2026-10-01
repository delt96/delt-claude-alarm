// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

async function startAdapter(threads: any[], setup?: (d: FakeDaemon) => void, idleReleaseMs?: number): Promise<FakeDaemon> {
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
  setup?.(d);
  adapter = new CodexAdapter({ command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200, idleReleaseMs });
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

test('loaded threads become Codex sessions; only active ones are subscribed, without overrides', async () => {
  const d = await startAdapter([
    thread('t1', { status: { type: 'active', activeFlags: [] } }),
    thread('t2'),
    thread('sub', { parentThreadId: 't1' }),
  ]);
  const s = await session('codex:t1');
  assert.equal(s.agentKind, 'codex');
  assert.equal(s.displayName, 'Thread t1');
  assert.equal(s.cwd, 'C:\\w\\proj');
  assert.equal(s.status, 'working');
  assert.equal((await session('codex:t2')).status, 'idle');
  await until(() => d.calls('thread/resume').length > 0);
  await new Promise((r) => setTimeout(r, 200));
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

test('an idle thread is subscribed while a turn runs and released when it completes', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.calls('thread/resume').length, 0);
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await until(() => d.calls('thread/resume').length === 1);
  d.notify('turn/completed', { threadId: 't1', turn: { id: 'u9', status: 'completed', items: [], error: null } });
  await until(() => d.calls('thread/unsubscribe').length === 1);
  assert.deepEqual(d.calls('thread/unsubscribe')[0].params, { threadId: 't1' });
});

test('a failed subscription is retried on the next status change', async () => {
  let ready = false;
  const d = await startAdapter([thread('t1', { status: { type: 'active', activeFlags: [] } })], (dm) => dm.handle('thread/resume', () => {
    if (!ready) throw new Error('no rollout found for thread id t1');
    return {};
  }));
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  ready = true;
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  await until(() => d.calls('thread/resume').length === 2);
});

test('final answers are relayed as replies', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'Looking into it', phase: 'commentary' } });
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm2', text: 'Done: tests pass', phase: 'final_answer' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:t1'));
    assert.equal(reply.content, 'Done: tests pass');
  } finally {
    dash.ws.close();
  }
});

test('failed turns raise an error notification', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u2', status: 'failed', items: [], error: { message: 'usage limit reached' } } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'error');
    assert.match(n.message, /usage limit reached/);
  } finally {
    dash.ws.close();
  }
});

test('dashboard messages start a turn with a source prefix', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'run the tests' }));
    await until(() => d.calls('turn/start').length > 0);
    assert.deepEqual(d.calls('turn/start')[0].params, {
      threadId: 't1',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] run the tests' }],
    });
    const order = d.received.map((r) => r.method);
    assert.ok(order.indexOf('thread/resume') !== -1 && order.indexOf('thread/resume') < order.indexOf('turn/start'));
  } finally {
    dash.ws.close();
  }
});

test('messages to a thread waiting for approval are refused, not queued', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await session('codex:t1', (s) => s.status === 'waiting_input');
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello?' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.match(n.message, /busy/);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await session('codex:t1', (s) => s.status === 'idle');
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('approval requests raise a warning that names the command', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(90, 'item/commandExecution/requestApproval', {
      threadId: 't1',
      turnId: 'u3',
      itemId: 'i1',
      command: '"powershell.exe" -Command \'curl.exe https://example.com\'',
      commandActions: [{ type: 'unknown', command: 'curl.exe https://example.com' }],
    });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Codex approval needed');
    assert.match(n.message, /curl\.exe https:\/\/example\.com/);
  } finally {
    dash.ws.close();
  }
});

test('back-to-back messages start only one turn', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'first' }));
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'second' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.match(n.message, /busy/);
    assert.equal(d.calls('turn/start').length, 1);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] first');
  } finally {
    dash.ws.close();
  }
});

test('losing the daemon removes Codex sessions and reconnecting restores them', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.dropClient();
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t1'));
  await until(() => d.connections === 2, 5000);
  await session('codex:t1');
});

test('a missing Codex binary is retried without crashing', async () => {
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex',
    hub: HUB,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    spawnFn: () => {
      attempts++;
      return spawn('claude-alarm-no-such-codex-binary', [], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 3000);
});

test('a failing discovery does not leave sessions behind', async () => {
  let fail = true;
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('thread/loaded/list', () => {
      if (fail) {
        dm.notify('thread/started', { thread: thread('early') });
        throw new Error('list failed');
      }
      return { data: ['t1'], nextCursor: null };
    });
  });
  await until(() => d.calls('thread/loaded/list').length >= 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await sessions()).some((x) => x.id === 'codex:early'));
  fail = false;
  await session('codex:t1');
});

const active = { type: 'active', activeFlags: [] };

test('idle arriving before turn/completed still relays the reply, then releases', async () => {
  const d = await startAdapter([thread('t1', { status: active })], undefined, 150);
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'All done', phase: 'final_answer' } });
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:t1'));
    assert.equal(reply.content, 'All done');
    await until(() => d.calls('thread/unsubscribe').length >= 1);
  } finally {
    dash.ws.close();
  }
});

test('idle without turn/completed releases after the delay and active again cancels it', async () => {
  const d = await startAdapter([thread('t1', { status: active })], undefined, 400);
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
  await session('codex:t1', (s) => s.status === 'idle');
  assert.equal(d.calls('thread/unsubscribe').length, 0);
  await until(() => d.calls('thread/unsubscribe').length === 1);

  d.notify('thread/status/changed', { threadId: 't1', status: active });
  await until(() => d.calls('thread/resume').length === 2);
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
  await session('codex:t1', (s) => s.status === 'idle');
  d.notify('thread/status/changed', { threadId: 't1', status: active });
  await session('codex:t1', (s) => s.status === 'working');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(d.calls('thread/unsubscribe').length, 1);
});

test('a rejected turn/start releases the subscription', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('turn/start', () => {
    throw new Error('thread is busy');
  }), 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'go' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.match(n.message, /Codex rejected the message: thread is busy/);
    await until(() => d.calls('thread/unsubscribe').length === 1);
  } finally {
    dash.ws.close();
  }
});

test('a new conversation is subscribed on the active broadcast and its reply is relayed without a warning', async () => {
  let resumes = 0;
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    if (resumes++ === 0) throw new Error('no rollout found for thread id t1');
    return {};
  }), 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'start' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.equal(d.calls('thread/resume').length, 1);
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 2);
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'Fresh answer', phase: 'final_answer' } });
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:t1'));
    assert.equal(reply.content, 'Fresh answer');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
  } finally {
    dash.ws.close();
  }
});

test('a subscription that keeps failing raises one "Reply not relayed" warning', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    throw new Error('no rollout found for thread id t1');
  }), 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'start' }));
    await until(() => d.calls('turn/start').length === 1);
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 2);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
    assert.equal(n.level, 'warning');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(dash.inbox.filter((m) => m.type === 'notification' && m.title === 'Reply not relayed').length, 1);
  } finally {
    dash.ws.close();
  }
});
