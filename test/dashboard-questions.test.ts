import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function section(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start > 0 && end > start, `anchors not found: ${from.trim()}`);
  return html.slice(start, end);
}

// The dashboard is a single inline-script HTML file; evaluate the question block in a sandbox.
function load(selectedSession = 's1') {
  const flashes: string[] = [];
  const sent: any[] = [];
  const errors: Array<string | null> = [];
  const mention = { textContent: '' };
  const renders = { messages: 0, sessions: 0, notifications: 0 };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#mentionError' ? mention : null),
    state: { selectedSession, messages: {}, notifications: [], unread: {}, waitingReply: { s1: true }, questionDrafts: {}, composing: false, ws: { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) } },
    WebSocket: { OPEN: 1 },
    document: { activeElement: null, querySelectorAll: () => [] },
    CSS: { escape: (s: string) => s },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderMarkdown: (s: string) => `<md>${s}</md>`,
    renderMessages: () => { renders.messages++; },
    renderSessions: () => { renders.sessions++; },
    renderNotifications: () => { renders.notifications++; },
    saveMessages: () => {},
    flashTitle: (m: string) => flashes.push(m),
    showMentionError: (m: string | null) => { errors.push(m); mention.textContent = m || ''; },
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // --- Questions ---', '  // --- Permission relay ---'), ctx);
  return { ctx, flashes, sent, errors, renders, mention };
}

const questions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue', description: 'the calm one' }], allowOther: true },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];
const ask = (extra: object = {}) => ({ type: 'question', sessionId: 's1', requestId: 'r1', questions, timestamp: 5, ...extra });
const card = (ctx: any, sid = 's1', requestId = 'r1') => ctx.state.messages[sid].find((m: any) => m.requestId === requestId);

test('the dashboard routes the question messages to their handlers', () => {
  assert.match(html, /case 'question':\s*showQuestion\(msg\);\s*break;/);
  assert.match(html, /case 'questions_pending':\s*restorePendingQuestions\(msg\.requests \|\| \[\]\);\s*break;/);
  assert.match(html, /case 'question_sending':\s*markQuestionSending\(msg\);\s*break;/);
  assert.match(html, /case 'question_resolved':\s*resolveQuestionCard\(msg\);\s*break;/);
  assert.match(html, /case 'question_rejected':\s*rejectQuestionCard\(msg\);\s*break;/);
  assert.match(html, /setInterval\(\(\) => \{ if \(!typingInQuestion\(\)\) renderMessages\(\); renderNotifications\(\); \}, 30000\);/);
});

test('a question joins the conversation once, stops the typing dots, and raises one notice', () => {
  const { ctx, flashes } = load('other');
  ctx.showQuestion(ask({ context: 'Two ways.' }));
  ctx.showQuestion(ask());
  const msgs = ctx.state.messages.s1;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'question');
  assert.equal(msgs[0].state, 'open');
  assert.equal(msgs[0].context, 'Two ways.');
  assert.equal(ctx.state.waitingReply.s1, false);
  assert.equal(ctx.state.unread.s1, 1);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.notifications[0].title, 'Question');
  assert.equal(ctx.state.notifications[0].message, 'Which color do you prefer? (+1 more)');
  assert.equal(ctx.state.notifications[0].level, 'warning');
  assert.deepEqual(flashes, ['Question']);
});

test('restoring adds missing questions with one notice, sets the lock from the hub, and marks vanished ones', () => {
  const { ctx, flashes } = load();
  ctx.state.messages = {
    s1: [
      { kind: 'question', requestId: 'stuck', questions, state: 'sending', answers: { q1: 'Red', q2: 'A' } },
      { kind: 'question', requestId: 'gone', questions, state: 'open' },
      { kind: 'question', requestId: 'done', questions, state: 'answered' },
    ],
  };
  ctx.restorePendingQuestions([
    { sessionId: 's1', requestId: 'stuck', questions, timestamp: 1, sending: false },
    { sessionId: 's2', requestId: 'new', questions, timestamp: 2, sending: true },
  ]);
  assert.equal(card(ctx, 's1', 'stuck').state, 'open');
  assert.equal(card(ctx, 's1', 'stuck').answers, null);
  assert.equal(card(ctx, 's1', 'gone').state, 'gone');
  assert.equal(card(ctx, 's1', 'done').state, 'answered');
  assert.equal(card(ctx, 's2', 'new').state, 'sending');
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.notifications[0].title, '1 question(s) waiting');
  assert.deepEqual(flashes, ['1 question(s) waiting']);
  ctx.restorePendingQuestions([]);
  assert.equal(ctx.state.notifications.length, 1);
});

test('sending, answered, and rejected update the card; a rejection reopens it with the reason', () => {
  const { ctx, errors } = load();
  ctx.showQuestion(ask());
  ctx.markQuestionSending({ sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'A' }, source: 'telegram' });
  assert.equal(card(ctx).state, 'sending');
  assert.equal(card(ctx).source, 'telegram');
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'Codex is waiting for an approval or input' });
  assert.equal(card(ctx).state, 'open');
  assert.equal(card(ctx).error, 'Codex is waiting for an approval or input');
  assert.deepEqual(errors, ['Answer not delivered: Codex is waiting for an approval or input']);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Red', other: '' } };
  ctx.resolveQuestionCard({ sessionId: 's1', requestId: 'r1', state: 'answered', answers: { q1: 'Blue', q2: 'B' }, source: 'dashboard' });
  assert.equal(card(ctx).state, 'answered');
  assert.deepEqual({ ...card(ctx).answers }, { q1: 'Blue', q2: 'B' });
  assert.equal(card(ctx).error, null);
  assert.equal(ctx.state.questionDrafts.r1, undefined);
  ctx.markQuestionSending({ sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'C' }, source: 'dashboard' });
  assert.equal(card(ctx).state, 'answered');
});

test('the "Answer not delivered" line goes when a card of this session is sent again or resolved, and other lines stay', () => {
  const { ctx, mention } = load();
  ctx.showQuestion(ask());
  ctx.showQuestion(ask({ requestId: 'r2' }));
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'busy' });
  assert.equal(mention.textContent, 'Answer not delivered: busy');
  ctx.sendQuestionAnswer('s1', card(ctx), { q1: 'Red', q2: 'A' });
  assert.equal(mention.textContent, '');
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'busy' });
  ctx.resolveQuestionCard({ sessionId: 's1', requestId: 'r1', state: 'closed' });
  assert.equal(mention.textContent, '');
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r2', reason: 'busy' });
  ctx.state.messages.s2 = [{ kind: 'question', requestId: 'x', questions, state: 'open' }];
  ctx.resolveQuestionCard({ sessionId: 's2', requestId: 'x', state: 'expired' });
  assert.equal(mention.textContent, 'Answer not delivered: busy');
  ctx.showMentionError('Message not delivered: the session is not connected');
  ctx.sendQuestionAnswer('s1', card(ctx, 's1', 'r2'), { q1: 'Red', q2: 'A' });
  ctx.resolveQuestionCard({ sessionId: 's1', requestId: 'r2', state: 'answered', answers: { q1: 'Red', q2: 'A' }, source: 'dashboard' });
  assert.equal(mention.textContent, 'Message not delivered: the session is not connected');
});

test('an answer that lost the race to another one leaves the card sending with the winner, without a red line', () => {
  const { ctx, errors } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  ctx.sendQuestionAnswer('s1', m, { q1: 'Red', q2: 'Mine' });
  ctx.markQuestionSending({ sessionId: 's1', requestId: 'r1', answers: { q1: 'Blue', q2: 'Theirs' }, source: 'telegram' });
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'the question is already being answered' });
  assert.equal(m.state, 'sending');
  assert.deepEqual({ ...m.answers }, { q1: 'Blue', q2: 'Theirs' });
  assert.equal(m.error, null);
  assert.deepEqual(errors, []);
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'the session could not take the answer' });
  assert.equal(m.state, 'open');
  assert.deepEqual(errors, ['Answer not delivered: the session could not take the answer']);
});

test('a card restored while its answer is being sent shows that answer and where it came from', () => {
  const { ctx } = load();
  ctx.state.messages = { s1: [{ kind: 'question', requestId: 'known', questions, state: 'open', answers: null, source: null }] };
  ctx.restorePendingQuestions([
    { sessionId: 's1', requestId: 'known', questions, timestamp: 1, sending: true, answers: { q1: 'Red', q2: 'Ann' }, source: 'telegram' },
    { sessionId: 's1', requestId: 'new', questions, timestamp: 2, sending: true, answers: { q1: 'Blue', q2: 'Bo' }, source: 'api' },
  ]);
  for (const [id, q1, source] of [['known', 'Red', 'telegram'], ['new', 'Blue', 'api']]) {
    const m = card(ctx, 's1', id);
    assert.equal(m.state, 'sending');
    assert.equal(m.answers.q1, q1);
    assert.equal(m.source, source);
    const html = ctx.questionCardHtml(m);
    assert.match(html, new RegExp(`&rarr; ${q1}`));
    assert.match(html, /Sending…/);
  }
});

test('a typed answer wins over a picked option, and every question needs one before sending', () => {
  const { ctx } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  assert.equal(ctx.readyAnswers(m), null);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Blue', other: '' } };
  assert.equal(ctx.readyAnswers(m), null);
  ctx.state.questionDrafts.r1.q2 = { choice: '', other: '  Probe ' };
  assert.deepEqual({ ...ctx.readyAnswers(m) }, { q1: 'Blue', q2: 'Probe' });
  ctx.state.questionDrafts.r1.q1 = { choice: 'Blue', other: 'Teal' };
  assert.equal(ctx.readyAnswers(m).q1, 'Teal');
});

test('an open card shows buttons with descriptions, typing boxes, and Send only for several questions', () => {
  const { ctx } = load();
  ctx.showQuestion(ask({ context: 'Two ways.' }));
  const many = ctx.questionCardHtml(card(ctx));
  assert.match(many, /<div class="question-context"><md>Two ways\.<\/md><\/div>/);
  assert.match(many, /<button type="button" class="question-option" data-q="q1" data-i="1">Blue<span class="question-option-desc">the calm one<\/span><\/button>/);
  assert.match(many, /<input type="text" class="question-other" data-q="q2" placeholder="Type your answer">/);
  assert.match(many, /<button type="button" class="question-send" disabled>Send<\/button>/);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Red', other: '' }, q2: { choice: '', other: 'x' } };
  const ready = ctx.questionCardHtml(card(ctx));
  assert.match(ready, /class="question-option selected" data-q="q1" data-i="0"/);
  assert.match(ready, /<button type="button" class="question-send">Send<\/button>/);
  ctx.showQuestion(ask({ requestId: 'one', questions: [questions[0]] }));
  const single = ctx.questionCardHtml(card(ctx, 's1', 'one'));
  assert.doesNotMatch(single, /question-send/);
  assert.match(single, /placeholder="Or type your own answer \(Enter to send\)"/);
});

test('a closed card shows the answers and why it closed, without buttons', () => {
  const { ctx } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  Object.assign(m, { state: 'answered', answers: { q1: 'Blue', q2: '<b>x</b>' }, source: 'telegram' });
  const answered = ctx.questionCardHtml(m);
  assert.doesNotMatch(answered, /question-option|question-other/);
  assert.match(answered, /&rarr; Blue/);
  assert.match(answered, /&rarr; &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(answered, /Answered &middot; Telegram/);
  for (const [state, text] of [['closed', 'Closed — a message was sent instead'], ['expired', 'Expired — the session ended'], ['gone', 'No longer open'], ['sending', 'Sending…']]) {
    Object.assign(m, { state, answers: null });
    assert.match(ctx.questionCardHtml(m), new RegExp(text));
  }
});

test('sending an answer posts it to the hub and locks the card', () => {
  const { ctx, sent } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  ctx.sendQuestionAnswer('s1', m, { q1: 'Red', q2: 'A' });
  assert.deepEqual(sent, [{ type: 'question_answer', sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'A' } }]);
  assert.equal(m.state, 'sending');
  assert.equal(m.source, 'dashboard');
  ctx.state.ws = null;
  m.state = 'open';
  ctx.sendQuestionAnswer('s1', m, { q1: 'Red', q2: 'A' });
  assert.equal(m.error, 'Not connected to the hub');
  assert.equal(m.state, 'open');
});

test('the time refresh waits while an answer is being typed', () => {
  const { ctx } = load();
  assert.equal(ctx.typingInQuestion(), false);
  ctx.document.activeElement = { classList: { contains: (c: string) => c === 'question-other' } };
  assert.equal(ctx.typingInQuestion(), true);
  ctx.document.activeElement = null;
  ctx.state.composing = true;
  assert.equal(ctx.typingInQuestion(), true);
});

test('headers, labels and descriptions from a session are escaped in the card', () => {
  const { ctx } = load();
  ctx.showQuestion(ask({ requestId: 'x', questions: [{ id: 'q1', header: '<i>h</i>', question: 'Q', options: [{ label: '<b>A</b>', description: '<x>' }, { label: 'B' }], allowOther: false }] }));
  const html = ctx.questionCardHtml(card(ctx, 's1', 'x'));
  assert.match(html, /<span class="question-header">&lt;i&gt;h&lt;\/i&gt;<\/span>/);
  assert.match(html, />&lt;b&gt;A&lt;\/b&gt;<span class="question-option-desc">&lt;x&gt;<\/span><\/button>/);
  assert.doesNotMatch(html, /<b>A<\/b>|<i>h<\/i>/);
  assert.doesNotMatch(html, /question-other/);
});
