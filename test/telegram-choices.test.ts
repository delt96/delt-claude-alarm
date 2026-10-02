// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const choices = [
  { id: '0', label: 'Allow once' },
  { id: '1', label: 'Always allow this command' },
  { id: '2', label: 'Cancel task' },
];

function setup(t: any) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ api: String(url).split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const verdicts: string[] = [];
  bot.onChoiceVerdict = (s, r, c) => { verdicts.push(`${s}|${r}|${c}`); };
  return { bot, calls, verdicts };
}

const offer = (bot: TelegramBot) =>
  bot.sendChoiceRequest('codex:t1', 'Codex · proj', 'req-1', 'Command', 'Allow creating <x>?', '{"command":"New-Item x"}', choices);

const press = (bot: TelegramBot, data: string, chatId = 111) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: chatId }, message_id: 42, text: '' } });

const buttons = (calls: Array<{ api: string; body: any }>) =>
  calls.find((c) => c.api === 'sendMessage')!.body.reply_markup.inline_keyboard.flat();

test('a choice request gets one button per choice with short callback data', async (t) => {
  const { bot, calls } = setup(t);
  await offer(bot);
  const sent = calls.find((c) => c.api === 'sendMessage')!.body;
  assert.match(sent.text, /Allow creating &lt;x&gt;\?/);
  assert.match(sent.text, /\$ New-Item x/);
  const b = buttons(calls);
  assert.deepEqual(b.map((x: any) => x.text), choices.map((c) => c.label));
  for (const x of b) {
    assert.match(x.callback_data, /^pc:[0-9a-f]+$/);
    assert.ok(Buffer.byteLength(x.callback_data) <= 64);
  }
});

test('pressing a choice sends it once and removes the buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  const b = buttons(calls);
  await press(bot, b[1].callback_data);
  await press(bot, b[0].callback_data);
  assert.deepEqual(verdicts, ['codex:t1|req-1|1']);
  assert.deepEqual(
    calls.filter((c) => c.api === 'answerCallbackQuery').map((c) => c.body.text),
    ['Sent: Always allow this command', 'Expired'],
  );
  const edit = calls.find((c) => c.api === 'editMessageText')!.body;
  assert.equal(edit.message_id, 42);
  assert.equal(edit.reply_markup, undefined);
  assert.match(edit.text, /Sent: Always allow this command/);
});

test('an unknown token answers Expired and removes the buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await press(bot, 'pc:deadbeef');
  assert.deepEqual(verdicts, []);
  assert.equal(calls.find((c) => c.api === 'answerCallbackQuery')!.body.text, 'Expired');
  assert.deepEqual(calls.find((c) => c.api === 'editMessageReplyMarkup')!.body, {
    chat_id: 111,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
});

test('resolution edits the message and retires its buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  const b = buttons(calls);
  await bot.resolveChoiceRequest('codex:t1', 'req-1', 'resolved');
  assert.match(calls.find((c) => c.api === 'editMessageText')!.body.text, /Resolved/);
  await press(bot, b[0].callback_data);
  assert.deepEqual(verdicts, []);
});

test('an expiry that lands before the message is sent still removes the buttons', async (t) => {
  const { bot, calls } = setup(t);
  const sending = offer(bot);
  await bot.resolveChoiceRequest('codex:t1', 'req-1', 'expired');
  await sending;
  const edit = calls.find((c) => c.api === 'editMessageText');
  assert.ok(edit, 'message was not edited');
  assert.match(edit.body.text, /Expired/);
});

test('choice callbacks from another chat are ignored', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  await press(bot, buttons(calls)[0].callback_data, 999);
  assert.deepEqual(verdicts, []);
});
