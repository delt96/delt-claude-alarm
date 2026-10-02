# Codex New Thread from the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 세션 목록의 "+"에서 PC와 폴더를 골라 새 Codex 대화를 만들고, 대시보드에서 닫을 때까지 어댑터가 그 대화를 붙잡는다.

**Architecture:** 어댑터가 대화별 연결과 별개로 Hub에 어댑터 전용 WebSocket `/ws/codex`를 하나 열어 `adapter_hello`(id, host, ready)를 보낸다. Hub는 어댑터 목록을 대시보드에 `codex_adapters`로 방송하고, 대시보드의 HTTP 요청(`/api/codex/folders`, `/api/codex/threads`)을 `adapter_call`로 넘겨 `adapter_result`를 기다린다. 어댑터는 만든 대화를 메모리 고정 목록(`pins`)에 넣어 구독을 유지하고, 닫기(`/api/codex/threads/close` → 대화별 채널의 `codex_close`)로 놓는다.

**Tech Stack:** TypeScript ESM, `ws`, `node:test` + `tsx`, Codex app-server JSON-RPC(데몬 proxy), 단일 파일 대시보드(`src/dashboard/index.html`, 인라인 스크립트).

**Spec:** `docs/superpowers/specs/2026-10-02-codex-new-thread-design.md`

## Global Constraints

- `thread/start` 파라미터(정확히 이대로): `{ cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' }`. 이 요청에는 RPC 시간 제한을 두지 않는다(`rpc.request(..., null)`).
- 폴더 목록: `thread/list { limit: 50, sortKey: 'updated_at' }`의 `cwd`를 나온 순서대로 중복 없이 최대 10개.
- Hub 대기 요청 시간 제한 기본 `60_000`ms, `new HubServer(config, { codexCallTimeoutMs })`로 주입.
- 새 WS 경로 `WS_PATH_CODEX = '/ws/codex'`. 인증·같은 출처 검사는 다른 경로와 같다.
- 문구(영어, 정확히 이대로):
  - Hub 404: `Codex adapter is not connected` · 502: `Codex adapter disconnected` · 504: `Codex did not respond in time. The conversation may still appear.` · 닫기 404: `No closable Codex conversation` · 400: `adapterId is required` / `adapterId and cwd are required` / `sessionId is required`
  - 어댑터: `Codex is not connected on <host>.` · `Folder not found on <host>: <cwd>` · `Codex could not start the conversation: <message>` · `Codex started a conversation claude-alarm cannot follow.`
  - 닫기 실패 알림: title `Not closed`, message `Codex did not release the conversation. Try closing it again.`, level `warning`
  - 대시보드: 경고 `Runs with full access: no approval prompts.`, 버튼 `Create` / `Creating…`, 닫기 툴팁 `Close — stays in Codex history`, 확정 문구 `Close?`
- 새 의존성 없음.
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선·코드 재진술 주석 금지(대시보드의 기존 `// --- 이름 ---` 블록 표지는 테스트 기준점이라 예외).
- 포트: 새 테스트 7980(Hub)·7981(어댑터 연결)·7982(어댑터). 실측 Hub는 7983–7988. 7900(사용자 실제 Hub)과 7989–7998(기존 테스트·claude-alarm-6c 세션)은 쓰지 않는다.
- Hub를 띄우는 모든 실행은 임시 HOME(`HOME`과 `USERPROFILE`을 같은 임시 폴더로). 실제 `~/.claude-alarm`을 건드리지 않는다. 텔레그램으로 아무것도 나가면 안 된다.
- 프로세스는 자기가 띄운 PID만 끝낸다. 이미지 이름(`node.exe`, `codex.exe` 등)으로 일괄 종료 금지.
- 실제 Codex 데몬을 쓰는 실측(Task 1, Task 8)은 시작 전에 claude-alarm `notify`로 사용자에게 알린다. 컨트롤러가 직접 하고 위임하지 않는다.
- 테스트 실행: 단일 파일 `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`, 전체 `npm test`, 타입 검사 `npx tsc --noEmit`, 빌드 `npm run build`. 전체 `npm test`는 7990–7998을 쓰므로 실행 전에 claude-alarm-6c 세션에 알린다(겹치면 EADDRINUSE).

## Review Focus

1. **탐색기 "경로로 복사"로 붙여 넣은 폴더**(`"C:\work\proj" ` — 큰따옴표와 뒤 공백): 따옴표·공백을 벗기고 만들어야 한다. → Task 5 "creating starts a full-access conversation" 테스트(따옴표·공백 포함 입력)와 `cleanFolder` 단위 테스트.
2. **한글·공백이 든 폴더 이름**(`C:\작업\새 프로젝트`): JSON·`fs.stat`·제목을 거쳐도 깨지지 않아야 한다. → Task 5 테스트 폴더 이름 `claude-alarm 새 대화-XXXX`.
3. **폰에서 닫기 버튼을 실수로 두 번 빠르게 탭**: 바로 닫히면 안 된다. 두 번째 탭은 첫 탭 뒤 0.4초 이후부터 유효. → Task 7 `closeStep` 테스트(`'wait'`).
4. **같은 이름의 PC 두 대(또는 한 PC의 HOME 두 개)에서 어댑터가 붙음**: PC 선택에서 구분되어야 한다. → Task 7 `adapterLabels` 테스트.
5. **Hub만 재시작되고 다른 PC의 어댑터(`codex start`)는 계속 떠 있음**: 어댑터가 다시 붙어 목록에 다시 나타나야 한다. → Task 4 "reconnects to a restarted hub" 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/constants.ts` | `WS_PATH_CODEX` | 수정 |
| `src/shared/types.ts` | `SessionInfo.closable`, `CodexAdapterInfo`, `CodexCall`, `CodexLinkMessage`, `ChannelMessage`의 `codex_adapters`·`codex_close` | 수정 |
| `src/hub/server.ts` | `/ws/codex` 연결·어댑터 목록·방송·하트비트, `adapter_call` 대기 요청, `/api/codex/*` 3개 | 수정 |
| `src/codex/hub-link.ts` | 어댑터 쪽 `/ws/codex` 클라이언트(hello, 재접속, call→result) | 생성 |
| `src/codex/rpc.ts` | 요청별 시간 제한(`null` = 없음) | 수정 |
| `src/codex/mapping.ts` | `cleanFolder()` | 수정 |
| `src/codex/adapter.ts` | ready, folders, create, pins, close, 고정 해제, discover 정리, 제목 다시 읽기 | 수정 |
| `src/dashboard/index.html` | "+" 팝업 Codex 부분, 닫기 버튼, `codex_adapters` 처리 | 수정 |
| `README.md` | Codex Sessions·Remote Access 안내 | 수정 |
| `test/helpers/fake-codex-daemon.ts` | Promise를 돌려주는 처리기 지원 | 수정 |
| `test/hub-codex.test.ts` | Hub 쪽 | 생성 |
| `test/codex-hub-link.test.ts` | 어댑터 연결 | 생성 |
| `test/codex-new-thread.test.ts` | 어댑터 만들기·닫기 | 생성 |
| `test/codex-rpc.test.ts`, `test/codex-mapping.test.ts` | 단위 | 수정 |
| `test/dashboard-codex.test.ts` | 대시보드 도우미 | 생성 |

`<scratchpad>`는 실행하는 컨트롤러 세션의 scratchpad 디렉터리다(커밋하지 않는 실측 파일·격리 HOME).

작업 위치: worktree `C:\workspace\claude-alarm\.claude\worktrees\codex-new-thread`, 브랜치 `feat/codex-new-thread`(기준 main 1df1edd). 실행 전 `npm install`과 기준 테스트(`npm test`, 6c에 알린 뒤)를 한 번 돌린다. claude-alarm-6c의 `fix/codex-start-check`(`adapter.ts` `connect()`의 `onFirstConnect`, `main.ts` Hub 주소 공용 함수)가 main에 먼저 들어가면 rebase한다.

---

### Task 1: 실측 관문 — `thread/start`를 부른 연결이 대화를 붙잡는가 (컨트롤러가 직접)

어댑터 구현 전에 스펙의 핵심 가정을 실제 데몬으로 확인한다. **실패하면 Task 2 이후를 시작하지 않고 설계로 돌아간다.** 코드 변경·커밋 없음.

**Files:**
- Create (커밋 안 함): `<scratchpad>/probe-new-thread.mts`

- [ ] **Step 1: 사용자에게 미리 알린다**

claude-alarm `notify`(level `info`): title `Codex probe`, message `Starting a 3-minute probe against the real Codex daemon: one empty conversation in C:\tmp\codex-new-thread-probe (no turns). It may appear on the dashboard; do not answer anything for it.`

- [ ] **Step 2: 실측 스크립트를 쓴다**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WT = process.argv[2];
const { connectProxy } = await import(pathToFileURL(path.join(WT, 'src/codex/transport.ts')).href);
const { RpcClient } = await import(pathToFileURL(path.join(WT, 'src/codex/rpc.ts')).href);

const cwd = 'C:\\tmp\\codex-new-thread-probe';
fs.mkdirSync(cwd, { recursive: true });
const configFile = path.join(os.homedir(), '.codex', 'config.toml');
const trusted = () => fs.readFileSync(configFile, 'utf8').toLowerCase().includes(`[projects.'${cwd.toLowerCase()}']`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function open(name: string) {
  const conn = await connectProxy('codex');
  const rpc = new RpcClient(conn.ws, 120_000);
  await rpc.request('initialize', { clientInfo: { name, version: '0' } });
  rpc.notify('initialized');
  return { conn, rpc };
}

async function isLoaded(rpc: any, id: string): Promise<boolean> {
  const ids: string[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await rpc.request('thread/loaded/list', cursor ? { cursor } : {});
    ids.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return ids.includes(id);
}

const trustedBefore = trusted();
const creator = await open('claude-alarm-probe-creator');
const observer = await open('claude-alarm-probe-observer');
let id = '';
creator.rpc.on('notification', (method: string, params: any) => {
  if (params?.threadId === id || params?.thread?.id === id) console.log(`${at()} creator got ${method} ${JSON.stringify(params?.status ?? '')}`);
});
const startedAt = Date.now();
const res = await creator.rpc.request('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' });
id = res.thread.id;
console.log(`${at()} thread/start took ${Date.now() - startedAt}ms id=${id} status=${res.thread.status.type} sandbox=${JSON.stringify(res.sandbox)} approvalPolicy=${JSON.stringify(res.approvalPolicy)}`);
for (const s of [30, 65, 95]) {
  await sleep(startedAt + s * 1000 - Date.now());
  console.log(`${at()} creator open, no turns: loaded=${await isLoaded(observer.rpc, id)}`);
}
const un = await creator.rpc.request('thread/unsubscribe', { threadId: id });
const unAt = Date.now();
console.log(`${at()} unsubscribe -> ${JSON.stringify(un)}`);
let goneAfter: number | undefined;
while (Date.now() - unAt < 90_000) {
  await sleep(5000);
  if (!(await isLoaded(observer.rpc, id))) {
    goneAfter = Date.now() - unAt;
    break;
  }
}
console.log(`${at()} unloaded ${goneAfter === undefined ? 'NOT within 90s' : `after ~${Math.round(goneAfter / 1000)}s`}`);
console.log(`config.toml trusted entry for ${cwd}: before=${trustedBefore} after=${trusted()}`);
creator.conn.close();
observer.conn.close();
```

- [ ] **Step 3: 실행한다(약 3분, 백그라운드)**

Run: `node --import tsx <scratchpad>/probe-new-thread.mts "C:/workspace/claude-alarm/.claude/worktrees/codex-new-thread"` (worktree에서)

통과 조건:
- `thread/start took …ms` — 값을 기록한다(Hub 60초 제한이 맞는지)
- 30s·65s·95s 모두 `loaded=true` — **만든 연결이 resume 없이 대화를 붙잡는다**
- `unloaded after ~55–70s` — 만든 연결의 unsubscribe도 다른 구독자 이탈처럼 60초 언로드

95s에 `loaded=false`면 **멈추고** 결과를 사용자에게 보고한다(설계 재검토). `unloaded NOT within 90s`면 닫기 설계(Task 6)가 틀렸으므로 역시 멈춘다.

- [ ] **Step 4: 결과를 기록한다**

출력 전체를 Obsidian 작업 문서(`Projects/claude_alarm/docs/tasks/2026-10-02-세션-추가로-codex-대화-만들기.md`)의 "실측" 절에 붙이고, `config.toml` trusted 항목 변화(스펙 실측 8)와 `thread/start` 시간을 적는다. 프로세스가 남지 않았는지 스크립트 종료로 확인(자기 PID만).

---

### Task 2: 공용 타입과 Hub의 어댑터 목록 (`/ws/codex`)

**Files:**
- Modify: `src/shared/constants.ts:15-16`
- Modify: `src/shared/types.ts:24-37`, `:40-59`
- Modify: `src/hub/server.ts` (imports 9-15·23, 필드 47-73, constructor 75-141, `stop()` 161-190, `handleDashboardConnection` 544-554, `startHeartbeat` 842-856, 새 메서드)
- Test: `test/hub-codex.test.ts` (생성, 포트 7980)

**Interfaces:**
- Produces:
  - `WS_PATH_CODEX: '/ws/codex'`
  - `interface CodexAdapterInfo { id: string; host: string; ready: boolean; isLocal: boolean }`
  - `type CodexCall = { kind: 'folders' } | { kind: 'create'; cwd: string }`
  - `type CodexLinkMessage = { type: 'adapter_hello'; adapter: { id: string; host: string; ready: boolean } } | { type: 'adapter_call'; requestId: string; call: CodexCall } | { type: 'adapter_result'; requestId: string; ok: true; data: unknown } | { type: 'adapter_result'; requestId: string; ok: false; error: string }`
  - `ChannelMessage` += `{ type: 'codex_adapters'; adapters: CodexAdapterInfo[] }`, `{ type: 'codex_close'; sessionId: string }`
  - `SessionInfo.closable?: boolean`
  - `new HubServer(config?: Partial<AppConfig>, options?: { codexCallTimeoutMs?: number })`
  - 대시보드 접속 순서: `sessions_list` → `permission_pending` → `codex_adapters`

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `test/hub-codex.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7980;
const TOKEN = 'codex-hub-test';
const BASE = `http://127.0.0.1:${PORT}`;
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any, { codexCallTimeoutMs: 300 });
  await hub.start();
});
after(async () => { await hub.stop(); });

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

const latestAdapters = (inbox: any[]): any[] | undefined => inbox.filter((m) => m.type === 'codex_adapters').at(-1)?.adapters;

async function adapterLink(id: string, ready = true, host = 'pc-1') {
  const link = await open('/ws/codex');
  link.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id, host, ready } }));
  return link;
}

async function waitAdapter(id: string, present = true): Promise<void> {
  const dash = await open('/ws/dashboard');
  try {
    await until(() => {
      const list = latestAdapters(dash.inbox);
      return list !== undefined && list.some((a) => a.id === id) === present;
    });
  } finally {
    dash.ws.close();
  }
}

const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === WebSocket.CLOSED ? r() : ws.once('close', () => r())));

test('adapters that say hello are listed for dashboards, after the pending permissions', async () => {
  const dash = await open('/ws/dashboard');
  const link = await adapterLink('a1');
  try {
    const list = await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a1') && latestAdapters(dash.inbox));
    assert.deepEqual(list, [{ id: 'a1', host: 'pc-1', ready: true, isLocal: true }]);
    const late = await open('/ws/dashboard');
    try {
      const first = await until(() => latestAdapters(late.inbox));
      assert.deepEqual(first, [{ id: 'a1', host: 'pc-1', ready: true, isLocal: true }]);
      const types = late.inbox.map((m) => m.type);
      assert.equal(types.indexOf('codex_adapters'), types.indexOf('permission_pending') + 1);
    } finally {
      late.ws.close();
    }
  } finally {
    link.ws.close();
    dash.ws.close();
  }
  await waitAdapter('a1', false);
});

test('a new ready state updates the list and disconnecting removes the adapter', async () => {
  const dash = await open('/ws/dashboard');
  const link = await adapterLink('a2', false);
  try {
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a2' && a.ready === false));
    link.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id: 'a2', host: 'pc-1', ready: true } }));
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a2' && a.ready === true));
    link.ws.close();
    await until(() => latestAdapters(dash.inbox)?.every((a) => a.id !== 'a2'));
  } finally {
    dash.ws.close();
  }
});

test('a connection cannot switch adapter ids, and a reconnect with the same id replaces the old one', async () => {
  const dash = await open('/ws/dashboard');
  const first = await adapterLink('a3');
  try {
    await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a3'));
    first.ws.send(JSON.stringify({ type: 'adapter_hello', adapter: { id: 'other', host: 'pc-1', ready: true } }));
    const second = await adapterLink('a3', true, 'pc-2');
    await closed(first.ws);
    const list = await until(() => latestAdapters(dash.inbox)?.find((a) => a.id === 'a3' && a.host === 'pc-2') && latestAdapters(dash.inbox));
    assert.ok(!list!.some((a) => a.id === 'other'));
    second.ws.close();
    await until(() => latestAdapters(dash.inbox)?.every((a) => a.id !== 'a3'));
  } finally {
    dash.ws.close();
  }
});

test('the codex socket needs the hub token', async () => {
  const outcome = await new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/codex`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
  assert.equal(outcome, 401);
});
```

`waitAdapter`·`closed`는 Task 3 테스트도 쓴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-codex.test.ts`
Expected: FAIL — `/ws/codex` 업그레이드가 끊겨(`socket.destroy()`) `adapterLink`가 `error`로 거부되거나 `codex_adapters`가 오지 않아 `condition not met in time`. 토큰 테스트는 이미 401일 수 있다(인증이 경로 분기보다 먼저).

- [ ] **Step 3: 상수·타입을 더한다**

`src/shared/constants.ts`의 `WS_PATH_DASHBOARD` 아래:

```ts
export const WS_PATH_CODEX = '/ws/codex';
```

`src/shared/types.ts` — `SessionInfo`에 `title?: string;` 다음 줄로:

```ts
  closable?: boolean;
```

`ChannelMessage` 유니온 끝(`| { type: 'error'; message: string };` 앞)에:

```ts
  | { type: 'codex_adapters'; adapters: CodexAdapterInfo[] }
  | { type: 'codex_close'; sessionId: string }
```

`ChannelMessage` 정의 아래에:

```ts
export interface CodexAdapterInfo {
  id: string;
  host: string;
  ready: boolean;
  isLocal: boolean;
}

export type CodexCall = { kind: 'folders' } | { kind: 'create'; cwd: string };

/** Messages on the per-adapter socket between the Codex adapter and the hub */
export type CodexLinkMessage =
  | { type: 'adapter_hello'; adapter: { id: string; host: string; ready: boolean } }
  | { type: 'adapter_call'; requestId: string; call: CodexCall }
  | { type: 'adapter_result'; requestId: string; ok: true; data: unknown }
  | { type: 'adapter_result'; requestId: string; ok: false; error: string };
```

- [ ] **Step 4: Hub에 어댑터 목록을 구현한다** — `src/hub/server.ts`

imports: `WS_PATH_DASHBOARD,` 다음에 `WS_PATH_CODEX,`. 타입 import에 `CodexAdapterInfo, CodexLinkMessage`를 더한다.

필드(`private codexSupervisor?: CodexSupervisor;` 다음):

```ts
  private wssCodex: WebSocketServer;
  private codexAdapters = new Map<string, { ws: WebSocket; info: CodexAdapterInfo }>();
  private codexAlive = new WeakMap<WebSocket, boolean>();
  private codexCallTimeoutMs: number;
```

constructor 시그니처와 첫 줄:

```ts
  constructor(config?: Partial<AppConfig>, options: { codexCallTimeoutMs?: number } = {}) {
    this.codexCallTimeoutMs = options.codexCallTimeoutMs ?? 60_000;
```

`wssDashboard` 생성 블록 다음:

```ts
    this.wssCodex = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.wssCodex.on('connection', (ws: WebSocket, req: http.IncomingMessage) => this.handleCodexConnection(ws, req));
    this.wssCodex.on('error', (err) => logger.warn(`Codex WebSocket server error: ${err.message}`));
```

upgrade 분기의 `WS_PATH_DASHBOARD` 블록 다음, `else { socket.destroy(); }` 앞:

```ts
      } else if (pathname === WS_PATH_CODEX) {
        this.wssCodex.handleUpgrade(req, socket, head, (ws) => {
          this.wssCodex.emit('connection', ws, req);
        });
```

`stop()`: `for (const ws of this.dashboardSockets) ws.terminate();` 다음에 `for (const { ws } of this.codexAdapters.values()) ws.terminate();`, `this.wssDashboard.close();` 다음에 `this.wssCodex.close();`.

`handleDashboardConnection`의 `ws.send(JSON.stringify(pendingMsg));` 다음:

```ts
    ws.send(JSON.stringify({ type: 'codex_adapters', adapters: this.codexAdapterList() } satisfies ChannelMessage));
```

`startHeartbeat`의 `for (const [sessionId, ws] of this.channelSockets) { … }` 루프 다음(같은 interval 안):

```ts
      for (const { ws } of this.codexAdapters.values()) {
        if (this.codexAlive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        this.codexAlive.set(ws, false);
        ws.ping();
      }
```

새 메서드(`// --- Dashboard WebSocket ---` 앞):

```ts
  private handleCodexConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const isLocal = this.isLocalRequest(req);
    let adapterId: string | undefined;
    ws.on('error', (err) => {
      logger.warn(`Codex adapter WebSocket error: ${err.message}`);
      ws.terminate();
    });
    ws.on('pong', () => this.codexAlive.set(ws, true));
    ws.on('message', (data) => {
      let msg: CodexLinkMessage;
      try {
        msg = JSON.parse(data.toString()) as CodexLinkMessage;
      } catch {
        logger.warn('Invalid message from Codex adapter');
        return;
      }
      if (msg.type === 'adapter_hello') {
        const a = msg.adapter;
        if (typeof a?.id !== 'string' || !a.id || typeof a.host !== 'string') return;
        if (adapterId && adapterId !== a.id) return;
        // An adapter that reconnects keeps its id while the hub may still hold the dead socket; the newest wins.
        const holder = this.codexAdapters.get(a.id);
        if (holder && holder.ws !== ws) holder.ws.terminate();
        if (!adapterId) logger.info(`Codex adapter connected: ${a.host} (${a.id}, local: ${isLocal})`);
        adapterId = a.id;
        this.codexAdapters.set(a.id, { ws, info: { id: a.id, host: a.host, ready: a.ready === true, isLocal } });
        this.broadcastCodexAdapters();
      }
    });
    ws.on('close', () => {
      if (!adapterId || this.codexAdapters.get(adapterId)?.ws !== ws) return;
      this.codexAdapters.delete(adapterId);
      logger.info(`Codex adapter disconnected: ${adapterId}`);
      this.broadcastCodexAdapters();
    });
  }

  private codexAdapterList(): CodexAdapterInfo[] {
    return [...this.codexAdapters.values()].map((a) => a.info);
  }

  private broadcastCodexAdapters(): void {
    this.broadcastToDashboards({ type: 'codex_adapters', adapters: this.codexAdapterList() });
  }
```

- [ ] **Step 5: 통과를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-codex.test.ts test/hub-permission-choices.test.ts test/hub-auth.test.ts`
Expected: PASS (기존 `permission_pending` 순서 테스트 포함)

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/shared/constants.ts src/shared/types.ts src/hub/server.ts test/hub-codex.test.ts
git commit -m "feat(hub): list Codex adapters that connect on /ws/codex"
```

---

### Task 3: Hub의 Codex 요청 — 폴더 목록·만들기·닫기

**Files:**
- Modify: `src/hub/server.ts` (필드, `handleCodexConnection`, `handleHttp` 라우팅 219-268, 새 메서드)
- Test: `test/hub-codex.test.ts` (추가)

**Interfaces:**
- Consumes: Task 2의 `codexAdapters`, `CodexCall`, `CodexLinkMessage`, `codexCallTimeoutMs`
- Produces:
  - `GET /api/codex/folders?adapterId=<id>` → 200 `{ folders: string[] }`(어댑터 `data` 그대로)
  - `POST /api/codex/threads` `{ adapterId, cwd }` → 200 `{ sessionId }`(어댑터 `data` 그대로)
  - `POST /api/codex/threads/close` `{ sessionId }` → 200 `{ ok: true }`, 채널 소켓에 `{ type: 'codex_close', sessionId }`
  - 실패: 400·404·422·502·504, 본문 `{ error }`(Global Constraints 문구)

- [ ] **Step 1: 실패하는 테스트를 더한다** — `test/hub-codex.test.ts` 끝에

```ts
const json = { 'Content-Type': 'application/json' };
const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${BASE}${path}`, { headers: auth });

function answer(link: { ws: WebSocket }, reply: (call: any) => object | undefined) {
  link.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type !== 'adapter_call') return;
    const body = reply(m.call);
    if (body) link.ws.send(JSON.stringify({ type: 'adapter_result', requestId: m.requestId, ...body }));
  });
}

test('creating a conversation is routed to the chosen adapter and answers with its session id', async () => {
  const link = await adapterLink('b1');
  await waitAdapter('b1');
  answer(link, () => ({ ok: true, data: { sessionId: 'codex:new-1' } }));
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b1', cwd: 'C:\\work' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sessionId: 'codex:new-1' });
    const call = link.inbox.find((m) => m.type === 'adapter_call');
    assert.deepEqual(call.call, { kind: 'create', cwd: 'C:\\work' });
    assert.equal(typeof call.requestId, 'string');
  } finally {
    link.ws.close();
  }
});

test('recent folders are fetched from the adapter', async () => {
  const link = await adapterLink('b2');
  await waitAdapter('b2');
  answer(link, (call) => (call.kind === 'folders' ? { ok: true, data: { folders: ['C:\\a', 'C:\\b'] } } : undefined));
  try {
    const res = await get('/api/codex/folders?adapterId=b2');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { folders: ['C:\\a', 'C:\\b'] });
  } finally {
    link.ws.close();
  }
});

test('an adapter error becomes 422 with the adapter message', async () => {
  const link = await adapterLink('b3');
  await waitAdapter('b3');
  answer(link, () => ({ ok: false, error: 'Folder not found on pc-1: C:\\nope' }));
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b3', cwd: 'C:\\nope' });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'Folder not found on pc-1: C:\\nope' });
  } finally {
    link.ws.close();
  }
});

test('unknown adapters get 404 and bad requests 400', async () => {
  const unknown = await post('/api/codex/threads', { adapterId: 'nope', cwd: 'C:\\x' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'Codex adapter is not connected' });
  assert.equal((await get('/api/codex/folders?adapterId=nope')).status, 404);
  const blank = await post('/api/codex/threads', { adapterId: 'b', cwd: '  ' });
  assert.equal(blank.status, 400);
  assert.deepEqual(await blank.json(), { error: 'adapterId and cwd are required' });
  assert.equal((await post('/api/codex/threads', { adapterId: 7, cwd: 'C:\\x' })).status, 400);
  const noId = await get('/api/codex/folders');
  assert.equal(noId.status, 400);
  assert.deepEqual(await noId.json(), { error: 'adapterId is required' });
});

test('a call times out with 504 and a late answer is ignored', async () => {
  const link = await adapterLink('b4');
  await waitAdapter('b4');
  try {
    const res = await post('/api/codex/threads', { adapterId: 'b4', cwd: 'C:\\x' });
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: 'Codex did not respond in time. The conversation may still appear.' });
    const late = link.inbox.find((m) => m.type === 'adapter_call');
    link.ws.send(JSON.stringify({ type: 'adapter_result', requestId: late.requestId, ok: true, data: { sessionId: 'late' } }));
    answer(link, (call) => (call.kind === 'folders' ? { ok: true, data: { folders: [] } } : undefined));
    const again = await get('/api/codex/folders?adapterId=b4');
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { folders: [] });
  } finally {
    link.ws.close();
  }
});

test('an adapter that disconnects during a call fails it with 502', async () => {
  const link = await adapterLink('b5');
  await waitAdapter('b5');
  link.ws.on('message', (d) => {
    if (JSON.parse(d.toString()).type === 'adapter_call') link.ws.terminate();
  });
  const res = await post('/api/codex/threads', { adapterId: 'b5', cwd: 'C:\\x' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Codex adapter disconnected' });
});

test('only the adapter that was asked can answer a call', async () => {
  const asked = await adapterLink('b6');
  const other = await adapterLink('b7');
  await waitAdapter('b6');
  await waitAdapter('b7');
  asked.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'adapter_call') other.ws.send(JSON.stringify({ type: 'adapter_result', requestId: m.requestId, ok: true, data: { folders: ['C:\\spoofed'] } }));
  });
  try {
    assert.equal((await get('/api/codex/folders?adapterId=b6')).status, 504);
  } finally {
    asked.ws.close();
    other.ws.close();
  }
});

async function fakeChannel(session: Record<string, unknown>) {
  const ch = await open('/ws/channel');
  ch.ws.send(JSON.stringify({ type: 'register', session: { name: 'x', status: 'idle', connectedAt: Date.now(), lastActivity: Date.now(), ...session } }));
  await until(async () => ((await (await get('/api/sessions')).json()) as any).sessions.some((s: any) => s.id === session.id));
  return ch;
}

test('close is forwarded to a closable Codex session and refused otherwise', async () => {
  const closable = await fakeChannel({ id: 'codex:c1', agentKind: 'codex', closable: true });
  const plain = await fakeChannel({ id: 'codex:c2', agentKind: 'codex' });
  const claude = await fakeChannel({ id: 'claude-c3', closable: true });
  try {
    const res = await post('/api/codex/threads/close', { sessionId: 'codex:c1' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const msg = await until(() => closable.inbox.find((m) => m.type === 'codex_close'));
    assert.deepEqual(msg, { type: 'codex_close', sessionId: 'codex:c1' });
    for (const sessionId of ['codex:c2', 'claude-c3', 'codex:none']) {
      const r = await post('/api/codex/threads/close', { sessionId });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'No closable Codex conversation' });
    }
    const bad = await post('/api/codex/threads/close', {});
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'sessionId is required' });
    assert.ok(!plain.inbox.some((m) => m.type === 'codex_close'));
    assert.ok(!claude.inbox.some((m) => m.type === 'codex_close'));
  } finally {
    closable.ws.close();
    plain.ws.close();
    claude.ws.close();
  }
});

test('the Codex routes need the hub token', async () => {
  assert.equal((await fetch(`${BASE}/api/codex/folders?adapterId=x`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/codex/threads`, { method: 'POST', headers: json, body: '{}' })).status, 401);
  assert.equal((await fetch(`${BASE}/api/codex/threads/close`, { method: 'POST', headers: json, body: '{}' })).status, 401);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-codex.test.ts`
Expected: FAIL — 새 경로가 `404 { error: 'Not found' }`라 status·본문 비교 실패.

- [ ] **Step 3: 구현한다** — `src/hub/server.ts`

타입 import에 `CodexCall`을 더한다. 모듈 수준(`validChoices` 아래):

```ts
type CodexCallOutcome = { status: number; body: unknown };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
```

필드(Task 2 필드 다음):

```ts
  private codexCalls = new Map<string, { adapterId: string; settle: (outcome: CodexCallOutcome) => void }>();
```

`handleCodexConnection`의 `message` 처리기에 `adapter_hello` 분기 다음 분기를 더한다:

```ts
      } else if (msg.type === 'adapter_result' && adapterId) {
        const call = this.codexCalls.get(msg.requestId);
        if (!call || call.adapterId !== adapterId) return;
        call.settle(msg.ok ? { status: 200, body: msg.data } : { status: 422, body: { error: String(msg.error) } });
      }
```

같은 메서드의 `close` 처리기에서 `this.codexAdapters.delete(adapterId);` 다음에:

```ts
      for (const call of [...this.codexCalls.values()]) {
        if (call.adapterId === adapterId) call.settle({ status: 502, body: { error: 'Codex adapter disconnected' } });
      }
```

`handleHttp` 라우팅 — `/api/notify` 분기 다음:

```ts
    } else if (url.pathname === '/api/codex/folders' && req.method === 'GET') {
      this.handleCodexFolders(url, res);
    } else if (url.pathname === '/api/codex/threads' && req.method === 'POST') {
      this.handleCodexCreate(req, res);
    } else if (url.pathname === '/api/codex/threads/close' && req.method === 'POST') {
      this.handleCodexClose(req, res);
```

새 메서드(`codexAdapterList` 앞):

```ts
  private callCodexAdapter(adapterId: string, call: CodexCall): Promise<CodexCallOutcome> {
    const adapter = this.codexAdapters.get(adapterId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ status: 404, body: { error: 'Codex adapter is not connected' } });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ status: 504, body: { error: 'Codex did not respond in time. The conversation may still appear.' } }),
        this.codexCallTimeoutMs,
      );
      const settle = (outcome: CodexCallOutcome) => {
        clearTimeout(timer);
        this.codexCalls.delete(requestId);
        resolve(outcome);
      };
      this.codexCalls.set(requestId, { adapterId, settle });
      adapter.ws.send(JSON.stringify({ type: 'adapter_call', requestId, call } satisfies CodexLinkMessage));
    });
  }

  private async handleCodexFolders(url: URL, res: http.ServerResponse): Promise<void> {
    const adapterId = url.searchParams.get('adapterId');
    if (!nonEmpty(adapterId)) {
      this.jsonResponse(res, 400, { error: 'adapterId is required' });
      return;
    }
    const out = await this.callCodexAdapter(adapterId, { kind: 'folders' });
    this.jsonResponse(res, out.status, out.body);
  }

  private async handleCodexCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as { adapterId?: unknown; cwd?: unknown } | null;
    const adapterId = body?.adapterId;
    const cwd = body?.cwd;
    if (!nonEmpty(adapterId) || !nonEmpty(cwd)) {
      this.jsonResponse(res, 400, { error: 'adapterId and cwd are required' });
      return;
    }
    const out = await this.callCodexAdapter(adapterId, { kind: 'create', cwd });
    this.jsonResponse(res, out.status, out.body);
  }

  private async handleCodexClose(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as { sessionId?: unknown } | null;
    const sessionId = body?.sessionId;
    if (!nonEmpty(sessionId)) {
      this.jsonResponse(res, 400, { error: 'sessionId is required' });
      return;
    }
    const session = this.sessions.get(sessionId);
    const ws = this.channelSockets.get(sessionId);
    if (session?.agentKind !== 'codex' || !session.closable || ws?.readyState !== WebSocket.OPEN) {
      this.jsonResponse(res, 404, { error: 'No closable Codex conversation' });
      return;
    }
    ws.send(JSON.stringify({ type: 'codex_close', sessionId } satisfies ChannelMessage));
    this.jsonResponse(res, 200, { ok: true });
  }
```

`settle`이 `timer`보다 아래에 선언되지만 `timer` 콜백은 비동기로만 불리므로 TDZ 문제가 없다. 순서를 바꾸지 말 것(`settle`이 `timer`를 쓴다).

- [ ] **Step 4: 통과를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-codex.test.ts test/hub-auth.test.ts test/hub-ownership.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/hub/server.ts test/hub-codex.test.ts
git commit -m "feat(hub): route Codex folder, create and close requests to adapters"
```

---

### Task 4: 어댑터 쪽 Hub 연결 `CodexHubLink`

**Files:**
- Create: `src/codex/hub-link.ts`
- Test: `test/codex-hub-link.test.ts` (생성, 포트 7981)

**Interfaces:**
- Consumes: Task 2·3의 `/ws/codex` 프로토콜, `CodexCall`, `CodexLinkMessage`
- Produces:
  - `class CodexHubLink { constructor(hub: { host: string; port: number; token?: string }, identity: { id: string; host: string }, onCall: (call: CodexCall) => Promise<unknown>, reconnectMs?: number /* 5000 */); connect(): void; setReady(ready: boolean): void; disconnect(): void }`
  - `onCall`이 resolve하면 `ok: true, data`, reject하면 `ok: false, error: err.message`

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `test/codex-hub-link.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexHubLink } from '../src/codex/hub-link.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7981;
const TOKEN = 'codex-link-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
const BASE = `http://127.0.0.1:${PORT}`;
const newHub = () => new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
let hub: HubServer;

before(async () => {
  hub = newHub();
  await hub.start();
});
after(async () => { await hub.stop(); });

async function adapters(): Promise<any[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
  try {
    return await new Promise((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'codex_adapters') resolve(m.adapters);
      });
      ws.on('error', reject);
    });
  } finally {
    ws.close();
  }
}

const listed = (pred: (a: any) => boolean) => until(async () => (await adapters()).find(pred));
const absent = (id: string) => until(async () => !(await adapters()).some((a) => a.id === id));

test('the link says hello, follows ready changes and answers calls through the hub', async () => {
  const link = new CodexHubLink(HUB, { id: 'L1', host: 'pc-x' }, async (call) => {
    if (call.kind === 'folders') return { folders: ['C:\\p'] };
    throw new Error(`Folder not found on pc-x: ${call.cwd}`);
  }, 50);
  link.connect();
  try {
    await listed((a) => a.id === 'L1' && a.host === 'pc-x' && a.ready === false);
    link.setReady(true);
    await listed((a) => a.id === 'L1' && a.ready === true);
    const ok = await fetch(`${BASE}/api/codex/folders?adapterId=L1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { folders: ['C:\\p'] });
    const bad = await fetch(`${BASE}/api/codex/threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapterId: 'L1', cwd: 'C:\\nope' }),
    });
    assert.equal(bad.status, 422);
    assert.deepEqual(await bad.json(), { error: 'Folder not found on pc-x: C:\\nope' });
  } finally {
    link.disconnect();
  }
  await absent('L1');
});

test('the link reconnects to a restarted hub and says hello again', async () => {
  const link = new CodexHubLink(HUB, { id: 'L2', host: 'pc-y' }, async () => ({}), 50);
  link.connect();
  link.setReady(true);
  try {
    await listed((a) => a.id === 'L2' && a.ready === true);
    await hub.stop();
    hub = newHub();
    await hub.start();
    await listed((a) => a.id === 'L2' && a.ready === true);
  } finally {
    link.disconnect();
  }
  await absent('L2');
});

test('a disconnected link stays away', async () => {
  const link = new CodexHubLink(HUB, { id: 'L3', host: 'pc-z' }, async () => ({}), 50);
  link.connect();
  await listed((a) => a.id === 'L3');
  link.disconnect();
  await absent('L3');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await adapters()).some((a) => a.id === 'L3'));
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-hub-link.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/hub-link.js'`

- [ ] **Step 3: 구현한다** — `src/codex/hub-link.ts`

```ts
import WebSocket from 'ws';
import { WS_PATH_CODEX } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { CodexCall, CodexLinkMessage } from '../shared/types.js';

export class CodexHubLink {
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private ready = false;

  constructor(
    private hub: { host: string; port: number; token?: string },
    private identity: { id: string; host: string },
    private onCall: (call: CodexCall) => Promise<unknown>,
    private reconnectMs = 5000,
  ) {}

  connect(): void {
    this.closed = false;
    const query = this.hub.token ? `?token=${encodeURIComponent(this.hub.token)}` : '';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.hub.host}:${this.hub.port}${WS_PATH_CODEX}${query}`);
    } catch (err) {
      logger.debug(`Codex hub link failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws === ws) this.hello();
    });
    ws.on('message', (data) => {
      if (this.ws === ws) this.onMessage(String(data));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on('error', (err) => logger.debug(`Codex hub link error: ${err.message}`));
  }

  setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.hello();
  }

  disconnect(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private hello(): void {
    this.send({ type: 'adapter_hello', adapter: { ...this.identity, ready: this.ready } });
  }

  private send(msg: CodexLinkMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string): void {
    let msg: CodexLinkMessage;
    try {
      msg = JSON.parse(text) as CodexLinkMessage;
    } catch {
      return;
    }
    if (msg.type !== 'adapter_call') return;
    const { requestId, call } = msg;
    this.onCall(call).then(
      (data) => this.send({ type: 'adapter_result', requestId, ok: true, data }),
      (err) => this.send({ type: 'adapter_result', requestId, ok: false, error: (err as Error).message }),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.reconnectMs);
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-hub-link.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/hub-link.ts test/codex-hub-link.test.ts
git commit -m "feat(codex): add the adapter's own hub link on /ws/codex"
```

---

### Task 5: 어댑터 — ready, 폴더 목록, 대화 만들기

**Files:**
- Modify: `src/codex/rpc.ts:13-47`
- Modify: `src/codex/mapping.ts` (함수 추가)
- Modify: `src/codex/adapter.ts` (imports 1-19, `CodexAdapterOptions` 21-29, 필드 56-68, `start`/`stop` 70-81, `connect` 83-118, `onDaemonLost` 120-127, `want` 225-231, `registration` 218-223, 새 메서드)
- Modify: `test/helpers/fake-codex-daemon.ts:68-86`
- Test: `test/codex-rpc.test.ts`, `test/codex-mapping.test.ts` (추가), `test/codex-new-thread.test.ts` (생성, 포트 7982)

**Interfaces:**
- Consumes: Task 4 `CodexHubLink`, Task 2 `CodexCall`, Task 3 Hub 경로
- Produces:
  - `RpcClient.request<T>(method: string, params?: unknown, timeoutMs: number | null = this.timeoutMs): Promise<T>` — `null`이면 시간 제한 없음
  - `cleanFolder(input: string): string` (`src/codex/mapping.ts`)
  - `CodexAdapterOptions` += `hostName?: string`(기본 `os.hostname()`), `linkReconnectMs?: number`, `rpcTimeoutMs?: number`
  - `CodexAdapter`의 private: `pins: Set<string>`, `ready: boolean`, `setReady(ready)`, `requireDaemon(): RpcClient`, `onCall(call)`, `folders()`, `create(cwd)` — Task 6이 `pins`·`want`·`registration`을 그대로 쓴다
  - 등록 정보에 `closable: pins.has(threadId)`

- [ ] **Step 1: 실패하는 단위 테스트를 더한다**

`test/codex-rpc.test.ts` 끝:

```ts
test('a request with no timeout waits for its answer', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any, 20);
  const pending = rpc.request('thread/start', { cwd: 'C:\\w' }, null);
  await new Promise((r) => setTimeout(r, 60));
  ws.emit('message', JSON.stringify({ id: 1, result: { thread: { id: 't' } } }));
  assert.deepEqual(await pending, { thread: { id: 't' } });
});
```

`test/codex-mapping.test.ts` — import에 `cleanFolder`를 더하고 끝에:

```ts
test('pasted folders lose surrounding spaces and one pair of double quotes', () => {
  assert.equal(cleanFolder('  "C:\\work\\새 프로젝트"  '), 'C:\\work\\새 프로젝트');
  assert.equal(cleanFolder('C:\\work'), 'C:\\work');
  assert.equal(cleanFolder('"'), '"');
  assert.equal(cleanFolder('""'), '');
});
```

- [ ] **Step 2: FakeDaemon이 Promise 처리기를 받게 한다** — `test/helpers/fake-codex-daemon.ts`의 `onMessage` 마지막 `try` 블록을 바꾼다

```ts
    try {
      const result = handler(m.params);
      if (result instanceof Promise) {
        result.then(
          (value) => reply({ result: value }),
          (err) => reply({ error: { code: -32600, message: (err as Error).message } }),
        );
        return;
      }
      reply({ result });
    } catch (err) {
      reply({ error: { code: -32600, message: (err as Error).message } });
    }
```

- [ ] **Step 3: 실패하는 어댑터 테스트를 쓴다** — `test/codex-new-thread.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7982;
const TOKEN = 'codex-new-thread-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm 새 대화-'));
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;
let hostCount = 0;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => {
  await hub.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
});
afterEach(async () => {
  adapter?.stop();
  adapter = undefined;
  await daemon?.stop();
  daemon = undefined;
  await until(async () => !(await sessions()).some((s) => s.id.startsWith('codex:')));
});

function thread(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Thread ${id}`, preview: '', cwd: 'C:\\w\\proj', status: { type: 'idle' }, parentThreadId: null, ephemeral: false, ...extra };
}
const created = (id: string, cwd: string) => thread(id, { name: null, cwd });

async function sessions(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}
const session = (id: string, pred: (s: any) => boolean = () => true) => until(async () => (await sessions()).find((s) => s.id === id && pred(s)));
const gone = (id: string) => until(async () => !(await sessions()).some((s) => s.id === id));
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (p: string) => fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

function openDashboard(): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

async function adapterInfo(host: string, ready: boolean): Promise<any> {
  const dash = await openDashboard();
  try {
    return await until(() => dash.inbox.filter((m) => m.type === 'codex_adapters').at(-1)?.adapters.find((a: any) => a.host === host && a.ready === ready));
  } finally {
    dash.ws.close();
  }
}

interface Started { d: FakeDaemon; threads: any[]; host: string; adapterId: string }

async function startAdapter(
  threads: any[],
  setup?: (d: FakeDaemon, threads: any[]) => void,
  opts: { idleReleaseMs?: number; rpcTimeoutMs?: number; waitReady?: boolean } = {},
): Promise<Started> {
  const d = new FakeDaemon();
  daemon = d;
  await d.start();
  d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
  d.handle('thread/read', (p) => {
    const t = threads.find((x) => x.id === p.threadId);
    if (!t) throw new Error('thread not found');
    return { thread: t };
  });
  d.handle('thread/resume', () => ({}));
  d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('thread/list', () => ({ data: threads, nextCursor: null }));
  let n = 0;
  d.handle('thread/start', (p) => {
    const t = created(`n${++n}`, p.cwd);
    threads.push(t);
    return { thread: t };
  });
  setup?.(d, threads);
  const host = `pc-${++hostCount}`;
  adapter = new CodexAdapter({
    command: 'codex',
    hub: HUB,
    spawnFn: d.spawnFn,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    linkReconnectMs: 50,
    hostName: host,
    idleReleaseMs: opts.idleReleaseMs,
    rpcTimeoutMs: opts.rpcTimeoutMs,
  });
  adapter.start();
  const info = await adapterInfo(host, opts.waitReady !== false);
  return { d, threads, host, adapterId: info.id };
}

const create = (s: Started, cwd: string = WORK) => post('/api/codex/threads', { adapterId: s.adapterId, cwd });

test('the adapter is ready only after discovery and refuses to create before that', async () => {
  let release!: () => void;
  const listed = new Promise<void>((r) => { release = r; });
  const s = await startAdapter([thread('t1')], (dm, threads) =>
    dm.handle('thread/loaded/list', () => listed.then(() => ({ data: threads.map((t) => t.id), nextCursor: null }))),
  { waitReady: false });
  await until(() => s.d.calls('thread/loaded/list').length === 1);
  const res = await create(s);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: `Codex is not connected on ${s.host}.` });
  assert.equal(s.d.calls('thread/start').length, 0);
  release();
  await adapterInfo(s.host, true);
});

test('recent folders come from the Codex history, newest first, without duplicates, at most ten', async () => {
  const cwds = ['C:\\a', 'C:\\b', 'C:\\a', ...Array.from({ length: 10 }, (_, i) => `C:\\f${i}`)];
  const history = cwds.map((cwd, i) => thread(`h${i}`, { cwd }));
  const s = await startAdapter([], (dm) => dm.handle('thread/list', () => ({ data: history, nextCursor: null })));
  const res = await get(`/api/codex/folders?adapterId=${s.adapterId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { folders: ['C:\\a', 'C:\\b', 'C:\\f0', 'C:\\f1', 'C:\\f2', 'C:\\f3', 'C:\\f4', 'C:\\f5', 'C:\\f6', 'C:\\f7'] });
  assert.deepEqual(s.d.calls('thread/list')[0].params, { limit: 50, sortKey: 'updated_at' });
});

test('creating starts a full-access conversation in the cleaned folder and shows it as closable', async () => {
  const s = await startAdapter([]);
  const res = await create(s, `  "${WORK}" `);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sessionId: 'codex:n1' });
  assert.deepEqual(s.d.calls('thread/start')[0].params, { cwd: WORK, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const sess = await session('codex:n1', (x) => x.closable === true);
  assert.equal(sess.agentKind, 'codex');
  assert.equal(sess.displayName, path.basename(WORK));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a created conversation stays subscribed through its turns', async () => {
  const s = await startAdapter([], undefined, { idleReleaseMs: 50 });
  await create(s);
  await session('codex:n1');
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'active', activeFlags: [] } });
  await session('codex:n1', (x) => x.status === 'working');
  s.d.notify('turn/completed', { threadId: 'n1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'idle' } });
  await session('codex:n1', (x) => x.status === 'idle');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.d.calls('thread/unsubscribe').length, 0);
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a thread/started broadcast that beats the answer still ends up closable', async () => {
  const s = await startAdapter([], (dm, threads) => dm.handle('thread/start', (p) => {
    const t = created('n9', p.cwd);
    threads.push(t);
    dm.notify('thread/started', { thread: t });
    return { thread: t };
  }));
  assert.equal((await create(s)).status, 200);
  await session('codex:n9', (x) => x.closable === true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/resume').length, 0);
});

test('a slow thread/start is not cut off by the RPC timeout', async () => {
  const s = await startAdapter([], (dm, threads) => dm.handle('thread/start', (p) => new Promise((resolve) => setTimeout(() => {
    const t = created('n7', p.cwd);
    threads.push(t);
    resolve({ thread: t });
  }, 300))), { rpcTimeoutMs: 100 });
  const res = await create(s);
  assert.equal(res.status, 200);
  await session('codex:n7', (x) => x.closable === true);
});

test('relative paths, missing folders and files are refused before Codex is asked', async () => {
  const s = await startAdapter([]);
  const file = path.join(WORK, 'note.txt');
  fs.writeFileSync(file, 'x');
  for (const cwd of ['relative\\dir', path.join(WORK, 'missing'), file]) {
    const res = await create(s, cwd);
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: `Folder not found on ${s.host}: ${cwd}` });
  }
  assert.equal(s.d.calls('thread/start').length, 0);
});

test('a thread/start that Codex rejects is reported', async () => {
  const s = await startAdapter([], (dm) => dm.handle('thread/start', () => {
    throw new Error('model not available');
  }));
  const res = await create(s);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'Codex could not start the conversation: model not available' });
});
```

- [ ] **Step 4: 실패를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-rpc.test.ts test/codex-mapping.test.ts test/codex-new-thread.test.ts`
Expected: FAIL — `cleanFolder` import 실패(SyntaxError: does not provide an export), 시간 제한 없는 요청이 `timed out`으로 거부, 어댑터가 `/ws/codex`에 붙지 않아 `adapterInfo`가 `condition not met in time`.

- [ ] **Step 5: `RpcClient`에 요청별 시간 제한을 더한다** — `src/codex/rpc.ts`

`Pending.timer`를 `timer?: ReturnType<typeof setTimeout>;`로 바꾸고 `request`를:

```ts
  request<T = any>(method: string, params?: unknown, timeoutMs: number | null = this.timeoutMs): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }
```

- [ ] **Step 6: `cleanFolder`를 더한다** — `src/codex/mapping.ts` 끝

```ts
// Explorer's "Copy as path" wraps the path in double quotes.
export function cleanFolder(input: string): string {
  const s = input.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;
}
```

- [ ] **Step 7: 어댑터를 구현한다** — `src/codex/adapter.ts`

imports 맨 위에 더한다:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexHubLink } from './hub-link.js';
```

`import type { ChannelMessage, NotifyLevel, SessionInfo } from '../shared/types.js';`를 `import type { ChannelMessage, CodexCall, NotifyLevel, SessionInfo } from '../shared/types.js';`로, mapping import 목록에 `cleanFolder,`를 더한다.

`CodexAdapterOptions`에 더한다:

```ts
  hostName?: string;
  linkReconnectMs?: number;
  rpcTimeoutMs?: number;
```

필드(`private notFoundNotice …` 다음)와 constructor:

```ts
  private pins = new Set<string>();
  private ready = false;
  private readonly hostName: string;
  private readonly link: CodexHubLink;

  constructor(private opts: CodexAdapterOptions) {
    this.delay = opts.reconnectMinMs ?? 2000;
    this.hostName = opts.hostName ?? os.hostname();
    this.link = new CodexHubLink(opts.hub, { id: randomUUID(), host: this.hostName }, (call) => this.onCall(call), opts.linkReconnectMs);
  }
```

`start()`:

```ts
  start(): void {
    this.stopped = false;
    this.link.connect();
    void this.connect();
  }
```

`stop()`의 첫 줄 `this.stopped = true;` 다음에 `this.link.disconnect();`.

`connect()`: `const live = new RpcClient(conn.ws);`를 `const live = new RpcClient(conn.ws, this.opts.rpcTimeoutMs);`로. `await this.discover();` 다음 줄에:

```ts
      if (this.rpc === live) this.setReady(true);
```

`catch (err) {` 블록 첫 줄에 `this.setReady(false);`. `onDaemonLost()` 첫 줄에 `this.setReady(false);`.

`registration()`의 반환:

```ts
    return { name: title, title, cwd: t.thread.cwd, agentKind: 'codex', status: hubStatus(t.thread.status), closable: this.pins.has(threadId) };
```

`want()`의 `t.wantSubscribed = subscribed;`를:

```ts
    t.wantSubscribed = subscribed || this.pins.has(threadId);
```

새 메서드(`noticeNotFound` 다음):

```ts
  private setReady(ready: boolean): void {
    this.ready = ready;
    this.link.setReady(ready);
  }

  private requireDaemon(): RpcClient {
    if (!this.ready || !this.rpc) throw new Error(`Codex is not connected on ${this.hostName}.`);
    return this.rpc;
  }

  private async onCall(call: CodexCall): Promise<unknown> {
    if (call.kind === 'folders') return { folders: await this.folders() };
    return { sessionId: await this.create(call.cwd) };
  }

  private async folders(): Promise<string[]> {
    const page = await this.requireDaemon().request<{ data: CodexThread[] }>('thread/list', { limit: 50, sortKey: 'updated_at' });
    return [...new Set(page.data.map((t) => t.cwd).filter(Boolean))].slice(0, 10);
  }

  private async create(input: string): Promise<string> {
    const rpc = this.requireDaemon();
    const cwd = cleanFolder(input);
    const isDir = path.isAbsolute(cwd) && (await fs.promises.stat(cwd).then((s) => s.isDirectory(), () => false));
    if (!isDir) throw new Error(`Folder not found on ${this.hostName}: ${cwd}`);
    let thread: CodexThread;
    try {
      // No RPC timeout: an answer dropped after a timeout would leave a conversation this connection holds but never pins.
      ({ thread } = await rpc.request<{ thread: CodexThread }>('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' }, null));
    } catch (err) {
      throw new Error(`Codex could not start the conversation: ${(err as Error).message}`);
    }
    this.pins.add(thread.id);
    this.upsert(thread);
    const t = this.threads.get(thread.id);
    if (!t) {
      this.pins.delete(thread.id);
      throw new Error('Codex started a conversation claude-alarm cannot follow.');
    }
    // The starting connection is already subscribed; marking it before upsert's queued sync runs avoids a resume that fails before the first turn.
    t.subscribed = true;
    return codexSessionId(thread.id);
  }
```

`folders()`의 `requireDaemon()` 오류는 그대로 거부되어 Hub에서 422가 된다.

- [ ] **Step 8: 통과를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-rpc.test.ts test/codex-mapping.test.ts test/codex-new-thread.test.ts test/codex-adapter.test.ts`
Expected: PASS (기존 어댑터 테스트 회귀 없음 — 단, `codex-adapter.test.ts`는 포트 7994라 6c와 동시에 돌리지 않는다)

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 9: 커밋**

```bash
git add src/codex/rpc.ts src/codex/mapping.ts src/codex/adapter.ts test/helpers/fake-codex-daemon.ts test/codex-rpc.test.ts test/codex-mapping.test.ts test/codex-new-thread.test.ts
git commit -m "feat(codex): create pinned full-access conversations and list recent folders for the dashboard"
```

---

### Task 6: 어댑터 — 닫기, 고정 해제, discover 정리, 제목 다시 읽기

**Files:**
- Modify: `src/codex/adapter.ts` (`discover` 163-175, `onNotification` 274-309, `onStatus` 311-335, `onTurnCompleted` 345-370, `onHubMessage` 372-380, 새 메서드)
- Test: `test/codex-new-thread.test.ts` (추가)

**Interfaces:**
- Consumes: Task 5의 `pins`, `want`, `registration`, `subscribed`/`wantSubscribed`/`pendingTurn`, Task 3의 `codex_close`
- Produces: `codex_close` 처리, `busy(t)`, `close(threadId)`

- [ ] **Step 1: 실패하는 테스트를 더한다** — `test/codex-new-thread.test.ts` 끝

```ts
const closeSession = (id: string) => post('/api/codex/threads/close', { sessionId: id });

test('closing an idle created conversation releases it and removes the session', async () => {
  const s = await startAdapter([]);
  await create(s);
  await session('codex:n1', (x) => x.closable);
  assert.equal((await closeSession('codex:n1')).status, 200);
  await gone('codex:n1');
  assert.deepEqual(s.d.calls('thread/unsubscribe').map((c) => c.params), [{ threadId: 'n1' }]);
});

test('closing while Codex works keeps the session until the turn ends', async () => {
  const s = await startAdapter([], undefined, { idleReleaseMs: 50 });
  await create(s);
  await session('codex:n1', (x) => x.closable);
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'active', activeFlags: [] } });
  await session('codex:n1', (x) => x.status === 'working');
  assert.equal((await closeSession('codex:n1')).status, 200);
  await session('codex:n1', (x) => x.closable === false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/unsubscribe').length, 0);
  s.d.notify('turn/completed', { threadId: 'n1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
  s.d.notify('thread/status/changed', { threadId: 'n1', status: { type: 'idle' } });
  await until(() => s.d.calls('thread/unsubscribe').length === 1);
  assert.ok((await sessions()).some((x) => x.id === 'codex:n1'));
  s.d.notify('thread/closed', { threadId: 'n1' });
  await gone('codex:n1');
});

test('a message that arrives while closing keeps the conversation and relays its reply', async () => {
  let release!: () => void;
  const unsubscribed = new Promise<void>((r) => { release = r; });
  const s = await startAdapter([], (dm) => dm.handle('thread/unsubscribe', () => unsubscribed.then(() => ({ status: 'unsubscribed' }))));
  await create(s);
  await session('codex:n1', (x) => x.closable);
  const dash = await openDashboard();
  try {
    await closeSession('codex:n1');
    await until(() => s.d.calls('thread/unsubscribe').length === 1);
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:n1', content: 'one more thing' }));
    await new Promise((r) => setTimeout(r, 150));
    release();
    await until(() => s.d.calls('turn/start').length === 1);
    s.d.notify('item/completed', { threadId: 'n1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'Handled', phase: 'final_answer' } });
    s.d.notify('turn/completed', { threadId: 'n1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:n1'));
    assert.equal(reply.content, 'Handled');
    assert.ok((await sessions()).some((x) => x.id === 'codex:n1' && x.closable === false));
  } finally {
    dash.ws.close();
  }
});

test('a failed release keeps the conversation closable and says so', async () => {
  const s = await startAdapter([], (dm) => dm.handle('thread/unsubscribe', () => {
    throw new Error('busy');
  }));
  await create(s);
  await session('codex:n1', (x) => x.closable);
  const dash = await openDashboard();
  try {
    await closeSession('codex:n1');
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:n1'));
    assert.equal(n.title, 'Not closed');
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex did not release the conversation. Try closing it again.');
    await session('codex:n1', (x) => x.closable === true);
  } finally {
    dash.ws.close();
  }
});

test('archived, deleted and closed conversations lose their pin', async () => {
  const s = await startAdapter([]);
  for (const [i, method] of ['thread/archived', 'thread/deleted', 'thread/closed'].entries()) {
    const id = `n${i + 1}`;
    await create(s);
    await session(`codex:${id}`, (x) => x.closable);
    s.d.notify(method, { threadId: id });
    await gone(`codex:${id}`);
    s.d.notify('thread/started', { thread: s.threads.find((t) => t.id === id) });
    await session(`codex:${id}`, (x) => x.closable === false);
  }
});

test('pins survive a daemon reconnect and are subscribed again', async () => {
  const s = await startAdapter([]);
  await create(s);
  await session('codex:n1', (x) => x.closable);
  s.d.dropClient();
  await gone('codex:n1');
  await until(() => s.d.connections === 2, 5000);
  await session('codex:n1', (x) => x.closable === true);
  await until(() => s.d.calls('thread/resume').some((c) => c.params.threadId === 'n1'));
});

test('pins of conversations no longer loaded are forgotten after a reconnect', async () => {
  const s = await startAdapter([]);
  await create(s);
  await session('codex:n1', (x) => x.closable);
  const t = s.threads.pop();
  s.d.dropClient();
  await gone('codex:n1');
  await until(() => s.d.connections === 2, 5000);
  await adapterInfo(s.host, true);
  s.threads.push(t);
  s.d.notify('thread/started', { thread: t });
  await session('codex:n1', (x) => x.closable === false);
});

test('a discovery cut off by a lost connection does not forget pins', async () => {
  let phase = 0;
  let cut!: () => void;
  const s = await startAdapter([], (dm, threads) => {
    dm.handle('thread/loaded/list', () => ({ data: phase === 1 ? ['x'] : threads.map((t) => t.id), nextCursor: null }));
    dm.handle('thread/read', (p) => {
      if (p.threadId === 'x') return new Promise(() => cut());
      const t = threads.find((x) => x.id === p.threadId);
      if (!t) throw new Error('thread not found');
      return { thread: t };
    });
  });
  await create(s);
  await session('codex:n1', (x) => x.closable);
  const cutOff = new Promise<void>((r) => { cut = r; });
  phase = 1;
  s.d.dropClient();
  await cutOff;
  phase = 2;
  s.d.dropClient();
  await until(() => s.d.connections === 3, 5000);
  await session('codex:n1', (x) => x.closable === true);
});

test('a conversation without a name or preview is re-read after its turn for a better title', async () => {
  const s = await startAdapter([thread('t5', { name: null, preview: '' })]);
  await session('codex:t5', (x) => x.displayName === 'proj');
  s.threads[0].preview = 'Fix the login bug';
  s.d.notify('turn/completed', { threadId: 't5', turn: { id: 'u1', status: 'completed', items: [], error: null } });
  await session('codex:t5', (x) => x.displayName === 'Fix the login bug');
});

test('a named conversation is not re-read after its turn', async () => {
  const s = await startAdapter([thread('t6')]);
  await session('codex:t6');
  const reads = s.d.calls('thread/read').length;
  s.d.notify('turn/completed', { threadId: 't6', turn: { id: 'u1', status: 'completed', items: [], error: null } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/read').length, reads);
});

test('a close for a conversation not created here is ignored', async () => {
  const s = await startAdapter([thread('t1')]);
  await session('codex:t1');
  assert.equal((await closeSession('codex:t1')).status, 404);
  (adapter as any).onHubMessage('t1', { type: 'codex_close', sessionId: 'codex:t1' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.d.calls('thread/unsubscribe').length, 0);
  assert.ok((await sessions()).some((x) => x.id === 'codex:t1'));
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-new-thread.test.ts`
Expected: FAIL — 닫기 요청은 200이지만 어댑터가 `codex_close`를 처리하지 않아 `gone`/`closable === false`가 `condition not met in time`, 제목 테스트도 시간 초과.

- [ ] **Step 3: 구현한다** — `src/codex/adapter.ts`

`discover()`를 바꾼다:

```ts
  private async discover(): Promise<void> {
    const rpc = this.rpc!;
    const pinned = [...this.pins];
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await rpc.request<{ data: string[]; nextCursor?: string | null }>('thread/loaded/list', cursor ? { cursor } : {});
      ids.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) await this.refresh(id);
    // A list read on a connection that has since been replaced says nothing about what the daemon holds now.
    if (this.rpc !== rpc) return;
    for (const id of pinned) if (!ids.includes(id)) this.pins.delete(id);
  }
```

`onNotification`의 닫힘 분기:

```ts
      case 'thread/closed':
      case 'thread/archived':
      case 'thread/deleted':
        this.pins.delete(params.threadId);
        this.drop(params.threadId);
        break;
```

`onStatus`의 `if (status.type === 'notLoaded') {` 블록에서 `this.drop(threadId);` 앞에 `this.pins.delete(threadId);`.

`onTurnCompleted`의 `t.files.clear();` 다음:

```ts
    // The daemon announces name changes but not preview changes, so a title taken from the folder is re-read once text exists.
    if (!t.thread.name?.trim() && !t.thread.preview?.trim()) void this.refresh(threadId);
```

`onHubMessage`에 분기를 더한다(`permission_response` 분기 다음):

```ts
    } else if (msg.type === 'codex_close') {
      void this.close(threadId);
    }
```

새 메서드(`drop` 다음):

```ts
  private busy(t: Tracked): boolean {
    return t.thread.status.type === 'active' || t.pendingTurn;
  }

  private async close(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t || !this.pins.delete(threadId)) return;
    t.hub.reregister();
    if (this.busy(t)) return;
    // drop() before the unsubscribe finishes would skip it: syncSubscription stops once the thread is untracked.
    await this.want(threadId, false);
    // A message or an active broadcast may arrive while unsubscribing; the conversation then ends like a close during work.
    if (this.threads.get(threadId) !== t || this.busy(t) || t.wantSubscribed) return;
    if (!t.subscribed) {
      this.drop(threadId);
      return;
    }
    // syncSubscription swallows unsubscribe errors, so a still-set flag is the only sign it failed.
    this.pins.add(threadId);
    t.hub.reregister();
    void this.want(threadId, true);
    this.notify(threadId, 'Not closed', 'Codex did not release the conversation. Try closing it again.', 'warning');
  }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-new-thread.test.ts test/codex-adapter.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/adapter.ts test/codex-new-thread.test.ts
git commit -m "feat(codex): close dashboard-created conversations and keep pins across reconnects"
```

---

### Task 7: 대시보드 — "+" 팝업의 새 Codex 대화, 닫기 버튼, README (visual: 디자인은 Codex 몫)

**Files:**
- Modify: `src/dashboard/index.html` (CSS 112-145 근처, 마크업 1007-1018 `#cmdPopup`, `state` 1058-1069, `handleMessage` 1386-1477, `renderSessions` 1480-1504, `bindSessionCards` 1506-1531, `selectSession` 1623-1640, `// --- Add session popup ---` 2188-2210)
- Modify: `README.md` (174-195 Codex Sessions, 218 Remote Access)
- Test: `test/dashboard-codex.test.ts` (생성)

**Interfaces:**
- Consumes: Task 2 `codex_adapters`, Task 3 HTTP 경로, Task 5·6의 `closable`
- Produces: 대시보드 스크립트 블록 `  // --- Codex helpers ---`(순수 함수 `usableAdapters`, `adapterLabels`, `closeStep`) — 바로 다음 블록 표지는 `  // --- Add session popup ---`

**디자인 범위:** 아래 마크업·스크립트는 동작에 필요한 최소한이다. 모양(배치, 색, 간격, 글꼴 크기, 아이콘, 닫기 버튼 위치·크기, 폰 폭 대응)은 구현자가 정한다. 제약:
- id(`codexSection`, `codexAdapter`, `codexFolder`, `codexFolders`, `codexCreate`, `codexError`)와 클래스 `session-close`, `hidden` 속성 토글, 이벤트 연결은 유지한다. 마크업을 감싸거나 재배치하는 것은 자유
- `hidden` 속성이 붙은 요소는 보이면 안 된다. 그 요소에 `display`를 주면 `[hidden] { display: none }` 규칙도 함께 둔다
- 기존 CSS 변수(`--surface`, `--border`, `--text`, `--text-dim`, `--accent`, `--red` 등)만 써서 다크·라이트 테마 모두에서 읽히게 한다
- 360px 폭 폰에서 팝업이 가로 스크롤 없이 쓰이고, 닫기 버튼은 손가락으로 누를 수 있는 크기(최소 28px)
- 닫기 버튼이 세션 카드의 이름·상태 배치를 밀어내지 않는다. 닫기 버튼은 세션 카드 안에 둔다(메시지 헤더는 `textContent`로 매번 다시 써져서 버튼을 둘 수 없다)
- 화면 문구는 Global Constraints의 영어 문구 그대로

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `test/dashboard-codex.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate the Codex helper block in a sandbox.
function loadCodexHelpers() {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  // --- Codex helpers ---');
  const end = html.indexOf('  // --- Add session popup ---');
  assert.ok(start > 0 && end > start, 'Codex helper anchors not found');
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx as any;
}

test('only ready adapters are offered, the hub PC first', () => {
  const { usableAdapters } = loadCodexHelpers();
  const list = usableAdapters([
    { id: 'b', host: 'laptop', ready: true, isLocal: false },
    { id: 'c', host: 'old', ready: false, isLocal: true },
    { id: 'a', host: 'desk', ready: true, isLocal: true },
  ]);
  assert.deepEqual(Array.from(list, (x: any) => x.id), ['a', 'b']);
  assert.equal(usableAdapters([{ id: 'c', host: 'old', ready: false, isLocal: true }]).length, 0);
});

test('adapters on PCs with the same name are told apart by their id', () => {
  const { adapterLabels } = loadCodexHelpers();
  const labels = adapterLabels([
    { id: 'abcd1234', host: 'pc' },
    { id: 'ef567890', host: 'pc' },
    { id: 'z9', host: 'other' },
  ]);
  assert.deepEqual(Array.from(labels), ['pc (abcd)', 'pc (ef56)', 'other']);
});

test('closing takes a second click between 0.4 and 3 seconds after the first', () => {
  const { closeStep } = loadCodexHelpers();
  assert.equal(closeStep(null, 1000), 'arm');
  assert.equal(closeStep(1000, 1200), 'wait');
  assert.equal(closeStep(1000, 1400), 'close');
  assert.equal(closeStep(1000, 3999), 'close');
  assert.equal(closeStep(1000, 4000), 'arm');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --import tsx --test test/dashboard-codex.test.ts`
Expected: FAIL — `Codex helper anchors not found`

- [ ] **Step 3: 마크업을 더한다** — `#cmdPopup` 안, `#cmdCopy2` 블록 다음(팝업 닫는 `</div>` 앞)

```html
      <div class="codex-section" id="codexSection" hidden>
        <div class="cmd-popup-title">New Codex conversation:</div>
        <select id="codexAdapter" hidden></select>
        <input id="codexFolder" list="codexFolders" placeholder="Folder on that PC, e.g. C:\work\project" autocomplete="off" spellcheck="false">
        <datalist id="codexFolders"></datalist>
        <div class="codex-warning">Runs with full access: no approval prompts.</div>
        <button id="codexCreate" type="button">Create</button>
        <div class="codex-error" id="codexError" hidden></div>
      </div>
```

- [ ] **Step 4: 스크립트를 더한다**

`state`에 더한다(`sessionMeta` 다음):

```js
    codexAdapters: [],
    pendingSelect: null,
    closeArmed: null,  // { id, at } while a session's close button waits for its second click
```

`// --- Add session popup ---` 바로 앞에 새 블록:

```js
  // --- Codex helpers ---
  function usableAdapters(adapters) {
    return adapters.filter(a => a.ready).sort((a, b) => (b.isLocal ? 1 : 0) - (a.isLocal ? 1 : 0));
  }

  function adapterLabels(adapters) {
    const counts = {};
    adapters.forEach(a => { counts[a.host] = (counts[a.host] || 0) + 1; });
    return adapters.map(a => counts[a.host] > 1 ? `${a.host} (${a.id.slice(0, 4)})` : a.host);
  }

  // A second tap within 0.4 s is a phone double-tap, not a confirmation.
  function closeStep(armedAt, now) {
    if (armedAt === null || now - armedAt >= 3000) return 'arm';
    return now - armedAt < 400 ? 'wait' : 'close';
  }

```

`// --- Add session popup ---` 블록의 `$('#addSessionBtn').addEventListener('click', …)`를 바꾸고, 블록 끝(`document.querySelectorAll('#cmdPopup .cmd-copy')…` 다음)에 더한다:

```js
  $('#addSessionBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !$('#cmdPopup').classList.contains('active');
    $('#cmdPopup').classList.toggle('active');
    if (opening) {
      renderCodexForm();
      loadCodexFolders();
    }
  });
```

```js
  function renderCodexForm() {
    const usable = usableAdapters(state.codexAdapters);
    $('#codexSection').hidden = !usable.length;
    if (!usable.length) return;
    const select = $('#codexAdapter');
    const current = select.value;
    const labels = adapterLabels(usable);
    select.innerHTML = usable.map((a, i) => `<option value="${esc(a.id)}">${esc(labels[i])}</option>`).join('');
    if (usable.some(a => a.id === current)) select.value = current;
    select.hidden = usable.length < 2;
  }

  async function loadCodexFolders() {
    const list = $('#codexFolders');
    list.innerHTML = '';
    const adapterId = $('#codexAdapter').value;
    if (!adapterId) return;
    try {
      const res = await fetch(`/api/codex/folders?adapterId=${encodeURIComponent(adapterId)}`);
      if (!res.ok || $('#codexAdapter').value !== adapterId) return;
      const { folders } = await res.json();
      list.innerHTML = folders.map(f => `<option value="${esc(f)}"></option>`).join('');
    } catch {}
  }

  async function createCodexConversation() {
    const btn = $('#codexCreate');
    const folder = $('#codexFolder').value.trim();
    const adapterId = $('#codexAdapter').value;
    if (!folder || !adapterId || btn.disabled) return;
    const error = $('#codexError');
    error.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await fetch('/api/codex/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapterId, cwd: folder }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      $('#cmdPopup').classList.remove('active');
      $('#codexFolder').value = '';
      // The session can register before or after this answer arrives.
      if (state.sessions[body.sessionId]) selectSession(body.sessionId);
      else state.pendingSelect = body.sessionId;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create';
    }
  }

  async function onCloseClick(id) {
    const armedAt = state.closeArmed && state.closeArmed.id === id ? state.closeArmed.at : null;
    const step = closeStep(armedAt, Date.now());
    if (step === 'wait') return;
    if (step === 'arm') {
      const at = Date.now();
      state.closeArmed = { id, at };
      renderSessions();
      setTimeout(() => {
        if (state.closeArmed && state.closeArmed.at === at) {
          state.closeArmed = null;
          renderSessions();
        }
      }, 3000);
      return;
    }
    state.closeArmed = null;
    renderSessions();
    try {
      await fetch('/api/codex/threads/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      });
    } catch {}
  }

  $('#codexAdapter').addEventListener('change', loadCodexFolders);
  $('#codexCreate').addEventListener('click', createCodexConversation);
  $('#codexFolder').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      createCodexConversation();
    }
  });
```

`handleMessage`:
- `case 'sessions_list':`의 `renderSessions();` 다음에 `if (state.pendingSelect && state.sessions[state.pendingSelect]) selectSession(state.pendingSelect);`
- `case 'session_connected':`의 `renderSessions();` 다음에 `if (state.pendingSelect === msg.session.id) selectSession(msg.session.id);`
- 새 분기(`case 'permission_resolved'` 앞):

```js
      case 'codex_adapters': {
        state.codexAdapters = msg.adapters || [];
        if ($('#cmdPopup').classList.contains('active')) {
          const before = $('#codexAdapter').value;
          renderCodexForm();
          if ($('#codexAdapter').value !== before) loadCodexFolders();
        }
        break;
      }
```

`selectSession(id)` 첫 줄에 `state.pendingSelect = null;` (사용자가 다른 세션을 먼저 고르면 나중 선택을 취소한다).

`renderSessions()`의 카드 템플릿 — `const connTime = …` 다음에:

```js
      const armed = state.closeArmed && state.closeArmed.id === id && closeStep(state.closeArmed.at, Date.now()) !== 'arm';
      const closeBtn = s.closable
        ? `<button class="session-close${armed ? ' armed' : ''}" type="button" title="Close — stays in Codex history">${armed ? 'Close?' : '&times;'}</button>`
        : '';
```

그리고 카드 안(`.session-body` 닫는 `</div>` 다음, 카드 닫는 `</div>` 앞)에 `${closeBtn}`.

`bindSessionCards`의 `forEach` 안, `card.addEventListener('click', …)` 다음에:

```js
      const closeBtn = card.querySelector('.session-close');
      if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); onCloseClick(id); });
```

`card`의 `click` 처리기 첫 줄에 `if (e.target.closest('.session-close')) return;`도 더한다(버튼 안 요소를 눌러도 선택되지 않게).

- [ ] **Step 5: CSS를 더한다(디자인)**

`.codex-section`, `#codexAdapter`, `#codexFolder`, `.codex-warning`, `#codexCreate`, `.codex-error`, `.session-close`, `.session-close.armed`의 스타일을 위 제약 안에서 정한다. 768px 이하는 기존 `@media (max-width: 768px)` 블록에 더한다.

- [ ] **Step 6: README를 고친다** — `README.md`

"Codex Sessions"의 194행(`- A conversation is followed only while Codex is working on it, …`) 문장 끝에 ` Conversations created from the dashboard are the exception (below).`를 붙이고, 195행(`- If Codex runs on another PC, …`) 다음에:

```markdown
- **New Codex conversation from the dashboard**: click **+** in the session list. The Codex part appears only when a Codex adapter is connected to a running Codex daemon; claude-alarm does not start the daemon, so after a reboot open Codex once. Pick the PC if more than one is connected, type a folder on that PC or pick one of its recent Codex folders, and click **Create**. The new session is selected; send the first instruction from the message box.
- Conversations created this way run with **full access and no approval prompts** (`danger-full-access`, approval policy `never`): Codex can run any command on that PC.
- They stay on the dashboard until you close them with the session's **×** button (tap it, then tap **Close?** again). Closing only lets go of the conversation: it stays in Codex's history and can be continued in Codex. If Codex is still working, the task finishes first and the session drops off about a minute later. When the hub restarts, an adapter started by the hub restarts with it and these conversations drop off about a minute later.
```

"Remote Access" 제목 바로 아래 첫 문단 앞에:

```markdown
> Anyone who can open the dashboard can start Codex conversations with full access on every PC that runs the Codex adapter. Keep the hub token private.
```

- [ ] **Step 7: 통과를 확인한다**

Run: `node --import tsx --test test/dashboard-codex.test.ts test/dashboard-permissions.test.ts test/dashboard-mention.test.ts test/dashboard-images.test.ts`
Expected: PASS

Run: `npm run build`
Expected: 성공, `dist/dashboard/index.html` 갱신

브라우저 확인(실제 데몬 없이): 격리 HOME으로 Hub를 포트 7983에 띄우고(Task 8 Step 2와 같은 방법, `codex.enabled: false`), 테스트용 가짜 어댑터 없이 "+"를 눌러 Codex 부분이 **보이지 않는** 것만 확인한다. 나머지 화면 확인은 Task 8.

- [ ] **Step 8: 커밋**

```bash
git add src/dashboard/index.html README.md test/dashboard-codex.test.ts
git commit -m "feat(dashboard): start and close Codex conversations from the + popup"
```

---

### Task 8: 실제 데몬 실측과 마무리 (컨트롤러가 직접)

**Files:** 없음(실측). 결과는 Obsidian 작업 문서에.

- [ ] **Step 1: 전체 검증**

claude-alarm-6c에 전체 테스트를 돌린다고 알린 뒤:

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: 모두 통과. 실패하면 출력 그대로 기록하고 고친다.

- [ ] **Step 2: 격리 Hub를 띄운다**

claude-alarm `notify`(level `info`): title `Codex probe`, message `Starting the dashboard Codex test against the real daemon in C:\tmp\codex-test (port 7983). Conversations named codex-test may appear; please do not answer them.`

임시 폴더 `<scratchpad>/hub-home`을 만들고 `<scratchpad>/hub-home/.claude-alarm/config.json`:

```json
{
  "hub": { "host": "127.0.0.1", "port": 7983, "token": "codex-new-thread-e2e" },
  "notifications": { "desktop": false, "sound": false },
  "webhooks": [],
  "codex": { "enabled": true }
}
```

PowerShell에서(자기 PID 기록):

```powershell
$env:HOME = '<scratchpad>\hub-home'; $env:USERPROFILE = '<scratchpad>\hub-home'
$p = Start-Process node -ArgumentList 'dist/hub/server.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput '<scratchpad>\hub.out' -RedirectStandardError '<scratchpad>\hub.err'
$p.Id
```

`hub.out`/`hub.err`에 `Connected to Codex daemon`이 나오는지 본다. 격리 HOME 때문에 proxy가 데몬을 못 찾으면 `CODEX_HOME`을 실제 `C:\Users\USER\.codex`로 주고 다시 띄운다.

- [ ] **Step 3: 확인 항목**(스펙 "실측" 1–9, 결과를 표로 기록)

브라우저(claude-in-chrome)로 `http://127.0.0.1:7983/?token=codex-new-thread-e2e`:

1. "+" → Codex 부분 보임, PC 선택 숨김(어댑터 1개), 폴더 제안에 최근 Codex 폴더가 나옴
2. `C:\tmp\codex-test` 입력 → Create → 새 세션 선택·입력창 포커스, 이름이 `codex-test`, `thread/start` 시간
3. 입력창에 `Reply with exactly: pong` → 응답 `pong`이 대시보드에 옴, 승인 요청 없음
4. 응답 뒤 90초 넘게 세션이 남음
5. 제목이 첫 메시지 내용으로 바뀜
6. 닫기 → 한 번 탭 `Close?` → 다시 탭 → 세션 즉시 사라짐, 60초 뒤 데몬 `thread/loaded/list`에서 빠짐(Task 1 스크립트의 `isLoaded`로 확인)
7. 새로 하나 더 만든 뒤 Hub 재시작(자기 PID 종료 → 같은 명령으로 다시) → 약 1분 뒤 사라짐
8. `~/.codex/config.toml`의 `C:\tmp\codex-test` trusted 항목 변화(기록만)
9. 브라우저 폭 360px·1280px에서 팝업·닫기 버튼 모양(스크린샷)

없는 폴더(`C:\tmp\no-such-folder`)로 Create → 양식 아래 `Folder not found on <host>: C:\tmp\no-such-folder`.

- [ ] **Step 4: 정리**

자기가 띄운 Hub PID만 종료(`Stop-Process -Id <pid>`). 어댑터는 stdin EOF로 따라 종료되는지 `codex.pid`(격리 HOME 안)로 확인. 텔레그램으로 나간 것이 없는지 Hub 로그 확인.

- [ ] **Step 5: 기록**

Obsidian 작업 문서에 실측 결과 표, `thread/start` 시간, 남은 과제를 적고 서버에 동기화(`sync:check` → 이번 문서만이면 `sync`). 그다음 superpowers:finishing-a-development-branch.
