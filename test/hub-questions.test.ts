// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { QuestionBook } from '../src/hub/questions.js';

const PORT = 7983;
const TOKEN = 'question-test';
let hub: HubServer;
const desktop: unknown[][] = [];

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  (hub as any).notifier.notifyWithSession = async (...args: unknown[]) => { desktop.push(args); };
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

async function channel(id: string) {
  const ch = await open('/ws/channel');
  ch.ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
  await settle();
  return ch;
}

const questions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: false },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];

const ask = (ws: WebSocket, sessionId: string, requestId: string, extra: object = {}) =>
  ws.send(JSON.stringify({ type: 'question', sessionId, requestId, questions, timestamp: 1, ...extra }));

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg));
const of = (inbox: any[], type: string) => inbox.filter((m) => m.type === type);

test('a question reaches every dashboard and the desktop, and a new dashboard gets it as pending', async () => {
  desktop.length = 0;
  const ch = await channel('s1');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's1', 'r1', { context: 'Two things first.' });
  await settle();
  const [q] = of(dash.inbox, 'question');
  assert.equal(q.requestId, 'r1');
  assert.equal(q.context, 'Two things first.');
  assert.deepEqual(q.questions, questions);
  assert.deepEqual(desktop, [[undefined, undefined, '[s1] Question', 'Which color do you prefer? (+1 more)', 'warning']]);
  const late = await open('/ws/dashboard');
  await settle();
  const [pending] = of(late.inbox, 'questions_pending');
  assert.deepEqual(pending.requests.map((r: any) => [r.requestId, r.sending]), [['r1', false]]);
  late.ws.close();
  dash.ws.close();
  ch.ws.close();
});

test('an answer goes to the session with the questions and its source, and is answered only once the session takes it', async () => {
  const ch = await channel('s2');
  const dash = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  ask(ch.ws, 's2', 'r2');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: ' Blue ', q2: 'Probe' } });
  await settle();
  assert.deepEqual(of(ch.inbox, 'question_answer'), [{
    type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Blue', q2: 'Probe' }, questions, source: 'dashboard',
  }]);
  assert.deepEqual(of(other.inbox, 'question_sending'), [{ type: 'question_sending', sessionId: 's2', requestId: 'r2', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' }]);
  assert.deepEqual(of(other.inbox, 'question_resolved'), []);
  send(other.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Red', q2: 'X' } });
  await settle();
  assert.deepEqual(of(other.inbox, 'question_rejected'), [{ type: 'question_rejected', sessionId: 's2', requestId: 'r2', reason: 'the question is already being answered' }]);
  const late = await open('/ws/dashboard');
  await settle();
  assert.equal(of(late.inbox, 'questions_pending')[0].requests.find((r: any) => r.requestId === 'r2').sending, true);
  send(ch.ws, { type: 'question_delivery', sessionId: 's2', requestId: 'r2', ok: true });
  await settle();
  assert.deepEqual(of(other.inbox, 'question_resolved'), [{ type: 'question_resolved', sessionId: 's2', requestId: 'r2', state: 'answered', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' }]);
  send(other.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Red', q2: 'X' } });
  await settle();
  assert.equal(of(other.inbox, 'question_rejected')[1].reason, 'the question is no longer open');
  assert.equal(of(ch.inbox, 'question_answer').length, 1);
  for (const c of [late, other, dash, ch]) c.ws.close();
});

test('a session that cannot take the answer reopens the question for everyone', async () => {
  const ch = await channel('s3');
  const dash = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  ask(ch.ws, 's3', 'r3');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's3', requestId: 'r3', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(ch.ws, { type: 'question_delivery', sessionId: 's3', requestId: 'r3', ok: false, reason: 'Codex is waiting for an approval or input' });
  await settle();
  for (const d of [dash, other]) {
    assert.deepEqual(of(d.inbox, 'question_rejected'), [{ type: 'question_rejected', sessionId: 's3', requestId: 'r3', reason: 'Codex is waiting for an approval or input' }]);
  }
  send(other.ws, { type: 'question_answer', sessionId: 's3', requestId: 'r3', answers: { q1: 'Blue', q2: 'B' } });
  await settle();
  assert.equal(of(ch.inbox, 'question_answer').length, 2);
  assert.equal(of(ch.inbox, 'question_answer')[1].answers.q1, 'Blue');
  for (const c of [other, dash, ch]) c.ws.close();
});

test('an incomplete or out-of-list answer is refused with the reason and nothing reaches the session', async () => {
  const ch = await channel('s4');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's4', 'r4');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's4', requestId: 'r4', answers: { q1: 'Blue' } });
  send(dash.ws, { type: 'question_answer', sessionId: 's4', requestId: 'r4', answers: { q1: 'Green', q2: 'A' } });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_rejected').map((m) => m.reason), ['question q2 has no answer', 'the answer to q1 is not one of its options']);
  assert.deepEqual(of(ch.inbox, 'question_answer'), []);
  dash.ws.close();
  ch.ws.close();
});

test('a plain dashboard message closes the open questions but not one being answered', async () => {
  const ch = await channel('s5');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's5', 'open-one');
  ask(ch.ws, 's5', 'sending-one');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's5', requestId: 'sending-one', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(dash.ws, { type: 'message_to_session', sessionId: 's5', content: 'never mind, use green' });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved'), [{ type: 'question_resolved', sessionId: 's5', requestId: 'open-one', state: 'closed' }]);
  dash.ws.close();
  ch.ws.close();
});

test('/api/send also closes the open questions', async () => {
  const ch = await channel('s6');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's6', 'r6');
  await settle();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's6', content: 'hi' }),
  });
  assert.equal(res.status, 200);
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r6', 'closed']]);
  dash.ws.close();
  ch.ws.close();
});

test('a dashboard image also closes the open questions', async () => {
  const ch = await channel('s7');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's7', 'r7');
  await settle();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  send(dash.ws, { type: 'image_upload', sessionId: 's7', imageData: png, mimeType: 'image/png', originalName: 'a.png' });
  await settle();
  assert.equal(of(ch.inbox, 'image_to_session').length, 1);
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r7', 'closed']]);
  dash.ws.close();
  ch.ws.close();
});

test('Telegram text and photos close the open questions once delivered', async () => {
  const ch = await channel('s8');
  const dash = await open('/ws/dashboard');
  const bot: any = {};
  (hub as any).wireTelegram(bot);
  try {
    ask(ch.ws, 's8', 'r8a');
    await settle();
    assert.equal(bot.onMessageToSession('s8', 'from my phone'), true);
    ask(ch.ws, 's8', 'r8b');
    await settle();
    assert.equal(bot.onImageToSession('s8', 'C:/x.png', 'image/png', 'look'), true);
    await settle();
    assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r8a', 'closed'], ['r8b', 'closed']]);
  } finally {
    (hub as any).notifier.telegramBot = undefined;
    dash.ws.close();
    ch.ws.close();
  }
});

test('a session that disconnects expires its questions, including one being answered', async () => {
  const ch = await channel('s9');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's9', 'open-one');
  ask(ch.ws, 's9', 'sending-one');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's9', requestId: 'sending-one', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  ch.ws.close();
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]).sort(), [['open-one', 'expired'], ['sending-one', 'expired']]);
  dash.ws.close();
});

test('removing a session through the API expires its questions', async () => {
  const ch = await channel('s10');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's10', 'r10');
  await settle();
  await fetch(`http://127.0.0.1:${PORT}/api/sessions/s10`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r10', 'expired']]);
  dash.ws.close();
});

test('the same session reconnecting on a new socket keeps its questions', async () => {
  const first = await channel('s11');
  ask(first.ws, 's11', 'r11');
  await settle();
  const second = await channel('s11');
  await settle();
  const dash = await open('/ws/dashboard');
  await settle();
  assert.equal(of(dash.inbox, 'questions_pending')[0].requests.some((r: any) => r.requestId === 'r11'), true);
  assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
  send(dash.ws, { type: 'question_answer', sessionId: 's11', requestId: 'r11', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  assert.equal(of(second.inbox, 'question_answer').length, 1);
  dash.ws.close();
  second.ws.close();
});

test("another session's socket cannot ask or confirm for this session", async () => {
  const mine = await channel('s12');
  const intruder = await channel('s12-other');
  const dash = await open('/ws/dashboard');
  ask(intruder.ws, 's12', 'forged');
  ask(mine.ws, 's12', 'r12');
  await settle();
  assert.deepEqual(of(dash.inbox, 'question').map((m) => m.requestId), ['r12']);
  send(dash.ws, { type: 'question_answer', sessionId: 's12', requestId: 'r12', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(intruder.ws, { type: 'question_delivery', sessionId: 's12', requestId: 'r12', ok: true });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
  for (const c of [dash, intruder, mine]) c.ws.close();
});

test('malformed and repeated questions are ignored, even after the first one closed', async () => {
  const ch = await channel('s13');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's13', 'bad id');
  ask(ch.ws, 's13', 'r13', { questions: [] });
  ask(ch.ws, 's13', 'r13');
  ask(ch.ws, 's13', 'r13');
  await settle();
  send(dash.ws, { type: 'message_to_session', sessionId: 's13', content: 'closing it' });
  await settle();
  ask(ch.ws, 's13', 'r13');
  await settle();
  assert.equal(of(dash.inbox, 'question').length, 1);
  dash.ws.close();
  ch.ws.close();
});

test('the question book keeps at most its limit open and remembers what it closed', () => {
  const book = new QuestionBook(2, 2);
  const req = (id: string) => ({ sessionId: 's', requestId: id, questions: [], timestamp: 0 });
  assert.deepEqual(book.add(req('a')), []);
  assert.deepEqual(book.add(req('b')), []);
  assert.deepEqual(book.add(req('c'))!.map((r) => r.requestId), ['a']);
  assert.equal(book.add(req('a')), null);
  assert.equal(book.add(req('b')), null);
  assert.equal(book.take('s', 'b')!.request.requestId, 'b');
  assert.equal(book.add(req('b')), null);
  book.take('s', 'c');
  assert.deepEqual(book.add(req('a')), []);
  assert.deepEqual(book.all().map((q) => q.request.requestId), ['a']);
});

test('questions, results and reopenings reach Telegram, and a Telegram answer goes to the session', async () => {
  const calls: string[] = [];
  const bot: any = {
    sendQuestion: async (sessionId: string, label: string, request: any) => { calls.push(`send ${sessionId} ${label} ${request.requestId}`); },
    resolveQuestion: async (sessionId: string, requestId: string, state: string, answers?: any, source?: string) => { calls.push(`resolve ${requestId} ${state} ${JSON.stringify(answers ?? null)} ${source ?? '-'}`); },
    reopenQuestion: async (sessionId: string, requestId: string, reason: string) => { calls.push(`reopen ${requestId} ${reason}`); },
  };
  (hub as any).telegramBot = bot;
  (hub as any).wireTelegram(bot);
  const ch = await channel('s14');
  try {
    ask(ch.ws, 's14', 'r14');
    await settle();
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Red' }), 'question q2 has no answer');
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Red', q2: 'From phone' }), 'ok');
    await settle();
    assert.equal(of(ch.inbox, 'question_answer')[0].source, 'telegram');
    send(ch.ws, { type: 'question_delivery', sessionId: 's14', requestId: 'r14', ok: false, reason: 'busy' });
    await settle();
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Blue', q2: 'Again' }), 'ok');
    await settle();
    send(ch.ws, { type: 'question_delivery', sessionId: 's14', requestId: 'r14', ok: true });
    await settle();
    assert.deepEqual(calls, [
      'send s14 s14 r14',
      'reopen r14 busy',
      'resolve r14 answered {"q1":"Blue","q2":"Again"} telegram',
    ]);
  } finally {
    (hub as any).telegramBot = undefined;
    (hub as any).notifier.telegramBot = undefined;
    ch.ws.close();
  }
});
