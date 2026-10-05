// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import fs from 'node:fs';
import { HubServer } from '../src/hub/server.js';
import { saveConfig } from '../src/shared/config.js';
import { logger } from '../src/shared/logger.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7995;
const TG_PORT = 7991;
const TOKEN = 'source-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string, port = PORT): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function register(ws: WebSocket, id: string) {
  ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
}

test('dashboard messages are tagged with their source', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'src-dash');
  await settle();
  const dash = await open('/ws/dashboard');
  dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'src-dash', content: 'hi' }));
  await settle();
  const got = ch.inbox.find((m) => m.type === 'message_to_session');
  assert.equal(got?.source, 'dashboard');
  assert.equal(got?.content, 'hi');
  dash.ws.close(); ch.ws.close();
});

test('/api/send messages are tagged api', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'src-api');
  await settle();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sessionId: 'src-api', content: 'from cli' }),
  });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(ch.inbox.find((m) => m.type === 'message_to_session')?.source, 'api');
  ch.ws.close();
});

test('dashboard image uploads are tagged dashboard', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'src-img');
  await settle();
  const dash = await open('/ws/dashboard');
  const imageData = Buffer.from('fake png bytes').toString('base64');
  dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'src-img', imageData, mimeType: 'image/png', content: 'look' }));
  await settle();
  const got = ch.inbox.find((m) => m.type === 'image_to_session');
  assert.equal(got?.source, 'dashboard');
  assert.equal(got?.content, 'look');
  assert.equal(fs.readFileSync(got.imagePath, 'utf8'), 'fake png bytes');
  dash.ws.close(); ch.ws.close();
});

async function telegramHub(t: TestContext): Promise<{ hub: HubServer; sent: string[] }> {
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: { body?: string }) => {
    if (String(url).endsWith('/sendMessage')) {
      sent.push(JSON.parse(init?.body ?? '{}').text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length } }));
    }
    return new Response(JSON.stringify({ ok: true, result: [] }));
  });
  saveConfig({ hub: { host: '127.0.0.1', port: TG_PORT }, notifications: { desktop: false, sound: false }, webhooks: [], telegram: { enabled: true, botToken: 'x', chatId: '111' } } as any);
  const tgHub = new HubServer({ hub: { host: '127.0.0.1', port: TG_PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  await tgHub.start();
  return { hub: tgHub, sent };
}

test('Telegram photos are tagged telegram', async (t) => {
  const tg = await telegramHub(t);
  try {
    const ch = await open('/ws/channel', TG_PORT);
    register(ch.ws, 'src-tg');
    await settle();
    (tg.hub as any).telegramBot.onImageToSession('src-tg', 'C:\\uploads\\photo.jpg', 'image/jpeg', 'from phone');
    await settle();
    const got = ch.inbox.find((m) => m.type === 'image_to_session');
    assert.equal(got?.source, 'telegram');
    assert.equal(got?.content, 'from phone');
    ch.ws.close();
  } finally {
    await tg.hub.stop();
  }
});

test('Telegram callbacks say whether the session got the message', async (t) => {
  const tg = await telegramHub(t);
  const warn = t.mock.method(logger, 'warn');
  try {
    const ch = await open('/ws/channel', TG_PORT);
    register(ch.ws, 'tg-live');
    await settle();
    const bot = (tg.hub as any).telegramBot;
    assert.equal(bot.onMessageToSession('tg-live', 'hello'), true);
    assert.equal(bot.onImageToSession('tg-live', 'C:\\uploads\\p.jpg', 'image/jpeg'), true);
    assert.equal(bot.onMessageToSession('tg-gone', 'hello'), false);
    assert.equal(bot.onImageToSession('tg-gone', 'C:\\uploads\\p.jpg', 'image/jpeg'), false);
    assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('tg-gone')).length, 2);
    await settle();
    assert.deepEqual(ch.inbox.filter((m) => m.type === 'message_to_session' || m.type === 'image_to_session').map((m) => m.type), ['message_to_session', 'image_to_session']);
    ch.ws.close();
  } finally {
    await tg.hub.stop();
  }
});

const notice = (ch: { ws: WebSocket }, sessionId: string, title: string, to?: string) =>
  ch.ws.send(JSON.stringify({ type: 'notify', sessionId, title, message: 'body', level: 'info', ...(to ? { to } : {}) }));

async function noticeSetup(port: number, id: string) {
  const ch = await open('/ws/channel', port);
  register(ch.ws, id);
  await settle();
  const dash = await open('/ws/dashboard', port);
  return { ch, dash, close: () => { dash.ws.close(); ch.ws.close(); } };
}

const dashNotices = (dash: { inbox: any[] }) => dash.inbox.filter((m) => m.type === 'notification');

test('a notice addressed to the dashboard goes only to dashboards', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  try {
    const r = await noticeSetup(TG_PORT, 'route-dash');
    notice(r.ch, 'route-dash', 'Route dash', 'dashboard');
    await until(() => dashNotices(r.dash).find((m) => m.title === 'Route dash'));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(tg.sent.filter((text) => text.includes('Route dash')), []);
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

test('a notice addressed to Telegram goes only to the bot, and a reply to it reaches the session', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  try {
    const r = await noticeSetup(TG_PORT, 'route-tg');
    notice(r.ch, 'route-tg', 'Route tg', 'telegram');
    await until(() => tg.sent.find((text) => text.includes('[route-tg] Route tg')));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
    const messageId = 101 + tg.sent.findIndex((text) => text.includes('[route-tg] Route tg'));
    await (tg.hub as any).telegramBot.handleIncomingMessage({ message_id: 900, chat: { id: 111 }, text: 'and then?', reply_to_message: { message_id: messageId } });
    const got = await until(() => r.ch.inbox.find((m) => m.type === 'message_to_session'));
    assert.equal(got.content, 'and then?');
    assert.equal(got.source, 'telegram');
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

test('a notice addressed to the API sender is only logged', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  const info = t.mock.method(logger, 'info');
  try {
    const r = await noticeSetup(TG_PORT, 'route-api');
    notice(r.ch, 'route-api', 'Route api', 'api');
    await until(() => info.mock.calls.find((c) => String(c.arguments[0]).includes('[route-api] Route api')));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
    assert.deepEqual(tg.sent.filter((text) => text.includes('Route api')), []);
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

for (const [name, to] of [['without an address', undefined], ['with an address this hub does not know', 'pager']] as const) {
  test(`a notice ${name} goes everywhere, as before`, async (t) => {
    const tg = await telegramHub(t);
    const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
    try {
      const r = await noticeSetup(TG_PORT, 'route-all');
      notice(r.ch, 'route-all', 'Route all', to);
      await until(() => dashNotices(r.dash).find((m) => m.title === 'Route all'));
      await until(() => tg.sent.find((text) => text.includes('[route-all] Route all')));
      assert.equal(notify.mock.callCount(), 1);
      r.close();
    } finally {
      await tg.hub.stop();
    }
  });
}

test('a notice addressed to Telegram goes nowhere when no bot is set up', async (t) => {
  const notify = t.mock.method((hub as any).notifier, 'notifyWithSession');
  const r = await noticeSetup(PORT, 'route-nobot');
  try {
    notice(r.ch, 'route-nobot', 'Route nobot', 'telegram');
    await settle();
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
  } finally {
    r.close();
  }
});
