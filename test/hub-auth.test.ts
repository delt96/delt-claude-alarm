import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { SESSION_COOKIE, dashboardCookieValue } from '../src/hub/auth.js';

const PORT = 7997;
const TOKEN = 'hub-auth-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = `${SESSION_COOKIE}=${dashboardCookieValue(TOKEN)}`;
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

function wsOutcome(path: string, headers: Record<string, string> = {}): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

const json = { 'Content-Type': 'application/json' };

test('websocket upgrades without a token are rejected even from loopback', async () => {
  assert.equal(await wsOutcome('/ws/dashboard'), 401);
  assert.equal(await wsOutcome('/ws/channel'), 401);
});

test('api calls without a token are rejected even from loopback', async () => {
  assert.equal((await fetch(`${BASE}/api/sessions`)).status, 401);
  const r = await fetch(`${BASE}/api/send`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(r.status, 401);
});

test('channel query token and bearer header are accepted', async () => {
  assert.equal(await wsOutcome(`/ws/channel?token=${TOKEN}`), 'open');
  const r = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
});

test('query token is not accepted by http api', async () => {
  assert.equal((await fetch(`${BASE}/api/sessions?token=${TOKEN}`)).status, 401);
});

test('login sets a hardened cookie that authorizes ws and api', async () => {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(r.status, 204);
  const setCookie = r.headers.get('set-cookie') ?? '';
  assert.ok(setCookie.startsWith(`${COOKIE};`), setCookie);
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
  assert.equal(await wsOutcome('/ws/dashboard', { Cookie: COOKIE }), 'open');
  assert.equal((await fetch(`${BASE}/api/webhooks`, { headers: { Cookie: COOKIE } })).status, 200);
});

test('wrong login and forged cookie are rejected', async () => {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ token: 'nope' }) });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${BASE}/api/sessions`, { headers: { Cookie: `${SESSION_COOKIE}=forged` } })).status, 401);
});

test('login link redirects with a cookie, bad link serves html without one', async () => {
  const ok = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  assert.ok((ok.headers.get('set-cookie') ?? '').startsWith(`${COOKIE};`));
  const bad = await fetch(`${BASE}/?token=nope`, { redirect: 'manual' });
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get('set-cookie'), null);
});

test('login behind https proxy marks the cookie secure', async () => {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { ...json, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ token: TOKEN }),
  });
  assert.ok((r.headers.get('set-cookie') ?? '').includes('; Secure'));
});

test('cross-origin requests are rejected even with a valid cookie', async () => {
  const evil = { Cookie: COOKIE, Origin: 'http://evil.com' };
  assert.equal(await wsOutcome('/ws/dashboard', evil), 403);
  const r = await fetch(`${BASE}/api/webhooks`, { method: 'POST', headers: { ...json, ...evil }, body: '{"webhooks":[]}' });
  assert.equal(r.status, 403);
});

test('same-origin requests pass the origin check', async () => {
  assert.equal(await wsOutcome('/ws/dashboard', { Cookie: COOKIE, Origin: BASE }), 'open');
});

test('non-json posts are rejected before auth', async () => {
  const r = await fetch(`${BASE}/api/send`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TOKEN}` }, body: '{}',
  });
  assert.equal(r.status, 415);
});

test('oversized frames close the connection', { timeout: 10_000 }, async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/channel?token=${TOKEN}`);
  await new Promise((r) => ws.on('open', r));
  const code = await new Promise<number>((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.send('x'.repeat(16 * 1024 * 1024 + 1));
  });
  assert.ok(code === 1009 || code === 1006, `close code ${code}`);
  assert.equal((await fetch(`${BASE}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
});
