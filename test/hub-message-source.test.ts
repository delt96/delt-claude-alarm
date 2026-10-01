// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import fs from 'node:fs';
import { HubServer } from '../src/hub/server.js';
import { saveConfig } from '../src/shared/config.js';

const PORT = 7995;
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

test('Telegram photos are tagged telegram', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: [] })));
  saveConfig({ hub: { host: '127.0.0.1', port: 7991 }, notifications: { desktop: false, sound: false }, webhooks: [], telegram: { enabled: true, botToken: 'x', chatId: '111' } } as any);
  const tgHub = new HubServer({
    hub: { host: '127.0.0.1', port: 7991, token: TOKEN },
    notifications: { desktop: false, sound: false },
  } as any);
  await tgHub.start();
  try {
    const ch = await open('/ws/channel', 7991);
    register(ch.ws, 'src-tg');
    await settle();
    (tgHub as any).telegramBot.onImageToSession('src-tg', 'C:\\uploads\\photo.jpg', 'image/jpeg', 'from phone');
    await settle();
    const got = ch.inbox.find((m) => m.type === 'image_to_session');
    assert.equal(got?.source, 'telegram');
    assert.equal(got?.content, 'from phone');
    ch.ws.close();
  } finally {
    await tgHub.stop();
  }
});
