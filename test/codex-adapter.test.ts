// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter, type FirstConnect } from '../src/codex/adapter.js';
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
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('turn/steer', (p) => ({ turnId: p.expectedTurnId }));
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
  const d = await startAdapter([thread('t1')], undefined, 50);
  await session('codex:t1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.calls('thread/resume').length, 0);
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await until(() => d.calls('thread/resume').length === 1);
  d.notify('turn/completed', { threadId: 't1', turn: { id: 'u9', status: 'completed', items: [], error: null } });
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
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
    assert.equal(n.message, 'Codex is waiting for an approval or input. Answer it first, then send the message again.');
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await session('codex:t1', (s) => s.status === 'idle');
    assert.equal(d.calls('turn/start').length, 0);
    assert.equal(d.calls('turn/steer').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a second message right after the first is steered into the turn the first one started', async () => {
  let running: string | undefined;
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('turn/start', () => {
      running = 'turn-new';
      return { turn: { id: 'turn-new', status: 'inProgress', items: [] } };
    });
    dm.handle('thread/turns/list', () => ({ data: running ? [{ id: running, status: 'inProgress', items: [] }] : [], nextCursor: null }));
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'first' }));
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'second' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.equal(d.calls('turn/start').length, 1);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] first');
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'turn-new',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] second' }],
    });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'info');
    assert.equal(n.message, 'Queued: Codex will read it after its current step.');
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

interface Recorded { method?: string; url?: string; auth?: string; body: unknown }

async function recordingHub(opts: { statuses?: number[]; delayMs?: number } = {}) {
  const statuses = [...(opts.statuses ?? [])];
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.upgrade) {
      res.writeHead(426);
      res.end();
      return;
    }
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(data || 'null') });
      const status = statuses.shift() ?? 200;
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, opts.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    hub: { host: '127.0.0.1', port, token: TOKEN },
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const MISSING = 'claude-alarm-no-such-codex-binary';
const NOT_FOUND_NOTICE = {
  title: 'Codex not found',
  message: `The Codex adapter cannot find "${MISSING}". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.`,
  level: 'warning',
};

function missingCodexAdapter(hub: { host: string; port: number; token?: string }, counter: { attempts: number }, noticeTimeoutMs?: number): CodexAdapter {
  return new CodexAdapter({
    command: MISSING,
    hub,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    noticeTimeoutMs,
    spawnFn: () => {
      counter.attempts++;
      return spawn(MISSING, [], { stdio: 'pipe' });
    },
  });
}

test('a missing Codex binary is reported to the hub once', async () => {
  const rec = await recordingHub();
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 1);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 1);
    assert.deepEqual(rec.requests[0], { method: 'POST', url: '/api/notify', auth: `Bearer ${TOKEN}`, body: NOT_FOUND_NOTICE });
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('the not-found notice is retried until the hub accepts it', async () => {
  const rec = await recordingHub({ statuses: [500, 200] });
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 2);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 2);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('no second notice is sent while the notice is still being sent', async () => {
  const rec = await recordingHub({ delayMs: 400 });
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 1);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 1);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('a hub that replies after the notice timeout still counts as notified', async () => {
  const rec = await recordingHub({ delayMs: 300 });
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter, 100);
    adapter.start();
    await until(() => rec.requests.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 1);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('other connection failures do not send the not-found notice', async () => {
  const rec = await recordingHub();
  let attempts = 0;
  try {
    adapter = new CodexAdapter({
      command: 'codex',
      hub: rec.hub,
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
      spawnFn: () => {
        attempts++;
        return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
      },
    });
    adapter.start();
    await until(() => attempts >= 3, 5000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rec.requests.length, 0);
  } finally {
    adapter?.stop();
    await rec.close();
  }
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

test('a malformed notification does not stop the connection', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.notify('turn/completed', { threadId: 't1' });
  d.notify('thread/started', { thread: thread('t2') });
  await session('codex:t2');
});

test('turn/completed while the thread is still active does not release it', async () => {
  const d = await startAdapter([thread('t1', { status: active })], undefined, 150);
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'All done', phase: 'final_answer' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:t1'));
    assert.equal(reply.content, 'All done');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(d.calls('thread/unsubscribe').length, 0);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await until(() => d.calls('thread/unsubscribe').length === 1);
  } finally {
    dash.ws.close();
  }
});

const approvalParams = {
  threadId: 't1',
  turnId: 'u3',
  itemId: 'i1',
  reason: 'Allow creating x?',
  command: 'New-Item x',
  availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['New-Item', 'x'] } }, 'cancel'],
};

async function approvalOnDashboard(
  d: FakeDaemon,
  dash: { inbox: any[] },
  id: number,
  method = 'item/commandExecution/requestApproval',
  params: any = approvalParams,
) {
  const before = dash.inbox.filter((m) => m.type === 'permission_request').length;
  d.serverRequest(id, method, params);
  return until(() => dash.inbox.filter((m) => m.type === 'permission_request')[before]);
}

const choose = (dash: { ws: WebSocket }, requestId: string, choiceId: string) =>
  dash.ws.send(JSON.stringify({ type: 'permission_response', sessionId: 'codex:t1', requestId, choiceId }));

test('command approvals reach the dashboard with the choices Codex offered', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 90);
    assert.equal(req.sessionId, 'codex:t1');
    assert.equal(req.toolName, 'Command');
    assert.equal(req.description, 'Allow creating x?');
    assert.deepEqual(JSON.parse(req.inputPreview), { command: 'New-Item x' });
    assert.deepEqual(req.choices, [
      { id: '0', label: 'Allow once' },
      { id: '1', label: 'Always allow this command' },
      { id: '2', label: 'Cancel task' },
    ]);
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.title === 'Codex approval needed'));
  } finally {
    dash.ws.close();
  }
});

test('the chosen decision is sent to Codex once', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 90);
    choose(dash, req.requestId, '1');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 90, result: { decision: approvalParams.availableDecisions[1] } });
    choose(dash, req.requestId, '0');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.responses.length, 1);
  } finally {
    dash.ws.close();
  }
});

test('a request answered elsewhere closes on the dashboard and takes no late answer', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 91);
    d.notify('serverRequest/resolved', { threadId: 't1', requestId: 91 });
    const resolved = await until(() => dash.inbox.find((m) => m.type === 'permission_resolved'));
    assert.deepEqual(resolved, { type: 'permission_resolved', sessionId: 'codex:t1', requestId: req.requestId, state: 'resolved' });
    choose(dash, req.requestId, '0');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('file change approvals list the files from the started item', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/started', {
      threadId: 't1',
      turnId: 'u3',
      startedAtMs: 0,
      item: { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: 'C:\\w\\proj\\a.txt', kind: { type: 'add' }, diff: 'hi' }] },
    });
    const req = await approvalOnDashboard(d, dash, 92, 'item/fileChange/requestApproval', {
      threadId: 't1', turnId: 'u3', itemId: 'p1', reason: null, grantRoot: null,
    });
    assert.equal(req.toolName, 'File change');
    assert.equal(JSON.parse(req.inputPreview).content, 'C:\\w\\proj\\a.txt\nhi');
    assert.deepEqual(req.choices.map((c: any) => c.label), ['Allow once', 'Allow for this session', 'Decline', 'Cancel task']);
    choose(dash, req.requestId, '2');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 92, result: { decision: 'decline' } });
  } finally {
    dash.ws.close();
  }
});

test('MCP tool approvals answer with an elicitation action', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 93, 'mcpServer/elicitation/request', {
      threadId: 't1',
      turnId: 'u3',
      serverName: 'claude-alarm',
      mode: 'form',
      message: 'Allow notify?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call' },
    });
    assert.equal(req.toolName, 'MCP tool');
    choose(dash, req.requestId, '0');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 93, result: { action: 'accept', content: {} } });
  } finally {
    dash.ws.close();
  }
});

test('requests claude-alarm cannot relay point the user to Codex', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(94, 'item/tool/requestUserInput', { threadId: 't1', turnId: 'u3', itemId: 'q1', questions: [] });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.match(n.message, /Handle it in Codex/);
    assert.ok(!dash.inbox.some((m) => m.type === 'permission_request'));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a request re-sent to a new subscription is shown once', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    await approvalOnDashboard(d, dash, 95);
    d.serverRequest(95, 'item/commandExecution/requestApproval', approvalParams);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(dash.inbox.filter((m) => m.type === 'permission_request').length, 1);
  } finally {
    dash.ws.close();
  }
});

test('losing the daemon expires pending approvals', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 96);
    d.dropClient();
    const gone = await until(() => dash.inbox.find((m) => m.type === 'permission_resolved'));
    assert.deepEqual(gone, { type: 'permission_resolved', sessionId: 'codex:t1', requestId: req.requestId, state: 'expired' });
  } finally {
    dash.ws.close();
  }
});

test('an approval whose turn ends without serverRequest/resolved is closed', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 97);
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u4', status: 'completed', items: [], error: null } });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!dash.inbox.some((m) => m.type === 'permission_resolved'));
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u3', status: 'completed', items: [], error: null } });
    const resolved = await until(() => dash.inbox.find((m) => m.type === 'permission_resolved'));
    assert.deepEqual(resolved, { type: 'permission_resolved', sessionId: 'codex:t1', requestId: req.requestId, state: 'resolved' });
    choose(dash, req.requestId, '0');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a malformed approval request falls back to the Codex warning', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(98, 'item/commandExecution/requestApproval', { threadId: 't1', turnId: 'u3', itemId: 'i9', commandActions: [null] });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Codex is waiting'));
    assert.equal(n.level, 'warning');
    assert.ok(!dash.inbox.some((m) => m.type === 'permission_request'));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a message to a running thread is steered into the turn in progress', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also update the README' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.deepEqual(d.calls('thread/turns/list')[0].params, { threadId: 't1', limit: 1, sortDirection: 'desc' });
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'u9',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] also update the README' }],
    });
    assert.equal(d.calls('turn/start').length, 0);
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Queued');
    assert.equal(n.level, 'info');
  } finally {
    dash.ws.close();
  }
});

test('a conversation with no turn list yet still gets its first message as a new turn', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/turns/list', () => {
    throw new Error('thread t1 is not materialized yet; thread/turns/list is unavailable before first user message');
  }));
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.equal(d.calls('turn/steer').length, 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
  } finally {
    dash.ws.close();
  }
});

test('a steer the daemon rejects is reported and not retried', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
    dm.handle('turn/steer', () => {
      throw new Error('no active turn to steer');
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'one more thing' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex rejected the message: no active turn to steer');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/steer').length, 1);
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a dashboard image starts a turn with the picture as a data URL', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const imageData = Buffer.from('png bytes').toString('base64');
    dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'codex:t1', imageData, mimeType: 'image/png', content: 'what is wrong here?' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.deepEqual(d.calls('turn/start')[0].params.input, [
      { type: 'text', text: '[claude-alarm · Dashboard] what is wrong here?' },
      { type: 'image', url: `data:image/png;base64,${imageData}` },
    ]);
  } finally {
    dash.ws.close();
  }
});

test('an image sent while Codex works is steered into the running turn', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    const imageData = Buffer.from('jpeg bytes').toString('base64');
    dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'codex:t1', imageData, mimeType: 'image/jpeg' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.deepEqual(d.calls('turn/steer')[0].params.input, [
      { type: 'text', text: '[claude-alarm · Dashboard] (image)' },
      { type: 'image', url: `data:image/jpeg;base64,${imageData}` },
    ]);
  } finally {
    dash.ws.close();
  }
});

test('an image that cannot be read is reported and later messages still go through', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const missing = path.join(os.tmpdir(), 'claude-alarm-missing-image.png');
    (adapter as any).onHubMessage('t1', { type: 'image_to_session', sessionId: 'codex:t1', imagePath: missing, mimeType: 'image/png', source: 'telegram' });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'The image could not be read here, so it was not delivered. Codex may be running on another PC.');
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'text still works' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] text still works');
  } finally {
    dash.ws.close();
  }
});

test('a steer to a conversation that could not be subscribed still warns when the reply is not relayed', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/resume', () => {
      throw new Error('no rollout found for thread id t1');
    });
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'one more thing' }));
    await until(() => d.calls('turn/steer').length === 1);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
    assert.equal(n.sessionId, 'codex:t1');
  } finally {
    dash.ws.close();
  }
});

test("a failing second message keeps the first message's reply-not-relayed warning", async () => {
  let running: string | undefined;
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('thread/resume', () => {
      throw new Error('no rollout found for thread id t1');
    });
    dm.handle('turn/start', () => {
      running = 'u1';
      return { turn: { id: 'u1' } };
    });
    dm.handle('thread/turns/list', () => ({ data: running ? [{ id: running, status: 'inProgress', items: [] }] : [], nextCursor: null }));
    dm.handle('turn/steer', () => {
      throw new Error('no active turn to steer');
    });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'first' }));
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'second' }));
    await until(() => dash.inbox.find((m) => m.type === 'notification' && m.message === 'Codex rejected the message: no active turn to steer'));
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
  } finally {
    dash.ws.close();
  }
});

test('a conversation closed while its message is being delivered gets no turn', async () => {
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/closed', { threadId: 't1' });
      return { data: [], nextCursor: null };
    });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello' }));
    await until(() => d.calls('thread/turns/list').length >= 1);
    await until(async () => !(await sessions()).some((x) => x.id === 'codex:t1'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/start').length, 0);
    assert.equal(d.calls('turn/steer').length, 0);
  } finally {
    dash.ws.close();
  }
});

function firstConnectDaemon(threads: any[] = []): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  return d.start().then(() => {
    d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
    d.handle('thread/read', (p) => ({ thread: threads.find((x) => x.id === p.threadId) }));
    d.handle('thread/resume', () => ({}));
    d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
    return d;
  });
}

test('the first daemon connection is reported once, with the daemon version', async () => {
  const d = await firstConnectDaemon();
  const outcomes: FirstConnect[] = [];
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200,
    onFirstConnect: (o) => outcomes.push(o),
  });
  adapter.start();
  await until(() => outcomes.length > 0);
  d.dropClient();
  await until(() => d.connections === 2, 5000);
  await until(() => d.calls('thread/loaded/list').length >= 2);
  assert.deepEqual(outcomes, [{ connected: true, userAgent: 'fake-codex/0' }]);
});

test('a missing Codex binary is reported once as not found', async () => {
  const outcomes: FirstConnect[] = [];
  const counter = { attempts: 0 };
  adapter = new CodexAdapter({
    command: MISSING, hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => {
      counter.attempts++;
      return spawn(MISSING, [], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => counter.attempts >= 3, 3000);
  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.ok(!outcome.connected);
  assert.equal(outcome.notFound, true);
  assert.match(outcome.error, /ENOENT/);
});

test('a proxy that exits at once is reported as not connected, not as not found', async () => {
  const outcomes: FirstConnect[] = [];
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => {
      attempts++;
      return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 5000);
  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.ok(!outcome.connected);
  assert.equal(outcome.notFound, false);
  assert.ok(outcome.error.length > 0);
});

test('a throwing first-connect observer does not break a healthy connection', async () => {
  const d = await firstConnectDaemon([thread('t1')]);
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200,
    onFirstConnect: () => { throw new Error('observer failed'); },
  });
  adapter.start();
  await session('codex:t1');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.connections, 1);
});

test('a throwing first-connect observer does not stop the retries', async () => {
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: () => { throw new Error('observer failed'); },
    spawnFn: () => {
      attempts++;
      return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 5000);
});

test('a stopped adapter reports nothing', async () => {
  const outcomes: FirstConnect[] = [];
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 300)'], { stdio: 'pipe' }),
  });
  adapter.start();
  adapter.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(outcomes, []);
});

test('a turn started in Codex whose subscription fails raises "Reply not relayed" when it ends', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    throw new Error('thread busy');
  }), 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
    assert.equal(n.level, 'warning');
  } finally {
    dash.ws.close();
  }
});

test('a turn started in Codex that is followed normally raises no warning', async () => {
  const d = await startAdapter([thread('t1')], undefined, 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
  } finally {
    dash.ws.close();
  }
});

test('an approval that cannot be relayed falls back to the Codex warning without answering the daemon', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const link = (adapter as any).threads.get('t1').hub;
    const send = link.send.bind(link);
    link.send = (m: any) => {
      if (m.type === 'permission_request') throw new Error('boom');
      return send(m);
    };
    d.serverRequest(99, 'item/commandExecution/requestApproval', approvalParams);
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Codex is waiting'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.');
    assert.equal((adapter as any).approvals.size, 0);
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

const waiting = { type: 'active', activeFlags: ['waitingOnApproval'] };
const WAITING_NOTICE = 'Codex is waiting for an approval or input. Answer it first, then send the message again.';

test('an approval that starts while a message is being prepared gets no steer', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/status/changed', { threadId: 't1', status: waiting });
      return { data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null };
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also this' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal(n.level, 'warning');
    assert.equal(n.message, WAITING_NOTICE);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/steer').length, 0);
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('an approval that starts while a message is being prepared gets no new turn either', async () => {
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/status/changed', { threadId: 't1', status: waiting });
      return { data: [], nextCursor: null };
    });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal(n.message, WAITING_NOTICE);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a message refused at the last moment does not leave the conversation marked busy', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/started', { thread: thread('t1', { status: waiting }) });
      return { data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null };
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also this' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal((adapter as any).threads.get('t1').pendingTurn, false);
    assert.equal(d.calls('turn/steer').length, 0);
  } finally {
    dash.ws.close();
  }
});

function hubSends(threadId: string): any[] {
  const link = (adapter as any).threads.get(threadId).hub;
  const sent: any[] = [];
  const send = link.send.bind(link);
  link.send = (m: any) => {
    sent.push(m);
    return send(m);
  };
  return sent;
}

const steering = (dm: FakeDaemon) =>
  dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));

test('the Queued notice is addressed to where the message came from', async () => {
  await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const toHub = hubSends('t1');
  for (const source of ['telegram', 'api', 'dashboard']) {
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: `from ${source}`, source });
  }
  const queued = await until(() => {
    const q = toHub.filter((m) => m.type === 'notify' && m.title === 'Queued');
    return q.length === 3 && q;
  });
  assert.deepEqual(queued.map((m) => m.to), ['telegram', 'api', 'dashboard']);
});

test('a Queued notice for a message from Telegram does not reach the dashboard', async () => {
  const d = await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from phone', source: 'telegram' });
    await until(() => d.calls('turn/steer').length === 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(dash.inbox.filter((m) => m.type === 'notification' && m.title === 'Queued'), []);
  } finally {
    dash.ws.close();
  }
});

test('a Queued notice for a message without a source still goes everywhere', async () => {
  await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    const toHub = hubSends('t1');
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from an old hub' });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Queued'));
    assert.equal(n.level, 'info');
    assert.equal('to' in toHub.find((m) => m.type === 'notify'), false);
  } finally {
    dash.ws.close();
  }
});

test('other notices stay unaddressed even for a message from Telegram', async () => {
  await startAdapter([thread('t1', { status: active })], (dm) => {
    steering(dm);
    dm.handle('turn/steer', () => {
      throw new Error('no active turn to steer');
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const toHub = hubSends('t1');
  (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from phone', source: 'telegram' });
  const n = await until(() => toHub.find((m) => m.type === 'notify'));
  assert.equal(n.title, 'Not delivered');
  assert.equal('to' in n, false);
});
