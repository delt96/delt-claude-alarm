import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE, safeEqual, dashboardCookieValue, parseCookies, sessionCookieHeader,
  isAuthorized, isCrossOrigin, isJsonRequest, isSecureRequest,
} from '../src/hub/auth.js';

const TOKEN = 'tok-123';
const req = (headers: Record<string, string> = {}, url = '/') => ({ headers, url });

test('safeEqual compares exactly and rejects non-strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abd', 'abc'), false);
  assert.equal(safeEqual('ab', 'abc'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(null, 'abc'), false);
});

test('cookie value is a stable HMAC that changes with the token', () => {
  assert.equal(dashboardCookieValue(TOKEN), dashboardCookieValue(TOKEN));
  assert.notEqual(dashboardCookieValue(TOKEN), dashboardCookieValue('other'));
  assert.match(dashboardCookieValue(TOKEN), /^[0-9a-f]{64}$/);
});

test('parseCookies splits pairs and survives malformed encoding', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.doesNotThrow(() => parseCookies(`${SESSION_COOKIE}=%E0%A4%A`));
});

test('session cookie header carries the hardening attributes', () => {
  const h = sessionCookieHeader(TOKEN, false);
  assert.ok(h.startsWith(`${SESSION_COOKIE}=${dashboardCookieValue(TOKEN)};`));
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(h.includes(attr), attr);
  assert.ok(!h.includes('Secure'));
  assert.ok(sessionCookieHeader(TOKEN, true).endsWith('; Secure'));
});

test('bearer header authorizes', () => {
  assert.equal(isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN, false), true);
  assert.equal(isAuthorized(req({ authorization: 'Bearer nope' }), TOKEN, false), false);
});

test('session cookie authorizes', () => {
  const cookie = `x=1; ${SESSION_COOKIE}=${dashboardCookieValue(TOKEN)}`;
  assert.equal(isAuthorized(req({ cookie }), TOKEN, false), true);
  assert.equal(isAuthorized(req({ cookie: `${SESSION_COOKIE}=forged` }), TOKEN, false), false);
});

test('query token authorizes only when allowed', () => {
  const r = req({}, `/ws/channel?token=${TOKEN}`);
  assert.equal(isAuthorized(r, TOKEN, true), true);
  assert.equal(isAuthorized(r, TOKEN, false), false);
});

test('no credentials is unauthorized', () => {
  assert.equal(isAuthorized(req(), TOKEN, true), false);
});

test('cross-origin detection', () => {
  assert.equal(isCrossOrigin(req({ host: '127.0.0.1:7900' })), false);
  assert.equal(isCrossOrigin(req({ host: '127.0.0.1:7900', origin: 'http://127.0.0.1:7900' })), false);
  assert.equal(isCrossOrigin(req({ host: '127.0.0.1:7900', origin: 'http://evil.com' })), true);
  assert.equal(isCrossOrigin(req({ host: '127.0.0.1:7900', origin: 'http://127.0.0.1:7900.evil.com' })), true);
  assert.equal(isCrossOrigin(req({ host: '127.0.0.1:7900', origin: 'null' })), true);
});

test('json content-type detection', () => {
  assert.equal(isJsonRequest(req({ 'content-type': 'application/json; charset=utf-8' })), true);
  assert.equal(isJsonRequest(req({ 'content-type': 'text/plain' })), false);
  assert.equal(isJsonRequest(req()), false);
});

test('secure request detection', () => {
  assert.equal(isSecureRequest(req({ 'x-forwarded-proto': 'https' })), true);
  assert.equal(isSecureRequest(req()), false);
});
