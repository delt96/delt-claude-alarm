// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function makeBot(initial: ReturnType<typeof s>[]) {
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const state = { sessions: initial };
  bot.getSessions = () => state.sessions;
  const delivered: string[] = [];
  bot.onMessageToSession = (id, content) => { delivered.push(`${id}:${content}`); };
  return { bot, state, delivered };
}

test('a session button keeps pointing at the session listed when it was sent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await (bot as any).handleCallbackQuery({ id: 'q', data: 'sess:0:111', message: { chat: { id: 111 }, message_id: 5, text: '' } });
  assert.deepEqual(delivered, ['a:hello']);
});

test('the /s_ command resolves against the same snapshot', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await (bot as any).handleIncomingMessage({ message_id: 2, chat: { id: 111 }, text: '/s_2' });
  assert.deepEqual(delivered, ['b:hello']);
});

test('a button for a session that has gone away delivers nothing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('b')];
  await (bot as any).handleCallbackQuery({ id: 'q', data: 'sess:0:111', message: { chat: { id: 111 }, message_id: 5, text: '' } });
  assert.deepEqual(delivered, []);
});
