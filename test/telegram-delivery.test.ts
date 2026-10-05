// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TelegramBot } from '../src/hub/telegram.js';

const GONE = 'Not delivered: the session is no longer connected';
const PHOTO_GONE = 'Photo not delivered: the session is no longer connected';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function setup(t: any, sessions: ReturnType<typeof s>[], accept: boolean) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p.jpg' } }));
    if (u.includes('/file/bot')) return new Response(new Uint8Array(10));
    calls.push({ api: u.split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  bot.getSessions = () => sessions;
  const texts: string[] = [];
  const photos: string[] = [];
  bot.onMessageToSession = (id, content) => { texts.push(`${id}:${content}`); return accept; };
  bot.onImageToSession = (_id, imagePath) => { photos.push(imagePath); return accept; };
  return { bot, calls, texts, photos };
}

const sent = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body.text);
const say = (bot: TelegramBot, text: string, extra: Record<string, unknown> = {}) =>
  (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text, ...extra });
const sendPhoto = (bot: TelegramBot) =>
  (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1, file_size: 10 }] });
const press = (bot: TelegramBot, data: string) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: 111 }, message_id: 7, text: '' } });
const firstButton = (calls: Array<{ api: string; body: any }>) =>
  calls.find((c) => c.api === 'sendMessage' && c.body?.reply_markup)!.body.reply_markup.inline_keyboard[0][0].callback_data;
const toast = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'answerCallbackQuery').pop()?.body.text;

test('a reply to a notification from a session that is gone says it was not delivered', async (t) => {
  const { bot, calls, texts } = setup(t, [], false);
  await bot.sendNotification('gone', 'Gone', 'Done', 'finished');
  await say(bot, 'thanks', { message_id: 2, reply_to_message: { message_id: 7 } });
  assert.deepEqual(texts, ['gone:thanks']);
  assert.deepEqual(sent(calls), ['<b>Done</b>\nfinished', GONE]);
});

test('a reply that is delivered sends nothing back', async (t) => {
  const { bot, calls } = setup(t, [], true);
  await bot.sendNotification('live', 'Live', 'Done', 'finished');
  await say(bot, 'thanks', { message_id: 2, reply_to_message: { message_id: 7 } });
  assert.deepEqual(sent(calls), ['<b>Done</b>\nfinished']);
});

test('with one session, a message that cannot be delivered is reported', async (t) => {
  const { bot, calls } = setup(t, [s('a')], false);
  await say(bot, 'hello');
  assert.deepEqual(sent(calls), [GONE]);
});

test('with one session, a delivered message sends nothing back', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a')], true);
  await say(bot, 'hello');
  assert.deepEqual(texts, ['a:hello']);
  assert.deepEqual(sent(calls), []);
});

test('/s_N does not claim a text was sent when the session is gone', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a'), s('b')], false);
  await say(bot, 'hello');
  await say(bot, '/s_1', { message_id: 2 });
  assert.deepEqual(texts, ['a:hello']);
  assert.equal(sent(calls).includes(GONE), true);
  assert.deepEqual(sent(calls).filter((x) => x.startsWith('Sent to')), []);
});

test('/s_N still says where a delivered text went', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')], true);
  await say(bot, 'hello');
  await say(bot, '/s_2', { message_id: 2 });
  assert.equal(sent(calls).at(-1), 'Sent to [b]');
});

test('a session button for a text whose session is gone says Not delivered and clears the buttons', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a'), s('b')], false);
  await say(bot, 'hello');
  await press(bot, firstButton(calls));
  assert.deepEqual(texts, ['a:hello']);
  assert.equal(toast(calls), 'Not delivered');
  assert.equal(sent(calls).includes(GONE), true);
  assert.equal(calls.some((c) => c.api === 'editMessageReplyMarkup' && c.body.reply_markup.inline_keyboard.length === 0), true);
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageText'), []);
});

test('a session button for a delivered text still says where it went', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')], true);
  await say(bot, 'hello');
  await press(bot, firstButton(calls));
  assert.equal(toast(calls), 'Sent to a');
  assert.equal(calls.find((c) => c.api === 'editMessageText')!.body.text, '✅ Sent to <b>a</b>');
});

test('a photo the session cannot take is deleted at once and reported', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a')], false);
  await sendPhoto(bot);
  assert.equal(photos.length, 1);
  assert.equal(fs.existsSync(photos[0]), false);
  assert.deepEqual(sent(calls), [PHOTO_GONE]);
});

test('a delivered photo stays for the session to read', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a')], true);
  await sendPhoto(bot);
  assert.equal(fs.existsSync(photos[0]), true);
  assert.deepEqual(sent(calls), []);
});

test('a session button for a photo whose session is gone does not claim it was sent', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a'), s('b')], false);
  await sendPhoto(bot);
  await press(bot, firstButton(calls));
  assert.equal(fs.existsSync(photos[0]), false);
  assert.equal(toast(calls), 'Photo not delivered');
  assert.equal(sent(calls).includes(PHOTO_GONE), true);
  assert.equal(calls.some((c) => c.api === 'editMessageReplyMarkup' && c.body.reply_markup.inline_keyboard.length === 0), true);
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageText'), []);
});

test('a message with no hub callback is reported as not delivered', async (t) => {
  const { bot, calls } = setup(t, [s('a')], true);
  bot.onMessageToSession = undefined;
  await say(bot, 'hello');
  assert.deepEqual(sent(calls), [GONE]);
});

test('a photo whose hub callback throws is deleted at once and reported as not connected', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a')], true);
  bot.onImageToSession = (_id, imagePath) => { photos.push(imagePath); throw new Error('boom'); };
  await sendPhoto(bot);
  assert.equal(fs.existsSync(photos[0]), false);
  assert.deepEqual(sent(calls), [PHOTO_GONE]);
});
