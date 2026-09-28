# Hub Auth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 허브의 루프백 인증 면제를 없애고 모든 연결에 토큰(Bearer / WS 쿼리 / 대시보드 쿠키)을 요구하며, Origin·Content-Type 방어, 소켓 소유권, 메시지 크기 제한, 텔레그램 콜백 채팅 확인을 추가한다.

**Architecture:** 인증 판정은 순수 함수 모듈 `src/hub/auth.ts`로 분리하고 `HubServer`의 HTTP 핸들러·업그레이드 핸들러가 이를 호출한다. 대시보드는 `POST /api/login` 또는 `/?token=` 로그인 링크로 HttpOnly 쿠키를 받고 이후 동일 출처 요청에 쿠키만 쓴다. 채널 서버는 기존대로 `?token=` WS 쿼리를 보낸다.

**Tech Stack:** TypeScript ESM, `node:http`, `ws`, `node:crypto`, `node:test` + `tsx`, 단일 파일 대시보드.

**Spec:** `docs/superpowers/specs/2026-09-28-hub-auth-hardening-design.md`

## Global Constraints

- 인증 불필요 경로는 `GET /`, `POST /api/login` 두 개뿐.
- `?token=` 쿼리 인증은 **WebSocket 업그레이드에만** 허용.
- 쿠키: `ca_session=<HMAC-SHA256(key=token, "claude-alarm-dashboard") hex>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (+ `; Secure` when `X-Forwarded-Proto: https`).
- 토큰 비교는 `crypto.timingSafeEqual`.
- 처리 순서 HTTP: Origin → POST Content-Type → 무인증 경로 → 인증 → 라우팅. 업그레이드: Origin → 인증 → 경로.
- `maxPayload: 16 * 1024 * 1024` (채널·대시보드 WSS).
- `isLocalRequest`는 인증에 쓰지 않는다 (세션 `isLocal` 판정에만).
- 허브 `token`이 없으면 인증 생략 (legacy; `loadConfig()`가 항상 토큰을 생성하므로 실사용 경로엔 없음).
- 주석 규칙: 기본 없음, 외부 제약·함정만 영어로. 섹션 구분선 주석 추가 금지.
- 대시보드 UI 문자열은 영어.

## Review Focus

1. **대시보드가 인증 실패 시 무한 재연결** — WS가 open 전에 닫힐 때 인증 상태를 확인하지 않으면 3초마다 401 업그레이드를 반복. → Task 5 `connect()`의 `opened` 플래그 + `checkAuth()` 분기, 수동 검증 항목.
2. **토큰 없는 `Origin: null`** (샌드박스 iframe, file://) — `new URL('null')` 예외 → 교차 출처로 취급해 거부해야 함. → Task 1 테스트.
3. **악성 쿠키 헤더** (`ca_session=%E0%A4%A`처럼 잘못된 퍼센트 인코딩) — 파싱 예외로 허브가 죽으면 안 됨. → Task 1 테스트.
4. **닫힌 기존 소켓이 id를 쥔 채 재연결** — 채널 재연결 시 이전 소켓의 close 이벤트가 늦게 오면 새 register가 거부되면 안 됨. → Task 3 테스트 (`holder.readyState !== OPEN`이면 허용).
5. **설정 화면 POST에 Content-Type 누락** — 415로 조용히 실패. 대시보드의 모든 POST fetch가 `application/json`인지 확인. → Task 5 Step 4 grep 검증.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/hub/auth.ts` | 토큰·쿠키·Origin·Content-Type 판정 순수 함수 | 생성 |
| `test/hub-auth-unit.test.ts` | auth.ts 단위 테스트 | 생성 |
| `src/hub/server.ts` | 인증 배선, 로그인 엔드포인트, CORS 제거, maxPayload, 소켓 소유권 | 수정 |
| `test/hub-auth.test.ts` | HubServer 인증 통합 테스트 | 생성 |
| `test/hub-ownership.test.ts` | 소켓 소유권 통합 테스트 | 생성 |
| `test/hub-peer-name.test.ts` | 기존 — 토큰 사용 방식 유지, 통과 확인 | 필요 시 수정 |
| `src/hub/telegram.ts` | 콜백 채팅 id 확인 | 수정 |
| `test/telegram-callback.test.ts` | 콜백 채팅 확인 테스트 | 생성 |
| `src/dashboard/index.html` | 쿠키 로그인 흐름, tokenQuery 제거 | 수정 |
| `src/cli.ts` | `/api/status` Bearer, 로그인 링크 출력 | 수정 |
| `README.md` | Authentication, Remote Access 재작성, 업그레이드 노트 | 수정 |

---

### Task 1: `auth.ts` 순수 함수

**Files:**
- Create: `src/hub/auth.ts`
- Create: `test/hub-auth-unit.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_COOKIE = 'ca_session'`
  - `safeEqual(a: string | null | undefined, b: string): boolean`
  - `dashboardCookieValue(token: string): string`
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `sessionCookieHeader(token: string, secure: boolean): string`
  - `type RequestLike = { headers: http.IncomingHttpHeaders; url?: string }`
  - `isAuthorized(req: RequestLike, token: string, allowQueryToken: boolean): boolean`
  - `isCrossOrigin(req: RequestLike): boolean`
  - `isJsonRequest(req: RequestLike): boolean`
  - `isSecureRequest(req: RequestLike): boolean`

- [ ] **Step 1: 실패하는 테스트**

`test/hub-auth-unit.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: `hub-auth-unit.test.ts` 실패 — `Cannot find module '../src/hub/auth.js'`.

- [ ] **Step 3: 구현**

`src/hub/auth.ts`:

```ts
import crypto from 'node:crypto';
import type http from 'node:http';

export const SESSION_COOKIE = 'ca_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export type RequestLike = { headers: http.IncomingHttpHeaders; url?: string };

export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function dashboardCookieValue(token: string): string {
  return crypto.createHmac('sha256', token).update('claude-alarm-dashboard').digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch {}
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${dashboardCookieValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure ? '; Secure' : ''}`;
}

export function isAuthorized(req: RequestLike, token: string, allowQueryToken: boolean): boolean {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
  if (safeEqual(parseCookies(req.headers.cookie)[SESSION_COOKIE], dashboardCookieValue(token))) return true;
  if (allowQueryToken) {
    const q = new URL(req.url ?? '/', 'http://hub').searchParams.get('token');
    if (safeEqual(q, token)) return true;
  }
  return false;
}

export function isCrossOrigin(req: RequestLike): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export function isJsonRequest(req: RequestLike): boolean {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

export function isSecureRequest(req: RequestLike): boolean {
  return req.headers['x-forwarded-proto'] === 'https';
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test`
Expected: 신규 11개 포함 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/auth.ts test/hub-auth-unit.test.ts
git commit -m "feat(hub): add token, cookie and origin auth helpers"
```

---

### Task 2: HubServer 인증 배선

**Files:**
- Modify: `src/hub/server.ts` (imports, constructor WSS 생성 `:73-80`, upgrade 핸들러 `:83-111`, `handleHttp` `:162-243`, `serveDashboard` `:245`, 신규 `handleLogin`, `authorized`)
- Create: `test/hub-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 전부.
- Produces: `POST /api/login` (204/401), `GET /?token=` (302/200). 에러 응답 JSON `{ error }`: 401 `Unauthorized`, 403 `Cross-origin request rejected`, 415 `Content-Type must be application/json`. 업그레이드 거부는 `HTTP/1.1 401 Unauthorized` 또는 `403 Forbidden` 응답 후 소켓 파기.

- [ ] **Step 1: 실패하는 통합 테스트**

`test/hub-auth.test.ts`:

```ts
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

test('oversized frames close the connection', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/channel?token=${TOKEN}`);
  await new Promise((r) => ws.on('open', r));
  const code = await new Promise<number>((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.send('x'.repeat(16 * 1024 * 1024 + 1));
  });
  assert.equal(code, 1009);
});
```

(`ws` 클라이언트의 `headers` 옵션으로 `Origin`/`Cookie`를 설정할 수 있다. `fetch`는 Node 22 내장.)

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: `hub-auth.test.ts`에서 인증 거부·로그인·415·1009 관련 테스트 FAIL (현재 루프백 면제로 open/200, `/api/login` 404 등).

- [ ] **Step 3: import와 WSS maxPayload**

`src/hub/server.ts` import 블록에 추가:

```ts
import {
  isAuthorized,
  isCrossOrigin,
  isJsonRequest,
  isSecureRequest,
  safeEqual,
  sessionCookieHeader,
} from './auth.js';
```

WSS 생성 두 곳을 교체:

```ts
    this.wssChannel = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
```
```ts
    this.wssDashboard = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
```

클래스 선언 위(`const __dirname = ...` 다음)에:

```ts
// 10MB images arrive base64-encoded (~13.4MB) over the dashboard socket.
const MAX_WS_PAYLOAD = 16 * 1024 * 1024;
```

- [ ] **Step 4: 업그레이드 핸들러**

기존 토큰 검사 블록(`// Token auth for WebSocket connections (skip for local requests)`부터 해당 `if` 블록 끝까지)을 교체:

```ts
      if (isCrossOrigin(req)) {
        this.rejectUpgrade(socket, 403, 'Forbidden', pathname, req);
        return;
      }
      if (!this.authorized(req, true)) {
        this.rejectUpgrade(socket, 401, 'Unauthorized', pathname, req);
        return;
      }
```

클래스에 헬퍼 추가 (`isLocalRequest` 앞):

```ts
  private authorized(req: http.IncomingMessage, allowQueryToken: boolean): boolean {
    return !this.token || isAuthorized(req, this.token, allowQueryToken);
  }

  private rejectUpgrade(socket: import('node:stream').Duplex, status: number, text: string, pathname: string, req: http.IncomingMessage): void {
    logger.warn(`Rejected ${pathname} upgrade (${status}) from ${req.socket.remoteAddress}`);
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
```

- [ ] **Step 5: handleHttp**

`handleHttp`의 시작부터 `// Route` 직전까지(CORS·OPTIONS·기존 토큰 검사)를 교체:

```ts
  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (isCrossOrigin(req)) {
      this.jsonResponse(res, 403, { error: 'Cross-origin request rejected' });
      return;
    }
    if (req.method === 'POST' && !isJsonRequest(req)) {
      this.jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      this.serveDashboard(req, res, url);
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      this.handleLogin(req, res);
      return;
    }
    if (!this.authorized(req, false)) {
      this.jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }
```

라우팅 체인의 첫 분기 `if (url.pathname === '/' && req.method === 'GET') { this.serveDashboard(res); } else if (url.pathname === '/api/sessions' ...` 에서 `/` 분기를 제거해 `if (url.pathname === '/api/sessions' && req.method === 'GET') {`로 시작하게 한다.

- [ ] **Step 6: serveDashboard 로그인 링크 + handleLogin**

`serveDashboard` 시그니처와 앞부분:

```ts
  private serveDashboard(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const linkToken = url.searchParams.get('token');
    if (linkToken !== null && this.token && safeEqual(linkToken, this.token)) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(this.token, isSecureRequest(req)) });
      res.end();
      return;
    }
```

(기존 후보 경로 탐색 코드는 그대로 이어진다.)

`handleApiSend` 앞에 추가:

```ts
  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req) as { token?: unknown } | null;
    if (!this.token) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (typeof body?.token !== 'string' || !safeEqual(body.token, this.token)) {
      this.jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }
    res.writeHead(204, { 'Set-Cookie': sessionCookieHeader(this.token, isSecureRequest(req)) });
    res.end();
  }
```

- [ ] **Step 7: 기존 테스트 확인과 통과 확인**

`test/hub-peer-name.test.ts`는 이미 `?token=t`로 연결하고 허브 토큰도 `t`이므로 변경 불필요.

Run: `npx tsc --noEmit && npm test`
Expected: 전부 PASS (hub-auth 12개 포함).

- [ ] **Step 8: Commit**

```bash
git add src/hub/server.ts test/hub-auth.test.ts
git commit -m "feat(hub)!: require token auth for all clients, add cookie login and origin checks"
```

---

### Task 3: 채널 소켓 소유권

**Files:**
- Modify: `src/hub/server.ts` (`handleChannelMessage` 시작부, `peer_name` 분기, 필드 추가)
- Create: `test/hub-ownership.test.ts`

**Interfaces:**
- Consumes: Task 2 인증 (테스트는 `?token=` 사용).
- Produces: `private socketOwners = new WeakMap<WebSocket, string>()`.

- [ ] **Step 1: 실패하는 테스트**

`test/hub-ownership.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7996;
const TOKEN = 'own-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function register(ws: WebSocket, id: string) {
  ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
}

async function send(sessionId: string, content: string) {
  return fetch(`http://127.0.0.1:${PORT}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sessionId, content }),
  });
}

test('a second socket cannot take over a live session id', async () => {
  const a = await open('/ws/channel');
  const b = await open('/ws/channel');
  register(a.ws, 'dup');
  await settle();
  register(b.ws, 'dup');
  await settle();
  await send('dup', 'hello');
  await settle();
  assert.equal(a.inbox.filter((m) => m.type === 'message_to_session').length, 1);
  assert.equal(b.inbox.filter((m) => m.type === 'message_to_session').length, 0);
  a.ws.close(); b.ws.close();
});

test('a socket cannot speak for a session it does not own', async () => {
  const dash = await open('/ws/dashboard');
  const a = await open('/ws/channel');
  const b = await open('/ws/channel');
  register(a.ws, 'owner');
  register(b.ws, 'intruder');
  await settle();
  b.ws.send(JSON.stringify({ type: 'reply', sessionId: 'owner', content: 'spoofed' }));
  a.ws.send(JSON.stringify({ type: 'reply', sessionId: 'owner', content: 'genuine' }));
  await settle();
  const replies = dash.inbox.filter((m) => m.type === 'reply_from_session').map((m) => m.content);
  assert.deepEqual(replies, ['genuine']);
  dash.ws.close(); a.ws.close(); b.ws.close();
});

test('a reconnect may reclaim an id whose old socket is closed', async () => {
  const a = await open('/ws/channel');
  register(a.ws, 'reco');
  await settle();
  a.ws.terminate();
  const b = await open('/ws/channel');
  register(b.ws, 'reco');
  await settle();
  await send('reco', 'after');
  await settle();
  assert.equal(b.inbox.filter((m) => m.type === 'message_to_session').length, 1);
  b.ws.close();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: 처음 두 테스트 FAIL (현재 덮어쓰기·사칭 허용).

- [ ] **Step 3: 구현**

`src/hub/server.ts` 필드(`private channelAlive ...` 다음):

```ts
  private socketOwners = new WeakMap<WebSocket, string>();
```

`handleChannelMessage` 본문 맨 앞(`switch` 전):

```ts
    if (msg.type === 'register') {
      const id = msg.session.id;
      const owned = this.socketOwners.get(ws);
      const holder = this.channelSockets.get(id);
      if ((owned && owned !== id) || (holder && holder !== ws && holder.readyState === WebSocket.OPEN)) {
        logger.warn(`Rejected register for ${id}: id is held by another connection`);
        return;
      }
      this.socketOwners.set(ws, id);
    } else if ('sessionId' in msg && this.socketOwners.get(ws) !== msg.sessionId) {
      return;
    }
```

`case 'peer_name':`의 `if (this.channelSockets.get(msg.sessionId) !== ws) break;` 줄 삭제 (공통 검사로 대체).

- [ ] **Step 4: 통과 확인**

Run: `npx tsc --noEmit && npm test`
Expected: 전부 PASS (`hub-peer-name` 포함).

- [ ] **Step 5: Commit**

```bash
git add src/hub/server.ts test/hub-ownership.test.ts
git commit -m "feat(hub): bind channel sockets to their session ids"
```

---

### Task 4: 텔레그램 콜백 채팅 확인

**Files:**
- Modify: `src/hub/telegram.ts:375-377`
- Create: `test/telegram-callback.test.ts`

- [ ] **Step 1: 실패하는 테스트**

`test/telegram-callback.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인**

Run: `npm test`
Expected: 첫 테스트 FAIL (`['req1:allow']` !== `[]`).

- [ ] **Step 3: 구현**

`handleCallbackQuery`의 `if (!query.data) return;` 다음 줄:

```ts
    if (String(query.message?.chat.id) !== String(this.config.chatId)) return;
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsc --noEmit && npm test`
Expected: 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram.ts test/telegram-callback.test.ts
git commit -m "fix(telegram): only accept button callbacks from the configured chat"
```

---

### Task 5: 대시보드 로그인 흐름 · CLI · README

**Files:**
- Modify: `src/dashboard/index.html` (토큰 폼 문구 `:874`, 토큰 처리 `:1293-1318`, `connect()` `:1321-1343`, 설정 fetch 6곳, 초기화 `:2338-2339`)
- Modify: `src/cli.ts` (`:67`, `:89-90`, `:98-99`, `:157`, `:277`)
- Modify: `README.md`

- [ ] **Step 1: 토큰 폼 문구**

```html
    <p>Enter the hub token to connect. Run <code>claude-alarm token</code>, or open the login link printed by <code>claude-alarm hub start</code>.</p>
```

- [ ] **Step 2: 토큰 처리 교체**

`function getToken() { ... }` 전체와 기존 `#tokenSubmit` 클릭 리스너를 교체:

```js
  async function checkAuth() {
    try {
      return (await fetch('/api/status')).status !== 401;
    } catch {
      return true;
    }
  }

  function showTokenForm() { $('#tokenOverlay').classList.remove('hidden'); }
  function hideTokenForm() { $('#tokenOverlay').classList.add('hidden'); }

  $('#tokenSubmit').addEventListener('click', async () => {
    const token = $('#tokenInput').value.trim();
    if (!token) return;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    if (!res || !res.ok) { $('#tokenError').style.display = 'block'; return; }
    $('#tokenError').style.display = 'none';
    $('#tokenInput').value = '';
    hideTokenForm();
    connect();
  });
```

(기존 `showTokenForm`/`hideTokenForm` 정의는 위 블록으로 옮겨지므로 중복 정의를 남기지 않는다. `#tokenInput` keydown 리스너는 유지.)

`state` 객체의 `token: null,` 줄 삭제.

- [ ] **Step 3: connect() 교체**

```js
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
    let opened = false;

    ws.onopen = () => {
      opened = true;
      state.ws = ws;
      hideTokenForm();
      $('#connDot').classList.add('connected');
      $('#connLabel').textContent = 'Connected';
    };
    ws.onclose = async () => {
      state.ws = null;
      $('#connDot').classList.remove('connected');
      $('#connLabel').textContent = 'Disconnected';
      if (!opened && !(await checkAuth())) { showTokenForm(); return; }
      setTimeout(connect, 3000);
    };
    ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch {} };
  }
```

(`ws.onerror` 핸들러는 삭제 — 실패 시 `onclose`가 뒤따른다.)

- [ ] **Step 4: 설정 fetch의 tokenQuery 제거**

6곳에서 `const tokenQuery = state.token ? ... : '';` 줄을 삭제하고 URL의 `${tokenQuery}`를 제거:
`/api/webhooks` (GET, POST), `/api/telegram` (GET, POST), `/api/telegram/detect`, `/api/telegram/test`.

초기화 두 줄 교체:

```js
  checkAuth().then((ok) => (ok ? connect() : showTokenForm()));
```

검증:

Run: `grep -n "tokenQuery\|state.token\|sessionStorage\|getToken" src/dashboard/index.html`
Expected: 출력 없음.

Run: `grep -n "method: 'POST'" -A1 src/dashboard/index.html`
Expected: 모든 POST 다음 줄이 `headers: { 'Content-Type': 'application/json' },`.

- [ ] **Step 5: CLI**

`src/cli.ts` 상단 헬퍼 추가 (`printUsage` 앞):

```ts
function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function loginLink(displayHost: string, port: number, token?: string): string {
  return `http://${displayHost}:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
```

- 이미 실행 중 메시지(`:67`): `console.log(\`Hub is already running (PID: ${pid}). Dashboard: ${loginLink(displayHost, port, config.hub.token)}\`);`
- 데몬 출력(`:89`): `console.log(\`Dashboard: ${loginLink(displayHost, port, config.hub.token)}\`);`
- 포그라운드(`:98` 다음 줄에 추가): `console.log(\`Dashboard: ${loginLink(displayHost, port, config.hub.token)}\`);`
- `/api/status` fetch 두 곳(`:157`, `:277`): `fetch(\`http://${host}:${port}/api/status\`, { headers: authHeaders(config.hub.token) })`

- [ ] **Step 6: README**

`## Remote Access` 섹션 전체를 교체하고, 그 앞에 `## Authentication` 추가:

~~~markdown
## Authentication

Every connection to the hub needs the hub token — including ones from the same machine.

- **Channel servers** read it from `~/.claude-alarm/config.json` automatically (or `CLAUDE_ALARM_HUB_TOKEN`).
- **Dashboard**: open the login link printed by `claude-alarm hub start` (`http://127.0.0.1:7900/?token=…`), or paste the token from `claude-alarm token` into the login form. The browser keeps an HttpOnly cookie for 30 days; the token is removed from the URL.
- **CLI / scripts**: send `Authorization: Bearer <token>`.

> Upgrading from 0.9.x: a local session that sets `CLAUDE_ALARM_HUB_TOKEN` to a different value than the hub's token no longer connects. Scripts that called the local API without a token now get `401`.

## Remote Access

Pick one:

1. **Tailscale (recommended)** — set `host` to the hub machine's Tailscale IP and use that address from other machines. Traffic is encrypted and never exposed to the internet.
2. **Cloudflare Tunnel / nginx with HTTPS** — keep `host: "127.0.0.1"` and point the tunnel or proxy at `http://127.0.0.1:7900`. Forward `X-Forwarded-Proto` so the dashboard cookie is marked `Secure`.
3. **Direct `0.0.0.0`** — set `host` to `0.0.0.0` and open port 7900. Traffic, including the token, is plain HTTP: use only on networks you trust.

On the remote machine run `claude-alarm init` → select remote hub (Y), or configure:

```json
{
  "mcpServers": {
    "claude-alarm": {
      "command": "npx",
      "args": ["-y", "@delt/claude-alarm", "serve"],
      "env": {
        "CLAUDE_ALARM_HUB_HOST": "your-hub-address",
        "CLAUDE_ALARM_HUB_PORT": "7900",
        "CLAUDE_ALARM_HUB_TOKEN": "your-token"
      }
    }
  }
}
```
~~~


- [ ] **Step 7: 빌드·테스트**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: 전부 통과.

- [ ] **Step 8: 수동 검증 (Chrome + 격리 HOME)**

임시 `USERPROFILE`로 CLI를 격리해 실행 (실제 `~/.claude-alarm`을 건드리지 않음):

```bash
export USERPROFILE=<scratchpad>/home HOME=<scratchpad>/home
node dist/cli.js hub start          # 포그라운드, 출력에 Dashboard 로그인 링크 확인
node dist/cli.js hub status          # 다른 셸에서: "Hub: running" 확인 (Bearer 동작)
```

Chrome에서:

| 동작 | 기대 결과 |
|---|---|
| `http://127.0.0.1:7900/` 첫 접속 | 토큰 폼 표시, 재연결 반복 없음 (허브 로그에 401 한 번) |
| 틀린 토큰 제출 | 오류 문구 |
| 올바른 토큰 제출 | 연결됨, 새로고침 후에도 유지 |
| 쿠키 삭제 후 로그인 링크 열기 | 연결됨, 주소창이 `/`로 정리 |
| 설정(⚙) 열기 → 웹훅/텔레그램 로드, 웹훅 저장 | 성공 (401/415 없음) |

- [ ] **Step 9: Commit**

```bash
git add src/dashboard/index.html src/cli.ts README.md
git commit -m "feat: cookie-based dashboard login, CLI bearer auth, remote access docs"
```

---

## 최종 확인

- [ ] `npx tsc --noEmit && npm run build && npm test` 통과
- [ ] `git grep -n "isLocalRequest(req)" src/hub/server.ts` — 인증 분기에 남아 있지 않고 `handleChannelConnection`의 locality 판정에만 존재
