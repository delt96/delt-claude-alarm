// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, visibleLength } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });
const MB10 = 10 * 1024 * 1024;

function setup(t: any, sessions = [s('a')], opts: { getFile?: unknown; download?: () => Response } = {}) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/getFile')) {
      calls.push({ api: 'getFile', body: undefined });
      return new Response(JSON.stringify(opts.getFile ?? { ok: true, result: { file_path: 'photos/p.jpg' } }));
    }
    if (u.includes('/file/bot')) {
      calls.push({ api: 'download', body: undefined });
      return opts.download ? opts.download() : new Response(new Uint8Array(10));
    }
    calls.push({ api: u.split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  bot.getSessions = () => sessions;
  const images: string[] = [];
  bot.onImageToSession = (id, _path, mime) => { images.push(`${id}:${mime}`); };
  return { bot, calls, images };
}

const photo = (size?: number) => ({
  message_id: 1,
  chat: { id: 111 },
  photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1, ...(size === undefined ? {} : { file_size: size }) }],
});

const sent = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body.text);

// --- length

test('escapes count as one character and tags not at all', () => {
  assert.equal(visibleLength('<b>a&amp;b</b>&lt;'), 4);
});

test('a short notification is sent unchanged', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', 'hello');
  assert.deepEqual(sent(calls), ['<b>Title</b>\nhello']);
});

test('a notification longer than Telegram allows is cut to 4000 visible characters', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', 'x'.repeat(10_000));
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.ok(visibleLength(text) > 3900);
  assert.ok(text.endsWith('\n…(truncated)'));
});

test('a cut never splits an emoji', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', '😀'.repeat(5000));
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
});

test('a cut inside a code block still leaves balanced tags', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', `\`\`\`\n${'y'.repeat(9000)}\n\`\`\``);
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.equal(text.split('<pre>').length, text.split('</pre>').length);
});

// --- photos

test('a photo over 10 MB is refused before a prompt is sent or anything is downloaded', async (t) => {
  const { bot, calls, images } = setup(t, [s('a'), s('b')]);
  await (bot as any).handleIncomingMessage(photo(MB10 + 1));
  assert.deepEqual(calls.map((c) => c.api), ['sendMessage']);
  assert.equal(calls[0].body.text, 'Photo not delivered: it is larger than 10 MB');
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.deepEqual(images, []);
});

test('a photo Telegram does not return is reported', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { getFile: { ok: false } });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: Telegram did not return the file']);
  assert.deepEqual(images, []);
});

test('a failed download is reported', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { download: () => new Response('gone', { status: 404 }) });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: the download failed']);
  assert.deepEqual(images, []);
});

test('a downloaded photo over 10 MB is reported and not delivered', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { download: () => new Response(new Uint8Array(MB10 + 1)) });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: it is larger than 10 MB']);
  assert.deepEqual(images, []);
});

test('a photo within the limit is delivered without a message', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')]);
  await (bot as any).handleIncomingMessage(photo(1000));
  assert.deepEqual(images, ['a:image/jpeg']);
  assert.deepEqual(sent(calls), []);
});
