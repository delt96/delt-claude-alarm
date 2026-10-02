// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7989;
const TOKEN = 'upload-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

async function channel(id: string) {
  const ch = await open('/ws/channel');
  ch.ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
  await settle();
  return ch;
}

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const upload = (dash: { ws: WebSocket }, sessionId: string, mimeType = 'image/png', imageData = png) =>
  dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId, imageData, mimeType }));
const rejection = (dash: { inbox: any[] }, sessionId: string) =>
  until(() => dash.inbox.find((m) => m.type === 'upload_rejected' && m.sessionId === sessionId));

test('an image for a session that is not connected is rejected with a reason', async () => {
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'nobody');
    assert.deepEqual(await rejection(dash, 'nobody'), { type: 'upload_rejected', sessionId: 'nobody', reason: 'the session is not connected', withText: false });
  } finally { dash.ws.close(); }
});

test('an image for a session on another PC is rejected', async () => {
  const ch = await channel('up-remote');
  const dash = await open('/ws/dashboard');
  try {
    (hub as any).localChannels.delete('up-remote');
    upload(dash, 'up-remote');
    assert.equal((await rejection(dash, 'up-remote')).reason, "this session is on another PC; images can only go to sessions on the hub's PC");
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('an unsupported image type is rejected and nothing reaches the session', async () => {
  const ch = await channel('up-type');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-type', 'image/bmp');
    assert.equal((await rejection(dash, 'up-type')).reason, 'only PNG, JPEG, GIF and WebP images are supported');
    await settle();
    assert.ok(!ch.inbox.some((m) => m.type === 'image_to_session'));
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('an image over 10 MB is rejected', async () => {
  const ch = await channel('up-size');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-size', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'));
    assert.equal((await rejection(dash, 'up-size')).reason, 'the image is larger than 10 MB');
    assert.ok(!ch.inbox.some((m) => m.type === 'image_to_session'));
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('a rejection goes only to the dashboard that sent the image', async () => {
  const sender = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  try {
    upload(sender, 'nobody-2');
    await rejection(sender, 'nobody-2');
    await settle();
    assert.ok(!other.inbox.some((m) => m.type === 'upload_rejected'));
  } finally { sender.ws.close(); other.ws.close(); }
});

test('an accepted image still reaches the session and is not rejected', async () => {
  const ch = await channel('up-ok');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-ok');
    await until(() => ch.inbox.find((m) => m.type === 'image_to_session'));
    assert.ok(!dash.inbox.some((m) => m.type === 'upload_rejected'));
  } finally { dash.ws.close(); ch.ws.close(); }
});


test('a rejected image reports accompanying text', async () => {
  const dash = await open('/ws/dashboard');
  try {
    dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'text-nobody', imageData: png, mimeType: 'image/png', content: 'look at this' }));
    assert.deepEqual(await rejection(dash, 'text-nobody'), { type: 'upload_rejected', sessionId: 'text-nobody', reason: 'the session is not connected', withText: true });
  } finally { dash.ws.close(); }
});
