// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { asyncQuestions, userInputShape } from '../src/codex/mapping.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7985;
const TOKEN = 'codex-question-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  (hub as any).notifier.notifyWithSession = async () => {};
  await hub.start();
});
after(async () => { await hub.stop(); });
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  await daemon?.stop();
  daemon = undefined;
  await until(async () => !(await sessions()).some((s) => s.id.startsWith('codex:')));
});

const active = { type: 'active', activeFlags: [] };

function thread(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Thread ${id}`, preview: '', cwd: 'C:\\w\\proj', status: { type: 'idle' }, parentThreadId: null, ephemeral: false, ...extra };
}

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

const session = (id: string) => until(async () => (await sessions()).find((s) => s.id === id));

async function startAdapter(threads: any[], setup?: (d: FakeDaemon) => void): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  await d.start();
  d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
  d.handle('thread/read', (p) => ({ thread: threads.find((x) => x.id === p.threadId) }));
  d.handle('thread/resume', () => ({}));
  d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('turn/steer', (p) => ({ turnId: p.expectedTurnId }));
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

// The agentMessage Codex 0.160.1 sent in the 2026-10-06 probe.
const asking = (id = 'call_1', text = 'Which color do you prefer?\n- Red\n- Blue\n\nWhat name should I use?') => ({
  type: 'agentMessage',
  id,
  text,
  phase: 'final_answer',
  memoryCitation: null,
  delivery: 'async',
  questions: [{ title: 'Which color do you prefer?', options: ['Red', 'Blue'] }, { title: 'What name should I use?', options: null }],
});

const expectedQuestions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: true },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];

const of = (inbox: any[], type: string, sessionId = 'codex:t1') => inbox.filter((m) => m.type === type && m.sessionId === sessionId);

test('the card leaves out the lines that only repeat the questions and keeps the rest as context', () => {
  assert.deepEqual(asyncQuestions(asking()), { questions: expectedQuestions });
  const withIntro = asyncQuestions(asking('x', 'Two quick things before I plan.\n\nWhich color do you prefer?\n1. Red\n2) Blue\n\nWhat name should I use?'));
  assert.equal(withIntro?.context, 'Two quick things before I plan.');
  assert.equal(asyncQuestions({ text: 'plain', phase: 'final_answer' }), null);
  assert.equal(asyncQuestions({ ...asking(), questions: [{ title: '', options: null }] } as any), null);
  assert.equal(asyncQuestions({ ...asking(), questions: [{ title: 'Pick', options: ['A', 'A'] }] } as any), null);
});

test('a question from Codex reaches the dashboard at once, before the turn ends', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking() });
    const [q] = await until(() => of(dash.inbox, 'question').length && of(dash.inbox, 'question'));
    assert.equal(q.requestId, 'codex-q:call_1');
    assert.equal(q.context, undefined);
    assert.deepEqual(q.questions, expectedQuestions);
  } finally {
    dash.ws.close();
  }
});

test('the question is not sent again as a reply when the turn ends, while a later answer still is', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_3') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm2', text: 'You prefer Blue.', phase: 'final_answer' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_3')], error: null } });
    const reply = await until(() => of(dash.inbox, 'reply_from_session')[0]);
    assert.equal(reply.content, 'You prefer Blue.');
    assert.equal(of(dash.inbox, 'question').length, 1);
  } finally {
    dash.ws.close();
  }
});

test('a turn that only asked ends without a reply', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_4') });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_4')], error: null } });
    await until(() => of(dash.inbox, 'question').length);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(of(dash.inbox, 'reply_from_session'), []);
  } finally {
    dash.ws.close();
  }
});

test('a question seen only in the turn summary is sent once when the turn ends', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_9')], error: null } });
    const [q] = await until(() => of(dash.inbox, 'question').length && of(dash.inbox, 'question'));
    assert.equal(q.requestId, 'codex-q:call_9');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(of(dash.inbox, 'question').length, 1);
    assert.deepEqual(of(dash.inbox, 'reply_from_session'), []);
  } finally {
    dash.ws.close();
  }
});

test('a question Codex shaped wrongly falls back to the old reply', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const broken = { ...asking(), questions: [{ title: '', options: null }] };
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: broken });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => of(dash.inbox, 'reply_from_session')[0]);
    assert.equal(reply.content, broken.text);
    assert.deepEqual(of(dash.inbox, 'question'), []);
  } finally {
    dash.ws.close();
  }
});

test('a hub that does not say it supports questions gets the question as the turn reply, as before', async () => {
  (hub as any).sendHubInfo = () => {};
  try {
    const d = await startAdapter([thread('t1', { status: active })]);
    await session('codex:t1');
    const dash = await openDashboard();
    try {
      d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_old') });
      d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_old')], error: null } });
      const reply = await until(() => of(dash.inbox, 'reply_from_session')[0]);
      assert.equal(reply.content, asking().text);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(of(dash.inbox, 'question'), []);
    } finally {
      dash.ws.close();
    }
  } finally {
    delete (hub as any).sendHubInfo;
  }
});

test('an answer is steered into the turn Codex is waiting in and confirmed without a Queued notice', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u1', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_7') });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_7', answers: { q1: 'Blue', q2: 'Probe' } }));
    const resolved = await until(() => of(dash.inbox, 'question_resolved')[0]);
    assert.deepEqual(resolved, { type: 'question_resolved', sessionId: 'codex:t1', requestId: 'codex-q:call_7', state: 'answered', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' });
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'u1',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe' }],
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(of(dash.inbox, 'notification'), []);
  } finally {
    dash.ws.close();
  }
});

test('an answer after the turn ended starts a new turn', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_8')], error: null } });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_8', answers: { q1: 'Red', q2: 'Ann' } }));
    await until(() => of(dash.inbox, 'question_resolved').length);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Red\n- What name should I use? → Ann');
  } finally {
    dash.ws.close();
  }
});

test('an answer while Codex waits for an approval reopens the card with the reason and sends nothing', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_9a') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await until(async () => (await sessions()).find((s) => s.id === 'codex:t1' && s.status === 'waiting_input'));
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_9a', answers: { q1: 'Blue', q2: 'P' } }));
    const rejected = await until(() => of(dash.inbox, 'question_rejected')[0]);
    assert.equal(rejected.reason, 'Codex is waiting for an approval or input');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(of(dash.inbox, 'notification'), []);
    assert.equal(d.calls('turn/steer').length + d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a steer the daemon refuses reopens the card with the error', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u1', status: 'inProgress', items: [] }], nextCursor: null }));
    dm.handle('turn/steer', () => { throw new Error('expected turn u1 is no longer running'); });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_10') });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_10', answers: { q1: 'Blue', q2: 'P' } }));
    const rejected = await until(() => of(dash.inbox, 'question_rejected')[0]);
    assert.equal(rejected.reason, 'Codex rejected the message: expected turn u1 is no longer running');
  } finally {
    dash.ws.close();
  }
});

test('requestUserInput still points to Codex and logs only its shape', async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, 'warn', (msg: string) => { warnings.push(msg); });
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(7, 'item/tool/requestUserInput', {
      threadId: 't1', turnId: 'u3', itemId: 'i1', isBlocking: true,
      questions: [{ id: 'pw', header: 'Login', question: `Password? ${'x'.repeat(300)}`, isOther: false, isSecret: true, options: null }],
    });
    const n = await until(() => of(dash.inbox, 'notification')[0]);
    assert.match(n.message, /Handle it in Codex/);
    const line = warnings.find((w) => w.startsWith('Codex requestUserInput not relayed: '));
    assert.ok(line, 'the requestUserInput shape is logged');
    const shape = JSON.parse(line.slice('Codex requestUserInput not relayed: '.length));
    assert.deepEqual(shape, { isBlocking: true, questions: [{ id: 'pw', header: 'Login', question: `Password? ${'x'.repeat(190)}`, options: null, isOther: false, isSecret: true }] });
  } finally {
    dash.ws.close();
  }
});

test('the logged shape stays within 2000 characters', () => {
  const many = { questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, question: 'y'.repeat(200) })) };
  assert.equal(userInputShape(many).length, 2000);
});

test('a question stays open when Codex stops the turn, and its answer starts a new turn', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_11') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'interrupted', items: [], error: null } });
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const stopped = await until(() => of(dash.inbox, 'notification')[0]);
    assert.equal(stopped.title, 'Codex task stopped');
    assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_11', answers: { q1: 'Red', q2: 'Ann' } }));
    await until(() => of(dash.inbox, 'question_resolved').length);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Red\n- What name should I use? → Ann');
  } finally {
    dash.ws.close();
  }
});
