// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function setup(t: any, initial: ReturnType<typeof s>[]) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ api: String(url).split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const state = { sessions: initial };
  bot.getSessions = () => state.sessions;
  const delivered: string[] = [];
  bot.onMessageToSession = (id, content) => { delivered.push(`${id}:${content}`); };
  return { bot, state, delivered, calls };
}

const say = (bot: TelegramBot, text: string, id = 1) =>
  (bot as any).handleIncomingMessage({ message_id: id, chat: { id: 111 }, text });

const press = (bot: TelegramBot, data: string) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: 111 }, message_id: 5, text: '' } });

const prompts = (calls: Array<{ api: string; body: any }>): string[][] =>
  calls
    .filter((c) => c.api === 'sendMessage' && c.body?.reply_markup)
    .map((c) => c.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data));

const expiredAndCleared = (calls: Array<{ api: string; body: any }>) => {
  assert.equal(calls.filter((c) => c.api === 'answerCallbackQuery').pop()!.body.text, 'Expired');
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageReplyMarkup').pop()!.body, {
    chat_id: 111,
    message_id: 5,
    reply_markup: { inline_keyboard: [] },
  });
};

test('a session button keeps pointing at the session listed when it was sent', async (t) => {
  const { bot, state, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await press(bot, prompts(calls)[0][0]);
  assert.deepEqual(delivered, ['a:hello']);
});

test('the /s_ command resolves against the same snapshot', async (t) => {
  const { bot, state, delivered } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await say(bot, '/s_2', 2);
  assert.deepEqual(delivered, ['b:hello']);
});

test('a button for a session that has gone away delivers nothing', async (t) => {
  const { bot, state, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('b')];
  await press(bot, prompts(calls)[0][0]);
  assert.deepEqual(delivered, []);
  assert.equal(calls.filter((c) => c.api === 'answerCallbackQuery').pop()!.body.text, 'Session not found');
});

test('with two prompts open, each prompt sends its own message', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'first', 1);
  await say(bot, 'second', 2);
  const [p1, p2] = prompts(calls);
  await press(bot, p1[1]);
  await press(bot, p2[0]);
  assert.deepEqual(delivered, ['b:first', 'a:second']);
});

test('the /s_ command uses the newest prompt', async (t) => {
  const { bot, delivered } = setup(t, [s('a'), s('b')]);
  await say(bot, 'first', 1);
  await say(bot, 'second', 2);
  await say(bot, '/s_1', 3);
  assert.deepEqual(delivered, ['a:second']);
});

test('session buttons fit in 64 bytes', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  for (const data of prompts(calls)[0]) {
    assert.match(data, /^sel:[0-9a-f]{8}:\d+$/);
    assert.ok(Buffer.byteLength(data) <= 64);
  }
});

test('a prompt that was already used expires and loses its buttons', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  const [p1] = prompts(calls);
  await press(bot, p1[0]);
  await press(bot, p1[1]);
  assert.deepEqual(delivered, ['a:hello']);
  expiredAndCleared(calls);
});

test('a session button from before the update expires and loses its buttons', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await press(bot, 'sess:0:111');
  assert.deepEqual(delivered, []);
  expiredAndCleared(calls);
});

test('only the 20 newest prompts are kept', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  for (let i = 1; i <= 21; i++) await say(bot, `m${i}`, i);
  const all = prompts(calls);
  await press(bot, all[0][0]);
  expiredAndCleared(calls);
  await press(bot, all[20][0]);
  assert.deepEqual(delivered, ['a:m21']);
});


test('/s_ does not resolve an older prompt after the newest was answered', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'first', 1);
  await say(bot, 'second', 2);
  await press(bot, prompts(calls)[1][0]);
  await say(bot, '/s_1', 3);
  assert.deepEqual(delivered, ['a:second']);
  assert.equal(prompts(calls).length, 3);
});
