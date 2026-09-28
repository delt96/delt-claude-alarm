import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

function makeBot() {
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const verdicts: string[] = [];
  bot.onPermissionVerdict = (_s, requestId, behavior) => { verdicts.push(`${requestId}:${behavior}`); };
  return { bot, verdicts };
}

function query(chatId: number) {
  return { id: 'q1', data: 'perm:allow:sess:req1', message: { chat: { id: chatId }, message_id: 1, text: '' } };
}

test('callbacks from another chat are ignored', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const { bot, verdicts } = makeBot();
  await (bot as any).handleCallbackQuery(query(999));
  assert.deepEqual(verdicts, []);
});

test('callbacks from the configured chat are handled', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const { bot, verdicts } = makeBot();
  await (bot as any).handleCallbackQuery(query(111));
  assert.deepEqual(verdicts, ['req1:allow']);
});
