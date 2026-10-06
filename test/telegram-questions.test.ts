// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, visibleLength } from '../src/hub/telegram.js';
import type { QuestionRequest } from '../src/shared/types.js';

function setup(t: any, outcome = 'ok') {
  const calls: Array<{ api: string; body: any }> = [];
  let nextId = 100;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const api = String(url).split('/').pop()!;
    calls.push({ api, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: api === 'sendMessage' ? nextId++ : 0 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const submitted: any[] = [];
  const delivered: string[] = [];
  bot.onQuestionAnswer = (sessionId, requestId, answers) => { submitted.push({ sessionId, requestId, answers }); return outcome; };
  bot.onMessageToSession = (sessionId, content) => { delivered.push(`${sessionId}:${content}`); return true; };
  return { bot, calls, submitted, delivered };
}

const color = { id: 'q1', header: 'Color', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: true };
const name = { id: 'q2', question: 'What name should I use?', options: null, allowOther: true };
const fixed = { id: 'q3', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }], allowOther: false };
const request = (questions: any[], extra: Partial<QuestionRequest> = {}): QuestionRequest =>
  ({ sessionId: 's1', requestId: 'r1', questions, timestamp: 0, ...extra });

const sends = (calls: any[]) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body);
const edits = (calls: any[]) => calls.filter((c) => c.api === 'editMessageText').map((c) => c.body);
const toasts = (calls: any[]) => calls.filter((c) => c.api === 'answerCallbackQuery').map((c) => c.body.text);
const buttonsOf = (body: any) => (body.reply_markup?.inline_keyboard ?? []).flat();
const press = (bot: TelegramBot, data: string, messageId = 100) =>
  (bot as any).handleCallbackQuery({ id: 'cb', data, message: { chat: { id: 111 }, message_id: messageId, text: '' } });
const replyTo = (bot: TelegramBot, messageId: number, text: string) =>
  (bot as any).handleIncomingMessage({ message_id: 999, chat: { id: 111 }, text, reply_to_message: { message_id: messageId } });

test('a single question is one message with the context, a button per option, and a reply hint', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'weekly · proj', request([color], { context: 'Two ways **to** do it.' }));
  const [msg] = sends(calls);
  assert.equal(sends(calls).length, 1);
  assert.match(msg.text, /^❓ <b>Question<\/b> — weekly · proj\n\nTwo ways <b>to<\/b> do it\.\n\n<b>\[Color\]<\/b> Which color do you prefer\?/);
  assert.match(msg.text, /<i>Or reply to this message with your own answer\.<\/i>$/);
  const b = buttonsOf(msg);
  assert.deepEqual(b.map((x: any) => x.text), ['Red', 'Blue']);
  for (const x of b) {
    assert.match(x.callback_data, /^qa:[0-9a-f]{16}$/);
    assert.equal(Buffer.byteLength(x.callback_data) <= 64, true);
  }
});

test('several questions get a heading message, then one numbered message per question', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name, fixed], { context: 'Before I plan.' }));
  const sent = sends(calls);
  assert.equal(sent.length, 4);
  assert.equal(sent[0].text, '❓ <b>Questions (3)</b> — proj\n\nBefore I plan.');
  assert.equal(sent[0].reply_markup, undefined);
  assert.match(sent[1].text, /^<b>1\/3<\/b> <b>\[Color\]<\/b> Which color/);
  assert.match(sent[2].text, /^<b>2\/3<\/b> What name should I use\?\n\n<i>Reply to this message with your answer\.<\/i>$/);
  assert.equal(sent[2].reply_markup, undefined);
  assert.match(sent[3].text, /^<b>3\/3<\/b> Ship it\?$/);
});

test('a button marks the choice and keeps the buttons, so it can be changed until the last answer', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  const [, colorMsg] = sends(calls);
  const [red, blue] = buttonsOf(colorMsg);
  await press(bot, red.callback_data, 101);
  await press(bot, blue.callback_data, 101);
  const [first, second] = edits(calls);
  assert.equal(first.message_id, 101);
  assert.match(first.text, /☑️ <b>Selected:<\/b> Red$/);
  assert.deepEqual(first.reply_markup, colorMsg.reply_markup);
  assert.match(second.text, /☑️ <b>Selected:<\/b> Blue$/);
  assert.deepEqual(toasts(calls), ['Selected', 'Selected']);
  assert.deepEqual(submitted, []);
});

test('a reply to a question message is its typed answer and goes nowhere else; the last answer sends them all', async (t) => {
  const { bot, calls, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  await press(bot, buttonsOf(sends(calls)[1])[1].callback_data, 101);
  await replyTo(bot, 102, '  Probe  ');
  assert.deepEqual(delivered, []);
  assert.deepEqual(submitted, [{ sessionId: 's1', requestId: 'r1', answers: { q1: 'Blue', q2: 'Probe' } }]);
});

test('a typed reply replaces a picked option when the question allows typing', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  await press(bot, buttonsOf(sends(calls)[1])[0].callback_data, 101);
  await replyTo(bot, 101, 'Teal');
  await replyTo(bot, 102, 'Probe');
  assert.deepEqual(submitted[0].answers, { q1: 'Teal', q2: 'Probe' });
});

test('a reply to a question that takes only its buttons goes to the session as a plain message', async (t) => {
  const { bot, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  await replyTo(bot, 100, 'maybe later');
  assert.deepEqual(delivered, ['s1:maybe later']);
  assert.deepEqual(submitted, []);
});

test('the hub refusing the answers says why and leaves the question open to answer again', async (t) => {
  const { bot, calls, submitted } = setup(t, 'the question is already being answered');
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const [yes, no] = buttonsOf(sends(calls)[0]);
  await press(bot, yes.callback_data);
  assert.equal(sends(calls).at(-1).text, 'Not delivered: the question is already being answered');
  assert.deepEqual(toasts(calls), ['Not delivered']);
  await press(bot, no.callback_data);
  assert.equal(submitted.length, 2);
});

test('the result overwrites every question message and retires the buttons', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  const [red] = buttonsOf(sends(calls)[1]);
  await press(bot, red.callback_data, 101);
  const before = edits(calls).length;
  await bot.resolveQuestion('s1', 'r1', 'answered', { q1: 'Blue', q2: 'Probe' }, 'dashboard');
  const result = edits(calls).slice(before);
  assert.deepEqual(result.map((e) => e.message_id), [101, 102]);
  assert.match(result[0].text, /\n\n✅ <b>Blue<\/b> \(Dashboard\)$/);
  assert.doesNotMatch(result[0].text, /Selected/);
  assert.equal(result[0].reply_markup, undefined);
  assert.match(result[1].text, /\n\n✅ <b>Probe<\/b> \(Dashboard\)$/);
  await press(bot, red.callback_data, 101);
  assert.equal(toasts(calls).at(-1), 'Expired');
});

test('closed and expired results say so, and an answer from Telegram carries no source tag', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'a' }));
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'b' }));
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'c' }));
  await bot.resolveQuestion('s1', 'a', 'closed');
  await bot.resolveQuestion('s1', 'b', 'expired');
  await bot.resolveQuestion('s1', 'c', 'answered', { q2: 'Probe' }, 'telegram');
  const [a, b, c] = edits(calls);
  assert.match(a.text, /\n\n<i>Closed — a message was sent instead<\/i>$/);
  assert.match(b.text, /\n\n⌛ <b>Expired<\/b>$/);
  assert.match(c.text, /\n\n✅ <b>Probe<\/b>$/);
});

test('a result that lands while the messages are still being sent is applied as each one goes out', async (t) => {
  const { bot, calls } = setup(t);
  const sending = bot.sendQuestion('s1', 'proj', request([color, name]));
  await bot.resolveQuestion('s1', 'r1', 'expired');
  await sending;
  const sent = sends(calls);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].reply_markup, undefined);
  assert.equal(edits(calls).some((e) => /Expired/.test(e.text)), true);
});

test('a session that could not take the answer reopens the messages with their buttons', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const [yes] = buttonsOf(sends(calls)[0]);
  await press(bot, yes.callback_data);
  assert.equal(submitted.length, 1);
  await press(bot, yes.callback_data);
  assert.equal(toasts(calls).at(-1), 'Sending…');
  await bot.reopenQuestion('s1', 'r1', 'Codex is waiting for an approval or input');
  const restored = edits(calls).at(-1);
  assert.doesNotMatch(restored.text, /Selected/);
  assert.deepEqual(restored.reply_markup, sends(calls)[0].reply_markup);
  assert.equal(sends(calls).at(-1).text, 'Not delivered: Codex is waiting for an approval or input');
  await press(bot, yes.callback_data);
  assert.equal(submitted.length, 2);
});

test('a reopen for a question Telegram was not sending changes nothing', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const before = calls.length;
  await bot.reopenQuestion('s1', 'r1', 'whatever');
  assert.equal(calls.length, before);
});

test('long answers are clipped on screen but sent in full', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([name]));
  const long = 'z'.repeat(1000);
  await replyTo(bot, 100, long);
  assert.equal(submitted[0].answers.q2, long);
  assert.match(edits(calls)[0].text, new RegExp(`Selected:</b> ${'z'.repeat(300)}…$`));
});

test('a long context still leaves room for the result line within the message limit', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color], { context: 'c'.repeat(20000) }));
  const [msg] = sends(calls);
  assert.equal(visibleLength(msg.text) <= 4000 - 400, true);
  assert.match(msg.text, /…\(truncated\)/);
  await bot.resolveQuestion('s1', 'r1', 'answered', { q1: 'x'.repeat(300) }, 'dashboard');
  assert.equal(visibleLength(edits(calls)[0].text) <= 4000, true);
});

test('option descriptions show as one line per option under the question', async (t) => {
  const { bot, calls } = setup(t);
  const described = { ...color, options: [{ label: 'Red', description: 'warm & <bold>' }, { label: 'Blue' }] };
  await bot.sendQuestion('s1', 'proj', request([described]));
  await bot.sendQuestion('s1', 'proj', request([described, fixed], { requestId: 'r2' }));
  const [single, , first, second] = sends(calls);
  const lines = '\n\n• <b>Red</b> — warm &amp; &lt;bold&gt;\n• <b>Blue</b>\n\n<i>Or reply';
  assert.match(single.text, new RegExp(`Which color do you prefer\\?${lines}`));
  assert.match(first.text, new RegExp(`^<b>1/2</b> <b>\\[Color\\]</b> Which color do you prefer\\?${lines}`));
  assert.doesNotMatch(second.text, /•/);
});

test('option lines that would not fit are left out whole, and the message stays within its budget', async (t) => {
  const { bot, calls } = setup(t);
  const options = Array.from({ length: 10 }, (_, i) => ({ label: `Option ${i}`, description: 'd'.repeat(500) }));
  const long = { id: 'q1', question: 'Which one?', options, allowOther: true };
  await bot.sendQuestion('s1', 'proj', request([long]));
  await bot.sendQuestion('s1', 'proj', request([long, fixed], { requestId: 'r2' }));
  const [single, , first] = sends(calls);
  for (const msg of [single, first]) {
    assert.doesNotMatch(msg.text, /•|ddd|truncated/);
    assert.match(msg.text, /Which one\?\n\n<i>Or reply to this message with your own answer\.<\/i>$/);
    assert.equal(visibleLength(msg.text) <= 4000 - 400, true);
  }
  assert.equal(buttonsOf(single).length, 10);
});

test('only the latest 100 requests keep working buttons', async (t) => {
  const { bot, calls } = setup(t);
  for (let i = 0; i < 101; i++) await bot.sendQuestion('s1', 'proj', request([fixed], { requestId: `r${i}` }));
  const [oldest] = buttonsOf(sends(calls)[0]);
  await press(bot, oldest.callback_data);
  assert.equal(toasts(calls).at(-1), 'Expired');
  const [newest] = buttonsOf(sends(calls).at(-1));
  await press(bot, newest.callback_data);
  assert.equal(toasts(calls).at(-1), 'Sending…');
});

test('a reply to the heading of several questions reaches the session as a plain message', async (t) => {
  const { bot, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name], { context: 'Before I plan.' }));
  await replyTo(bot, 100, 'let me think');
  assert.deepEqual(delivered, ['s1:let me think']);
  assert.deepEqual(submitted, []);
});
