# Codex Adapter Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공유 Codex app-server 데몬의 대화를 claude-alarm Hub 세션으로 등록해, 대시보드·텔레그램에서 Codex 응답·완료·오류를 받고 쉬고 있는 Codex 대화에 지시할 수 있게 한다(스펙 단계 A, 목표 ①②).

**Architecture:** 별도 Node 프로세스인 Codex 어댑터(`src/codex/*`)가 `codex app-server proxy`의 stdio 위에 WebSocket을 얹어 데몬과 JSON-RPC로 대화하고, Codex 대화마다 기존 채널 경로(`/ws/channel`)로 Hub 연결을 하나씩 열어 `register`·`status`·`reply`·`notify`를 보낸다. Hub는 `config.codex.enabled`일 때 어댑터를 자식 프로세스로 띄우고 관리한다. Hub·대시보드·텔레그램은 세션의 `agentKind`로 Codex를 구분해 표시만 조정한다.

**Tech Stack:** TypeScript ESM, `ws`, `node:child_process`, `node:test` + `tsx`, 단일 파일 대시보드(`src/dashboard/index.html`), tsup.

**Spec:** `docs/superpowers/specs/2026-10-01-codex-adapter-design.md` (이 계획은 단계 A = 스펙 §1–7, §10–11 중 A에 해당하는 부분. 단계 B 승인 중계·단계 C 추가 지시/이미지는 범위 밖)

## Global Constraints

- Codex 기능은 기본 꺼짐: `config.codex.enabled === true`일 때만 Hub가 어댑터를 띄운다. 켜지 않은 환경에서 동작 변화 없음.
- 어댑터는 포트를 열지 않는다. 데몬 연결은 `codex app-server proxy` + 그 stdio 위 WebSocket(JSONL 금지).
- Codex 실행: `shell: false`가 기본. Windows의 npm `codex.cmd` 셈만 셸로 실행하고, 명령줄에는 고정 인자(`app-server proxy`)만 넣는다.
- Hub 세션 ID: `codex:<threadId>`. `SessionInfo.agentKind = 'codex'`, `title` = 대화 제목.
- `thread/resume`에는 `{ threadId, excludeTurns: true }`만 보낸다(다른 필드는 사용자 대화 설정을 덮어쓴다). `thread/unsubscribe`는 쓰지 않는다.
- 대상 대화: loaded이고 `parentThreadId` 없음, `ephemeral` 아님.
- 상태 변환: `active`(플래그 없음)→`working`, `active`+`waitingOnApproval`/`waitingOnUserInput`→`waiting_input`, 그 외→`idle`. `notLoaded`·closed·archived·deleted → Hub 연결 닫음.
- 지시 출처 표시(사용자 결정): `[claude-alarm · Dashboard] `, `[claude-alarm · Telegram] `, `[claude-alarm · API] `, 출처 없음 `[claude-alarm] `.
- 단계 A는 `idle`이 아닌 대화로의 지시를 보내지 않고 경고 `notify`만 보낸다. 자동 재전송·대기열 없음.
- 사용자에게 보이는 문구(대시보드·텔레그램·Codex 출처 표시)는 기존 UI처럼 **영어**.
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선 주석 금지.
- 테스트에서 Hub를 띄우면 반드시 `test/isolate-home.ts`를 첫 import로 두고 `notifications: { desktop: false, sound: false }`를 넘긴다(실제 텔레그램 봇·uploads 오염 사고 이력). 실제 Codex·데몬에는 접근하지 않는다.
- 테스트 포트: 기존 7996–7998 사용 중. 이 계획은 7993(hub-client), 7994(codex-adapter), 7995(hub-message-source).

## Review Focus

1. **npm으로 설치한 Codex(Windows `codex.cmd`)** — `shell: false`로는 `.cmd`가 실행되지 않아 어댑터가 영원히 연결에 실패한다. → Task 5 `resolveCommand` 테스트.
2. **Codex 미설치 또는 데몬 연결 불가** — 어댑터가 죽거나 Hub를 끌어내리면 안 되고, 간격을 늘려 가며 재시도해야 한다. → Task 11 "missing binary" 테스트, Task 12 supervisor 재시작 테스트.
3. **막 연 Codex 창(첫 메시지 전)** — `thread/resume`이 `no rollout found`로 실패해도 세션은 보이고, 다음 상태 변화 때 구독을 다시 시도해야 한다. → Task 9 테스트.
4. **승인 대기 중인 대화에 지시** — `active`+`waitingOnApproval`도 바쁜 상태로 보고 경고만 보내야 한다(새 턴이 끼어들면 안 됨). → Task 10 테스트.
5. **Hub 재시작** — 어댑터가 살아 있는 동안 Hub가 재시작되면 Codex 세션이 제목·상태와 함께 다시 등록돼야 한다. → Task 8 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | `AgentKind`, `MessageSource`, `SessionInfo.agentKind/title`, `message_to_session.source`, `CodexConfig` | 수정 |
| `src/shared/session-label.ts` | Hub·텔레그램 공용 세션 라벨(`Codex · ` 접두어) | 생성 |
| `src/hub/session-manager.ts` | `title`을 기준 이름으로 사용 | 수정 |
| `src/hub/server.ts` | 라벨 헬퍼 사용, 메시지 출처 태그, 어댑터 감독 배선 | 수정 |
| `src/hub/telegram.ts` | 라벨 헬퍼, 세션 선택 버튼 스냅샷 | 수정 |
| `src/dashboard/index.html` | Codex 배지, 작성자 표기, 멘션 통과, 이미지 버튼 끔 | 수정 |
| `src/channel/hub-client.ts` | 등록 정보 확장, `reregister()`, `disconnect()` 후 재연결 금지 | 수정 |
| `src/codex/transport.ts` | proxy 실행·WebSocket, Windows 명령 해석 | 생성 |
| `src/codex/rpc.ts` | JSON-RPC 클라이언트 | 생성 |
| `src/codex/mapping.ts` | 대화→세션 변환 순수 함수 | 생성 |
| `src/codex/adapter.ts` | 발견·구독·세션·응답·지시·재연결 | 생성 |
| `src/codex/main.ts` | 어댑터 실행 진입점(pid 파일, stdin 감시) | 생성 |
| `src/hub/codex-supervisor.ts` | Hub가 어댑터를 띄우고 재시작 | 생성 |
| `src/shared/constants.ts` | `CODEX_PID_FILE`, `CODEX_LOG_FILE` | 수정 |
| `src/shared/config.ts` | `setCodexEnabled()` | 수정 |
| `src/cli.ts` | `codex enable|disable|start|stop|status` | 수정 |
| `tsup.config.ts` | `codex/main` 진입점 | 수정 |
| `README.md` | Codex 세션 안내 | 수정 |
| `test/fixtures/fake-codex-proxy.mjs` | stdio WebSocket ↔ 테스트 제어 소켓 중계 | 생성 |
| `test/helpers/fake-codex-daemon.ts` | 가짜 데몬(`FakeDaemon`), `until()` | 생성 |
| `test/session-label.test.ts`, `test/hub-message-source.test.ts`, `test/telegram-session-select.test.ts`, `test/codex-transport.test.ts`, `test/codex-rpc.test.ts`, `test/codex-mapping.test.ts`, `test/hub-client.test.ts`, `test/codex-adapter.test.ts`, `test/codex-supervisor.test.ts`, `test/codex-config.test.ts` | 새 테스트 | 생성 |
| `test/session-manager.test.ts`, `test/dashboard-mention.test.ts` | 테스트 추가 | 수정 |

단일 테스트 파일 실행: `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`
전체: `npm test` / 타입 검사: `npx tsc --noEmit`

---

### Task 1: 공용 타입 · 세션 라벨 · 제목 기반 이름

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/session-label.ts`
- Modify: `src/hub/session-manager.ts:7-31`
- Modify: `src/hub/server.ts:776-779` (`getSessionLabel`)
- Modify: `src/hub/telegram.ts:303-305` (`getLabel`)
- Test: `test/session-label.test.ts`, `test/session-manager.test.ts`

**Interfaces:**
- Produces: `type AgentKind = 'claude' | 'codex'`, `type MessageSource = 'dashboard' | 'telegram' | 'api'`, `SessionInfo.agentKind?: AgentKind`, `SessionInfo.title?: string`, `message_to_session.source?: MessageSource`, `interface CodexConfig { enabled: boolean; command?: string }`, `AppConfig.codex?: CodexConfig`, `sessionLabel(session: SessionInfo): string` (`src/shared/session-label.ts`)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/session-label.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionLabel } from '../src/shared/session-label.js';

const base = { id: 'x', name: 'n', status: 'idle' as const, connectedAt: 0, lastActivity: 0 };

test('claude sessions keep the plain label', () => {
  assert.equal(sessionLabel({ ...base, displayName: 'proj', cwd: '/w/proj' }), 'proj');
});

test('codex sessions are prefixed', () => {
  assert.equal(sessionLabel({ ...base, agentKind: 'codex', displayName: 'Fix bug' }), 'Codex · Fix bug');
});

test('falls back to the cwd folder, then the name', () => {
  assert.equal(sessionLabel({ ...base, cwd: 'C:\\w\\api' }), 'api');
  assert.equal(sessionLabel(base), 'n');
});
```

`test/session-manager.test.ts` 끝에 추가:

```ts
test('register uses title as the display name when present', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Fix login bug', agentKind: 'codex' as const });
  assert.equal(sm.get('c1')?.displayName, 'Fix login bug');
});

test('sessions sharing a title are numbered', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Same' });
  sm.register({ ...makeSession('c2'), title: 'Same' });
  assert.equal(sm.get('c1')?.displayName, 'Same (1)');
  assert.equal(sm.get('c2')?.displayName, 'Same (2)');
});

test('re-registering with a new title renames the session', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Old' });
  sm.register({ ...makeSession('c1'), title: 'New' });
  assert.equal(sm.get('c1')?.displayName, 'New');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/session-label.test.ts test/session-manager.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/session-label.js'`, 그리고 title 테스트에서 displayName이 `c1` 등으로 나옴.

- [ ] **Step 3: 타입 추가** — `src/shared/types.ts`

`SessionStatus` 아래에 추가:

```ts
export type AgentKind = 'claude' | 'codex';

export type MessageSource = 'dashboard' | 'telegram' | 'api';
```

`SessionInfo`의 `peerName?: string;` 다음 줄에 추가:

```ts
  agentKind?: AgentKind;
  title?: string;
```

`ChannelMessage`의 `message_to_session` 줄을 바꾼다:

```ts
  | { type: 'message_to_session'; sessionId: string; content: string; source?: MessageSource }
```

`TelegramConfig` 인터페이스 다음에 추가하고 `AppConfig`에 필드를 더한다:

```ts
export interface CodexConfig {
  enabled: boolean;
  command?: string;
}
```

```ts
  telegram?: TelegramConfig;
  codex?: CodexConfig;
```

- [ ] **Step 4: 라벨 헬퍼 생성** — `src/shared/session-label.ts`

```ts
import type { SessionInfo } from './types.js';

export function sessionLabel(session: SessionInfo): string {
  const base = session.displayName || session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  return session.agentKind === 'codex' ? `Codex · ${base}` : base;
}
```

- [ ] **Step 5: SessionManager가 title을 기준 이름으로 쓰게** — `src/hub/session-manager.ts`

`register` 앞부분을 다음으로 바꾼다(번호 부여 로직은 그대로):

```ts
  register(session: SessionInfo): void {
    // Auto-number duplicate names
    const baseName = this.baseName(session);
    const existing = Array.from(this.sessions.values()).filter(
      s => s.id !== session.id && this.baseName(s) === baseName,
    );
```

클래스 안(예: `count()` 아래)에 추가:

```ts
  private baseName(session: SessionInfo): string {
    return session.title || session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  }
```

- [ ] **Step 6: Hub·텔레그램 라벨을 헬퍼로**

`src/hub/server.ts` — import 추가 `import { sessionLabel } from '../shared/session-label.js';`, `getSessionLabel`을 교체:

```ts
  private getSessionLabel(session?: SessionInfo): string {
    return session ? sessionLabel(session) : 'unknown';
  }
```

`src/hub/telegram.ts` — import 추가 `import { sessionLabel } from '../shared/session-label.js';`, `getLabel`을 교체:

```ts
  private getLabel(session: SessionInfo): string {
    return sessionLabel(session);
  }
```

- [ ] **Step 7: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/session-label.test.ts test/session-manager.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음
Run: `npm test` → 기존 테스트 포함 PASS

- [ ] **Step 8: 커밋**

```bash
git add src/shared/types.ts src/shared/session-label.ts src/hub/session-manager.ts src/hub/server.ts src/hub/telegram.ts test/session-label.test.ts test/session-manager.test.ts
git commit -m "feat(hub): agent kind, session titles and a shared session label"
```

---

### Task 2: Hub가 지시 출처를 붙인다

**Files:**
- Modify: `src/hub/server.ts` — `handleApiSend`(313행 근처), `handleDashboardConnection`의 `message_to_session` 분기(509–513행), `initTelegram`의 `onMessageToSession`(611–618행)
- Test: `test/hub-message-source.test.ts`

**Interfaces:**
- Consumes: `MessageSource` (Task 1)
- Produces: 채널 소켓으로 가는 모든 `message_to_session`에 `source`(`'dashboard' | 'telegram' | 'api'`)가 붙는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/hub-message-source.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7995;
const TOKEN = 'source-test';
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
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-message-source.test.ts`
Expected: FAIL — `source`가 `undefined`.

- [ ] **Step 3: 구현** — `src/hub/server.ts`

`handleApiSend`:

```ts
    const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'api' };
```

`handleDashboardConnection`의 `message_to_session` 분기:

```ts
        if (msg.type === 'message_to_session') {
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
          }
        } else if (msg.type === 'image_upload') {
```

`initTelegram`의 `onMessageToSession`:

```ts
        const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-message-source.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/hub/server.ts test/hub-message-source.test.ts
git commit -m "feat(hub): tag messages to sessions with their source"
```

---

### Task 3: 텔레그램 세션 선택 버튼이 보낸 시점의 목록을 가리키게

**Files:**
- Modify: `src/hub/telegram.ts` — `pendingMessages` 선언(58행), `/s_` 분기(194–216행), 다중 세션 분기(235–251행), `handleSessionSelectCallback`(407–432행)
- Test: `test/telegram-session-select.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `pendingMessages` 값에 `sessionIds: string[]` 추가. private `pendingSession(pending, idx): SessionInfo | undefined`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/telegram-session-select.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function makeBot(initial: ReturnType<typeof s>[]) {
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const state = { sessions: initial };
  bot.getSessions = () => state.sessions;
  const delivered: string[] = [];
  bot.onMessageToSession = (id, content) => { delivered.push(`${id}:${content}`); };
  return { bot, state, delivered };
}

test('a session button keeps pointing at the session listed when it was sent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await (bot as any).handleCallbackQuery({ id: 'q', data: 'sess:0:111', message: { chat: { id: 111 }, message_id: 5, text: '' } });
  assert.deepEqual(delivered, ['a:hello']);
});

test('the /s_ command resolves against the same snapshot', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await (bot as any).handleIncomingMessage({ message_id: 2, chat: { id: 111 }, text: '/s_2' });
  assert.deepEqual(delivered, ['b:hello']);
});

test('a button for a session that has gone away delivers nothing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
  const { bot, state, delivered } = makeBot([s('a'), s('b')]);
  await (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text: 'hello' });
  state.sessions = [s('b')];
  await (bot as any).handleCallbackQuery({ id: 'q', data: 'sess:0:111', message: { chat: { id: 111 }, message_id: 5, text: '' } });
  assert.deepEqual(delivered, []);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-session-select.test.ts`
Expected: FAIL — 첫 테스트가 `codex:new:hello`, 두 번째가 `a:hello`를 받는다.

- [ ] **Step 3: 구현** — `src/hub/telegram.ts`

`pendingMessages` 선언:

```ts
  private pendingMessages = new Map<number, { text?: string; photoFileId?: string; caption?: string; sessionIds: string[] }>(); // chatId -> pending
```

`/s_` 분기 안의 `if (pending) { ... }` 블록 전체를 교체:

```ts
        if (pending) {
          this.pendingMessages.delete(msg.chat.id);
          const session = this.pendingSession(pending, parseInt(selectMatch[1], 10) - 1);
          if (session) {
            if (pending.photoFileId) {
              await this.deliverPhotoToSessionByFileId(session.id, pending.photoFileId, pending.caption);
            } else if (pending.text) {
              this.deliverToSession(session.id, pending.text);
            }
            this.sendMessage(`Sent to [${this.getLabel(session)}]`);
          } else {
            this.sendMessage('Invalid session number.');
          }
          return;
        }
```

다중 세션 분기의 `pendingMessages.set` 두 줄을 교체:

```ts
    const sessionIds = sessions.map((s) => s.id);
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      this.pendingMessages.set(msg.chat.id, { photoFileId: largest.file_id, caption: text, sessionIds });
    } else {
      this.pendingMessages.set(msg.chat.id, { text, sessionIds });
    }
```

`handleSessionSelectCallback`의 앞부분(세션 찾기부터 전달까지)을 교체하고, 그 뒤의 `answerCallbackQuery`/`editMessageText` 부분은 그대로 둔다:

```ts
  private async handleSessionSelectCallback(query: TelegramCallbackQuery): Promise<void> {
    const parts = query.data!.split(':');
    if (parts.length < 3) return;
    const [, idxStr, chatIdStr] = parts;
    const chatId = parseInt(chatIdStr, 10);

    const pending = this.pendingMessages.get(chatId);
    const session = pending ? this.pendingSession(pending, parseInt(idxStr, 10)) : undefined;
    if (!pending || !session) {
      await this.answerCallbackQuery(query.id, 'Session not found');
      return;
    }
    this.pendingMessages.delete(chatId);

    if (pending.photoFileId) {
      await this.deliverPhotoToSessionByFileId(session.id, pending.photoFileId, pending.caption);
    } else if (pending.text) {
      this.deliverToSession(session.id, pending.text);
    }
```

`getLabel` 위에 추가:

```ts
  // Buttons are numbered against the list shown when they were sent; Codex sessions come and go, so the live list may have shifted.
  private pendingSession(pending: { sessionIds: string[] }, idx: number): SessionInfo | undefined {
    const id = pending.sessionIds[idx];
    return id ? this.getSessions?.().find((s) => s.id === id) : undefined;
  }
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-session-select.test.ts test/telegram-callback.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/hub/telegram.ts test/telegram-session-select.test.ts
git commit -m "fix(telegram): resolve session buttons against the list they were sent with"
```

---

### Task 4: 대시보드 — Codex 배지 · 작성자 · 멘션 통과 · 이미지 버튼

**Files:**
- Modify: `src/dashboard/index.html` — CSS `.unread-badge` 다음(212행 근처), `sessionDisplayName` 다음(1131행), `mentionTargets`(1154–1158행), `buildRouting` 시작(1192행), `renderSessions`의 `session-name`(1436행), `updateImageUI`(1581–1585행), `renderMessages`의 `message-meta`(1619행)
- Test: `test/dashboard-mention.test.ts`

**Interfaces:**
- Consumes: 세션의 `agentKind` (Task 1)
- Produces: 대시보드 내부 함수 `agentName(s)` → `'Codex' | 'Claude'`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/dashboard-mention.test.ts` 끝에 추가

```ts
test('messages to a Codex session pass through without routing lines', () => {
  const withCodex = { ...sessions, x: { id: 'x', name: 'proj', displayName: 'Fix bug', agentKind: 'codex', isLocal: true } };
  const h = loadHelpers(withCodex, names, 'x');
  assert.deepEqual({ ...h.buildRouting('@front please check') }, { ok: true, content: '@front please check' });
  assert.equal(h.mentionTargets().length, 0);
});

test('agentName names the session agent', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.agentName({ agentKind: 'codex' }), 'Codex');
  assert.equal(h.agentName(sessions.a), 'Claude');
  assert.equal(h.agentName(undefined), 'Claude');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-mention.test.ts`
Expected: FAIL — 라우팅 줄이 붙고, `agentName is not a function`.

- [ ] **Step 3: 구현** — `src/dashboard/index.html`

CSS, `.unread-badge { ... }` 블록 다음:

```css
  .agent-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--green);
    color: var(--green);
  }
```

`sessionDisplayName` 함수 바로 다음:

```js
  function agentName(s) {
    return s && s.agentKind === 'codex' ? 'Codex' : 'Claude';
  }
```

`mentionTargets` 첫 줄 다음의 가드를 교체:

```js
    if (!selected || !selected.isLocal || selected.agentKind === 'codex') return [];
```

`buildRouting(text) {` 바로 다음에 추가:

```js
    const target = state.sessions[state.selectedSession];
    if (target && target.agentKind === 'codex') return { ok: true, content: text };
```

`renderSessions`의 `session-name` 줄:

```js
          <div class="session-name" title="Double-click to rename">${esc(dispName)}${s.agentKind === 'codex' ? '<span class="agent-badge">Codex</span>' : ''}${unread ? `<span class="unread-badge">${unread}</span>` : ''}</div>
```

`updateImageUI`:

```js
    const canImage = s && s.isLocal && s.agentKind !== 'codex';
```

`renderMessages`의 `message-meta` 줄:

```js
        <div class="message-meta">${m.from === 'session' ? agentName(s) : 'You'} &middot; ${timeStr}</div>
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-mention.test.ts` → PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard/index.html test/dashboard-mention.test.ts
git commit -m "feat(dashboard): show Codex sessions with their own badge and author"
```

---

### Task 5: Codex 데몬 transport와 테스트용 가짜 데몬

**Files:**
- Create: `src/codex/transport.ts`
- Create: `test/fixtures/fake-codex-proxy.mjs`
- Create: `test/helpers/fake-codex-daemon.ts`
- Test: `test/codex-transport.test.ts`

**Interfaces:**
- Produces:
  - `type SpawnFn = (command: string, args: string[]) => ChildProcess`
  - `resolveCommand(command: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): { file: string; shell: boolean }`
  - `defaultSpawn: SpawnFn`
  - `interface ProxyConnection { ws: WebSocket; close(): void }`
  - `connectProxy(command: string, spawnFn?: SpawnFn): Promise<ProxyConnection>` — 핸드셰이크 전 proxy 종료·spawn 실패면 reject
  - 테스트 헬퍼 `class FakeDaemon` (`start()`, `stop()`, `spawnFn`, `handle(method, fn)`, `notify(method, params)`, `serverRequest(id, method, params)`, `dropClient()`, `calls(method)`, `connections`), `until(probe, timeoutMs?)`

- [ ] **Step 1: 가짜 proxy 작성** — `test/fixtures/fake-codex-proxy.mjs`

`codex app-server proxy` 자리를 대신하는 스크립트다. stdio에서 WebSocket 서버 역할을 하고, 받은 메시지를 `FAKE_CODEX_CONTROL` 제어 소켓(테스트의 `FakeDaemon`)과 그대로 주고받는다.

```js
import http from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

const control = new WebSocket(process.env.FAKE_CODEX_CONTROL);
const socket = new Duplex({
  read() {},
  write(chunk, _encoding, callback) { process.stdout.write(chunk, callback); },
  final(callback) { callback(); },
});
Object.assign(socket, {
  setTimeout() { return socket; },
  setNoDelay() { return socket; },
  setKeepAlive() { return socket; },
  ref() {},
  unref() {},
  remoteAddress: '127.0.0.1',
});
process.stdin.on('data', (d) => socket.push(d));
process.stdin.on('end', () => process.exit(0));

const wss = new WebSocketServer({ noServer: true });
const server = http.createServer();
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on('message', (d) => control.send(String(d)));
    control.on('message', (d) => ws.send(String(d)));
  });
});
control.on('open', () => server.emit('connection', socket));
control.on('close', () => process.exit(0));
control.on('error', () => process.exit(1));
```

- [ ] **Step 2: 가짜 데몬 헬퍼 작성** — `test/helpers/fake-codex-daemon.ts`

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SpawnFn } from '../../src/codex/transport.js';

const PROXY = fileURLToPath(new URL('../fixtures/fake-codex-proxy.mjs', import.meta.url));

type Handler = (params: any) => unknown;
export interface Received { method: string; params: any; id?: number | string }

export class FakeDaemon {
  readonly received: Received[] = [];
  connections = 0;
  private handlers = new Map<string, Handler>();
  private wss?: WebSocketServer;
  private client?: WebSocket;

  async start(): Promise<void> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      this.client = ws;
      this.connections++;
      ws.on('message', (data) => this.onMessage(ws, JSON.parse(String(data))));
    });
    this.wss = wss;
    this.handle('initialize', () => ({ userAgent: 'fake-codex/0' }));
  }

  get url(): string {
    const addr = this.wss?.address();
    return `ws://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
  }

  readonly spawnFn: SpawnFn = (_command, args) =>
    spawn(process.execPath, [PROXY, ...args], {
      stdio: 'pipe',
      env: { ...process.env, FAKE_CODEX_CONTROL: this.url },
    });

  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  notify(method: string, params: unknown): void {
    this.client?.send(JSON.stringify({ method, params }));
  }

  serverRequest(id: number, method: string, params: unknown): void {
    this.client?.send(JSON.stringify({ id, method, params }));
  }

  dropClient(): void {
    this.client?.terminate();
    this.client = undefined;
  }

  calls(method: string): Received[] {
    return this.received.filter((r) => r.method === method);
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private onMessage(ws: WebSocket, m: any): void {
    if (m.method === undefined) return;
    this.received.push({ method: m.method, params: m.params, id: m.id });
    if (m.id === undefined) return;
    const reply = (body: object) => ws.send(JSON.stringify({ id: m.id, ...body }));
    const handler = this.handlers.get(m.method);
    if (!handler) {
      reply({ error: { code: -32601, message: `no handler for ${m.method}` } });
      return;
    }
    try {
      reply({ result: handler(m.params) });
    } catch (err) {
      reply({ error: { code: -32600, message: (err as Error).message } });
    }
  }
}

export async function until<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
```

- [ ] **Step 3: 실패하는 테스트 작성** — `test/codex-transport.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connectProxy, resolveCommand, type SpawnFn } from '../src/codex/transport.js';
import { FakeDaemon } from './helpers/fake-codex-daemon.js';

test('connectProxy speaks WebSocket over the proxy stdio', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const conn = await connectProxy('codex', daemon.spawnFn);
  try {
    const reply = new Promise<string>((resolve) => conn.ws.once('message', (d) => resolve(String(d))));
    conn.ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
    assert.equal(JSON.parse(await reply).result.userAgent, 'fake-codex/0');
    assert.deepEqual(daemon.calls('initialize').length, 1);
  } finally {
    conn.close();
    await daemon.stop();
  }
});

test('connectProxy rejects when the proxy exits before the handshake', async () => {
  const spawnFn: SpawnFn = () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
  await assert.rejects(connectProxy('codex', spawnFn), /exited/);
});

test('connectProxy rejects when the command does not exist', async () => {
  await assert.rejects(connectProxy('claude-alarm-no-such-codex-binary'));
});

test('resolveCommand prefers codex.exe and falls back to the npm codex.cmd shim', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  assert.deepEqual(resolveCommand('codex', 'win32', { PATH: dir }), { file: path.join(dir, 'codex.cmd'), shell: true });
  fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  assert.deepEqual(resolveCommand('codex', 'win32', { PATH: dir }), { file: path.join(dir, 'codex.exe'), shell: false });
});

test('resolveCommand leaves explicit paths and other platforms alone', () => {
  assert.deepEqual(resolveCommand('C:/tools/codex.exe', 'win32', { PATH: '' }), { file: 'C:/tools/codex.exe', shell: false });
  assert.deepEqual(resolveCommand('codex', 'linux', { PATH: '/usr/bin' }), { file: 'codex', shell: false });
});
```

- [ ] **Step 4: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/transport.js'`

- [ ] **Step 5: 구현** — `src/codex/transport.ts`

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import WebSocket, { type ClientOptions } from 'ws';
import { logger } from '../shared/logger.js';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface ProxyConnection {
  ws: WebSocket;
  close(): void;
}

// npm installs Codex on Windows as a codex.cmd shim, which only runs through a shell.
export function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; shell: boolean } {
  if (platform !== 'win32' || /[\\/]/.test(command) || path.extname(command)) return { file: command, shell: false };
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const ext of ['.exe', '.cmd']) {
    for (const dir of dirs) {
      const file = path.join(dir, command + ext);
      if (fs.existsSync(file)) return { file, shell: ext === '.cmd' };
    }
  }
  return { file: command, shell: false };
}

export const defaultSpawn: SpawnFn = (command, args) => {
  const { file, shell } = resolveCommand(command);
  if (shell) return spawn(`"${file}" ${args.join(' ')}`, { stdio: 'pipe', windowsHide: true, shell: true });
  return spawn(file, args, { stdio: 'pipe', windowsHide: true });
};

// The daemon control socket speaks WebSocket, not JSONL: `codex app-server proxy` only relays bytes.
export function connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn): Promise<ProxyConnection> {
  const child = spawnFn(command, ['app-server', 'proxy']);
  child.stdin?.on('error', () => {});
  child.stderr?.on('data', (d) => logger.debug(`codex proxy: ${String(d).trim()}`));

  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (child.stdin?.writable) child.stdin.write(chunk, callback);
      else callback();
    },
    final(callback) {
      child.stdin?.end();
      callback();
    },
  });
  child.stdout?.on('data', (d) => stream.push(d));
  child.stdout?.on('end', () => stream.push(null));
  Object.assign(stream, { setNoDelay() {}, setTimeout() {}, setKeepAlive() {}, ref() {}, unref() {} });

  const ws = new WebSocket('ws://localhost/', {
    createConnection: (() => stream) as unknown as ClientOptions['createConnection'],
  });
  const close = () => {
    ws.terminate();
    child.kill();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(err);
    };
    child.on('error', fail);
    child.once('exit', (code) => fail(new Error(`codex proxy exited (code ${code})`)));
    ws.on('error', fail);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      child.on('error', (err) => logger.warn(`codex proxy error: ${err.message}`));
      ws.on('error', (err) => logger.warn(`codex daemon socket error: ${err.message}`));
      resolve({ ws, close });
    });
  });
}
```

- [ ] **Step 6: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts` → PASS (Windows가 아니면 `codex.cmd` 테스트는 skip)
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 7: 커밋**

```bash
git add src/codex/transport.ts test/fixtures/fake-codex-proxy.mjs test/helpers/fake-codex-daemon.ts test/codex-transport.test.ts
git commit -m "feat(codex): connect to the app-server daemon through codex app-server proxy"
```

---

### Task 6: JSON-RPC 클라이언트

**Files:**
- Create: `src/codex/rpc.ts`
- Test: `test/codex-rpc.test.ts`

**Interfaces:**
- Consumes: `WebSocket` (Task 5의 `ProxyConnection.ws`)
- Produces: `class RpcError extends Error { code: number }`, `class RpcClient extends EventEmitter` — `constructor(ws, timeoutMs = 30000)`, `request<T>(method, params?): Promise<T>`, `notify(method, params?): void`; 이벤트 `'notification' (method: string, params: any)`, `'request' (id: number | string, method: string, params: any)`, `'close' ()`. Codex는 `jsonrpc` 필드를 생략하므로 보내지도 요구하지도 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-rpc.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RpcClient, RpcError } from '../src/codex/rpc.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: any[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
}

test('request resolves with the matching response', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const pending = rpc.request('thread/read', { threadId: 't' });
  assert.deepEqual(ws.sent[0], { id: 1, method: 'thread/read', params: { threadId: 't' } });
  ws.emit('message', JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
});

test('error responses reject with RpcError', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const pending = rpc.request('thread/resume', { threadId: 't' });
  ws.emit('message', JSON.stringify({ id: 1, error: { code: -32600, message: 'no rollout found' } }));
  await assert.rejects(pending, (err: unknown) => err instanceof RpcError && err.code === -32600 && /no rollout/.test(err.message));
});

test('server requests and notifications are emitted', () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  const seen: unknown[] = [];
  rpc.on('notification', (method, params) => seen.push(['n', method, params]));
  rpc.on('request', (id, method, params) => seen.push(['r', id, method, params]));
  ws.emit('message', JSON.stringify({ method: 'turn/started', params: { threadId: 't' } }));
  ws.emit('message', JSON.stringify({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } }));
  ws.emit('message', 'not json');
  assert.deepEqual(seen, [
    ['n', 'turn/started', { threadId: 't' }],
    ['r', 7, 'item/commandExecution/requestApproval', { threadId: 't' }],
  ]);
});

test('notify sends a message without id', () => {
  const ws = new FakeWs();
  new RpcClient(ws as any).notify('initialized');
  assert.deepEqual(ws.sent[0], { method: 'initialized' });
});

test('closing the socket rejects pending requests and emits close', async () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  let closed = false;
  rpc.on('close', () => { closed = true; });
  const pending = rpc.request('thread/loaded/list', {});
  ws.emit('close');
  await assert.rejects(pending, /closed/);
  assert.equal(closed, true);
});

test('requests time out', async () => {
  const rpc = new RpcClient(new FakeWs() as any, 20);
  await assert.rejects(rpc.request('initialize', {}), /timed out/);
});

test('request rejects immediately when the socket is not open', async () => {
  const ws = new FakeWs();
  ws.readyState = 3;
  await assert.rejects(new RpcClient(ws as any).request('initialize', {}), /closed/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-rpc.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/codex/rpc.ts`

```ts
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';

export type RpcId = number | string;

export class RpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();

  constructor(private ws: WebSocket, private timeoutMs = 30_000) {
    super();
    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.emit('request', msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      this.emit('notification', msg.method, msg.params);
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-rpc.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/rpc.ts test/codex-rpc.test.ts
git commit -m "feat(codex): JSON-RPC client for the app-server protocol"
```

---

### Task 7: Codex 대화 → Hub 세션 변환 함수

**Files:**
- Create: `src/codex/mapping.ts`
- Test: `test/codex-mapping.test.ts`

**Interfaces:**
- Consumes: `MessageSource`, `SessionStatus` (Task 1)
- Produces:
  - `type CodexThreadStatus = { type: 'notLoaded' | 'idle' | 'systemError' } | { type: 'active'; activeFlags: string[] }`
  - `interface CodexThread { id: string; name?: string | null; preview?: string; cwd: string; status: CodexThreadStatus; parentThreadId?: string | null; ephemeral?: boolean }`
  - `interface AgentMessage { text: string; phase?: string | null }`
  - `codexSessionId(threadId: string): string` → `codex:<threadId>`
  - `isTrackable(thread): boolean`, `threadTitle(thread): string`, `hubStatus(status): SessionStatus`, `withSourcePrefix(content, source?): string`, `finalAnswer(messages: AgentMessage[]): string | null`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-mapping.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexSessionId, finalAnswer, hubStatus, isTrackable, threadTitle, withSourcePrefix, type CodexThread } from '../src/codex/mapping.js';

const thread = (extra: Partial<CodexThread> = {}): CodexThread => ({ id: '01a0f656-434c', name: null, preview: '', cwd: 'C:\\tmp\\codex-test', status: { type: 'idle' }, ...extra });

test('codexSessionId prefixes the thread id', () => {
  assert.equal(codexSessionId('abc'), 'codex:abc');
});

test('only loaded top-level persistent threads are tracked', () => {
  assert.equal(isTrackable(thread()), true);
  assert.equal(isTrackable(thread({ status: { type: 'active', activeFlags: [] } })), true);
  assert.equal(isTrackable(thread({ status: { type: 'notLoaded' } })), false);
  assert.equal(isTrackable(thread({ parentThreadId: 'parent' })), false);
  assert.equal(isTrackable(thread({ ephemeral: true })), false);
});

test('threadTitle prefers the name, then a trimmed preview, then the folder', () => {
  assert.equal(threadTitle(thread({ name: '  Fix login  ' })), 'Fix login');
  assert.equal(threadTitle(thread({ preview: 'Write the release notes\nfor version two' })), 'Write the release notes for ve…');
  assert.equal(threadTitle(thread({ preview: 'short' })), 'short');
  assert.equal(threadTitle(thread()), 'codex-test');
  assert.equal(threadTitle(thread({ cwd: '' })), '01a0f656');
});

test('hubStatus maps Codex thread status', () => {
  assert.equal(hubStatus({ type: 'idle' }), 'idle');
  assert.equal(hubStatus({ type: 'systemError' }), 'idle');
  assert.equal(hubStatus({ type: 'notLoaded' }), 'idle');
  assert.equal(hubStatus({ type: 'active', activeFlags: [] }), 'working');
  assert.equal(hubStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'waiting_input');
  assert.equal(hubStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'waiting_input');
});

test('withSourcePrefix marks where the instruction came from', () => {
  assert.equal(withSourcePrefix('run tests', 'dashboard'), '[claude-alarm · Dashboard] run tests');
  assert.equal(withSourcePrefix('run tests', 'telegram'), '[claude-alarm · Telegram] run tests');
  assert.equal(withSourcePrefix('run tests', 'api'), '[claude-alarm · API] run tests');
  assert.equal(withSourcePrefix('run tests'), '[claude-alarm] run tests');
});

test('finalAnswer joins final answers and falls back to the last message', () => {
  assert.equal(finalAnswer([{ text: 'looking', phase: 'commentary' }, { text: 'done', phase: 'final_answer' }]), 'done');
  assert.equal(finalAnswer([{ text: 'a', phase: 'final_answer' }, { text: 'b', phase: 'final_answer' }]), 'a\n\nb');
  assert.equal(finalAnswer([{ text: 'first' }, { text: 'last' }]), 'last');
  assert.equal(finalAnswer([]), null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-mapping.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `src/codex/mapping.ts`

```ts
import type { MessageSource, SessionStatus } from '../shared/types.js';

export type CodexThreadStatus =
  | { type: 'notLoaded' | 'idle' | 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  status: CodexThreadStatus;
  parentThreadId?: string | null;
  ephemeral?: boolean;
}

export interface AgentMessage {
  text: string;
  phase?: string | null;
}

const TITLE_MAX = 30;
const SOURCE_LABEL: Record<MessageSource, string> = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

export function codexSessionId(threadId: string): string {
  return `codex:${threadId}`;
}

export function isTrackable(thread: CodexThread): boolean {
  return !thread.parentThreadId && !thread.ephemeral && thread.status.type !== 'notLoaded';
}

export function threadTitle(thread: CodexThread): string {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = (thread.preview ?? '').replace(/\s+/g, ' ').trim();
  if (preview) return preview.length > TITLE_MAX ? `${preview.slice(0, TITLE_MAX)}…` : preview;
  return thread.cwd.replace(/^.*[/\\]/, '') || thread.id.slice(0, 8);
}

export function hubStatus(status: CodexThreadStatus): SessionStatus {
  if (status.type !== 'active') return 'idle';
  return status.activeFlags.some((f) => f === 'waitingOnApproval' || f === 'waitingOnUserInput') ? 'waiting_input' : 'working';
}

export function withSourcePrefix(content: string, source?: MessageSource): string {
  return source ? `[claude-alarm · ${SOURCE_LABEL[source]}] ${content}` : `[claude-alarm] ${content}`;
}

export function finalAnswer(messages: AgentMessage[]): string | null {
  const finals = messages.filter((m) => m.phase === 'final_answer').map((m) => m.text);
  if (finals.length) return finals.join('\n\n');
  return messages.at(-1)?.text ?? null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-mapping.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/mapping.ts test/codex-mapping.test.ts
git commit -m "feat(codex): map Codex threads to hub sessions"
```

---

### Task 8: HubClient — 등록 정보 확장, 재등록, 끊은 뒤 재연결 금지

**Files:**
- Modify: `src/channel/hub-client.ts`
- Test: `test/hub-client.test.ts`

**Interfaces:**
- Consumes: `SessionInfo` (Task 1)
- Produces: `new HubClient(sessionId, sessionName, hubHost?, hubPort?, token?, getPeerName?, getRegistration?: () => Partial<SessionInfo>)` — `getRegistration()` 결과가 기본 등록 정보를 덮어쓴다. `reregister(): void` — 연결돼 있으면 현재 등록 정보를 다시 보낸다. `disconnect()` 뒤에는 재연결하지 않는다. 기존 Claude 채널 호출(인자 6개)은 동작 그대로.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/hub-client.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HubServer } from '../src/hub/server.js';
import { HubClient } from '../src/channel/hub-client.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7993;
const TOKEN = 'client-test';
const config = { hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any;
let hub: HubServer;

before(async () => { hub = new HubServer(config); await hub.start(); });
after(async () => { await hub.stop(); });

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

test('registration extras are sent and can be refreshed', async () => {
  let title = 'First';
  const client = new HubClient('x1', 'x1', '127.0.0.1', PORT, TOKEN, () => undefined, () => ({ agentKind: 'codex', title, cwd: 'C:\\w\\proj', status: 'working' }));
  client.connect();
  try {
    const first = await until(async () => (await sessions()).find((s) => s.id === 'x1'));
    assert.equal(first.agentKind, 'codex');
    assert.equal(first.displayName, 'First');
    assert.equal(first.cwd, 'C:\\w\\proj');
    assert.equal(first.status, 'working');
    title = 'Second';
    client.reregister();
    await until(async () => (await sessions()).find((s) => s.id === 'x1' && s.displayName === 'Second'));
  } finally {
    client.disconnect();
  }
});

test('disconnect does not schedule a reconnect', async () => {
  const client = new HubClient('x2', 'x2', '127.0.0.1', PORT, TOKEN);
  client.connect();
  await until(async () => (await sessions()).find((s) => s.id === 'x2'));
  client.disconnect();
  await until(async () => !(await sessions()).some((s) => s.id === 'x2'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((client as any).reconnectTimer, null);
});

test('a hub restart re-registers the session with its extras', async () => {
  const client = new HubClient('x3', 'x3', '127.0.0.1', PORT, TOKEN, () => undefined, () => ({ title: 'Kept' }));
  client.connect();
  try {
    await until(async () => (await sessions()).find((s) => s.id === 'x3'));
    await hub.stop();
    hub = new HubServer(config);
    await hub.start();
    const back = await until(async () => (await sessions()).find((s) => s.id === 'x3'), 9000);
    assert.equal(back.displayName, 'Kept');
  } finally {
    client.disconnect();
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-client.test.ts`
Expected: FAIL — 첫 테스트 `agentKind`가 `undefined`(인자 무시), 두 번째 `reconnectTimer`가 남음.

- [ ] **Step 3: 구현** — `src/channel/hub-client.ts`

import에 `SessionInfo`가 이미 있다. 필드와 생성자:

```ts
  private connected = false;
  private closed = false;

  constructor(
    private sessionId: string,
    private sessionName: string,
    private hubHost = DEFAULT_HUB_HOST,
    private hubPort = DEFAULT_HUB_PORT,
    private token?: string,
    private getPeerName: () => string | undefined = () => undefined,
    private getRegistration: () => Partial<SessionInfo> = () => ({}),
  ) {}
```

`connect()` 첫 줄에 `this.closed = false;`를 추가하고, `'open'` 핸들러의 등록 부분(`// Register this session`부터 `this.ws!.send(JSON.stringify(registration));`까지)을 교체:

```ts
        this.ws!.send(JSON.stringify(this.registration()));
```

`'close'` 핸들러:

```ts
      this.ws.on('close', () => {
        logger.info('Disconnected from hub');
        this.connected = false;
        if (!this.closed) this.scheduleReconnect();
      });
```

`disconnect()` 첫 줄에 `this.closed = true;`를 추가한다. 클래스에 메서드 추가:

```ts
  reregister(): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(this.registration()));
    }
  }

  private registration(): ChannelMessage {
    return {
      type: 'register',
      session: {
        id: this.sessionId,
        name: this.sessionName,
        status: 'idle',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        cwd: process.cwd(),
        channelEnabled: true,
        peerName: this.getPeerName(),
        ...this.getRegistration(),
      },
    };
  }
```

`scheduleReconnect()` 첫 줄을 `if (this.reconnectTimer || this.closed) return;`로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-client.test.ts` → PASS (세 번째 테스트는 재연결 5초 대기로 수 초 걸림)
Run: `npx tsc --noEmit` → 오류 없음
Run: `npm test` → 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/channel/hub-client.ts test/hub-client.test.ts
git commit -m "feat(channel): hub client registration extras, re-register and final disconnect"
```

---

### Task 9: CodexAdapter — 발견·세션 등록·상태·구독

**Files:**
- Create: `src/codex/adapter.ts`
- Test: `test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `connectProxy`, `SpawnFn`, `ProxyConnection` (Task 5), `RpcClient` (Task 6), mapping 함수·타입 (Task 7), `HubClient`(7번째 인자 `getRegistration`, `reregister()`, `disconnect()`) (Task 8), `CHANNEL_SERVER_VERSION` (`src/shared/constants.ts`)
- Produces: `interface CodexAdapterOptions { command: string; hub: { host: string; port: number; token?: string }; spawnFn?: SpawnFn; reconnectMinMs?: number; reconnectMaxMs?: number }`, `class CodexAdapter { constructor(opts); start(): void; stop(): void }`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-adapter.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7994;
const TOKEN = 'codex-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  await hub.start();
});
after(async () => { await hub.stop(); });
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

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

const session = (id: string, pred: (s: any) => boolean = () => true) =>
  until(async () => (await sessions()).find((s) => s.id === id && pred(s)));

async function startAdapter(threads: any[], setup?: (d: FakeDaemon) => void): Promise<FakeDaemon> {
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
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  setup?.(d);
  adapter = new CodexAdapter({ command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200 });
  adapter.start();
  return d;
}

function openDashboard(): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

test('loaded threads become Codex sessions and are subscribed without overrides', async () => {
  const d = await startAdapter([thread('t1'), thread('sub', { parentThreadId: 't1' })]);
  const s = await session('codex:t1');
  assert.equal(s.agentKind, 'codex');
  assert.equal(s.displayName, 'Thread t1');
  assert.equal(s.cwd, 'C:\\w\\proj');
  assert.equal(s.status, 'idle');
  await until(() => d.calls('thread/resume').length > 0);
  assert.deepEqual(d.calls('thread/resume').map((c) => c.params), [{ threadId: 't1', excludeTurns: true }]);
  assert.ok(!(await sessions()).some((x) => x.id === 'codex:sub'));
});

test('status changes are mirrored and notLoaded removes the session', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  await session('codex:t1', (s) => s.status === 'waiting_input');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await session('codex:t1', (s) => s.status === 'working');
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'notLoaded' } });
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t1'));
});

test('renamed and newly started threads are picked up, closed ones dropped', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.notify('thread/name/updated', { threadId: 't1', threadName: 'Renamed' });
  await session('codex:t1', (s) => s.displayName === 'Renamed');
  d.notify('thread/started', { thread: thread('t2', { name: null, preview: 'Write the release notes for version two' }) });
  const s2 = await session('codex:t2');
  assert.equal(s2.displayName, 'Write the release notes for ve…');
  d.notify('thread/closed', { threadId: 't2' });
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t2'));
});

test('a brand-new thread is subscribed once it has a rollout', async () => {
  let ready = false;
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    if (!ready) throw new Error('no rollout found for thread id t1');
    return {};
  }));
  await session('codex:t1');
  await until(() => d.calls('thread/resume').length === 1);
  ready = true;
  d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } });
  await until(() => d.calls('thread/resume').length === 2);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/adapter.js'`

- [ ] **Step 3: 구현** — `src/codex/adapter.ts`

```ts
import { HubClient } from '../channel/hub-client.js';
import { CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { NotifyLevel, SessionInfo } from '../shared/types.js';
import { connectProxy, type ProxyConnection, type SpawnFn } from './transport.js';
import { RpcClient } from './rpc.js';
import {
  codexSessionId,
  hubStatus,
  isTrackable,
  threadTitle,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';

export interface CodexAdapterOptions {
  command: string;
  hub: { host: string; port: number; token?: string };
  spawnFn?: SpawnFn;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

interface Tracked {
  thread: CodexThread;
  hub: HubClient;
  subscribed: boolean;
  subscribing: boolean;
  turns: Map<string, AgentMessage[]>;
}

export class CodexAdapter {
  private conn?: ProxyConnection;
  private rpc?: RpcClient;
  private threads = new Map<string, Tracked>();
  private stopped = false;

  constructor(private opts: CodexAdapterOptions) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.threads.keys()]) this.drop(id);
    this.conn?.close();
  }

  private async connect(): Promise<void> {
    let rpc: RpcClient | undefined;
    try {
      const conn = await connectProxy(this.opts.command, this.opts.spawnFn);
      if (this.stopped) {
        conn.close();
        return;
      }
      const live = new RpcClient(conn.ws);
      rpc = live;
      live.on('notification', (method: string, params: any) => this.onNotification(method, params));
      live.on('close', () => {
        if (this.rpc === live) this.onDaemonLost();
      });
      this.conn = conn;
      this.rpc = live;
      const init = await live.request<{ userAgent?: string }>('initialize', {
        clientInfo: { name: 'claude-alarm', version: CHANNEL_SERVER_VERSION },
      });
      live.notify('initialized');
      logger.info(`Connected to Codex daemon (${init.userAgent ?? 'unknown version'})`);
      await this.discover();
    } catch (err) {
      logger.warn(`Codex daemon connection failed: ${(err as Error).message}`);
      if (rpc && this.rpc === rpc) {
        this.rpc = undefined;
        this.conn?.close();
        this.conn = undefined;
      }
    }
  }

  private onDaemonLost(): void {
    this.rpc = undefined;
    this.conn = undefined;
    for (const id of [...this.threads.keys()]) this.drop(id);
  }

  private async discover(): Promise<void> {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.rpc!.request<{ data: string[]; nextCursor?: string | null }>(
        'thread/loaded/list',
        cursor ? { cursor } : {},
      );
      ids.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) await this.refresh(id);
  }

  private async refresh(threadId: string): Promise<void> {
    try {
      const { thread } = await this.rpc!.request<{ thread: CodexThread }>('thread/read', { threadId, includeTurns: false });
      this.upsert(thread);
    } catch (err) {
      logger.debug(`thread/read ${threadId} failed: ${(err as Error).message}`);
    }
  }

  private upsert(thread: CodexThread): void {
    if (!isTrackable(thread)) {
      this.drop(thread.id);
      return;
    }
    const existing = this.threads.get(thread.id);
    if (existing) {
      existing.thread = thread;
      existing.hub.reregister();
    } else {
      const { host, port, token } = this.opts.hub;
      const hub = new HubClient(codexSessionId(thread.id), threadTitle(thread), host, port, token, () => undefined, () =>
        this.registration(thread.id),
      );
      this.threads.set(thread.id, { thread, hub, subscribed: false, subscribing: false, turns: new Map() });
      hub.connect();
    }
    void this.subscribe(thread.id);
  }

  private registration(threadId: string): Partial<SessionInfo> {
    const t = this.threads.get(threadId);
    if (!t) return {};
    const title = threadTitle(t.thread);
    return { name: title, title, cwd: t.thread.cwd, agentKind: 'codex', status: hubStatus(t.thread.status) };
  }

  private async subscribe(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t || t.subscribed || t.subscribing || !this.rpc) return;
    t.subscribing = true;
    try {
      // Only these two fields: any other resume field overrides the user's own thread settings.
      await this.rpc.request('thread/resume', { threadId, excludeTurns: true });
      t.subscribed = true;
    } catch (err) {
      logger.debug(`thread/resume ${threadId} deferred: ${(err as Error).message}`);
    } finally {
      t.subscribing = false;
    }
  }

  private drop(threadId: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    this.threads.delete(threadId);
    t.hub.disconnect();
  }

  private onNotification(method: string, params: any): void {
    switch (method) {
      case 'thread/started':
        this.upsert(params.thread);
        break;
      case 'thread/status/changed':
        this.onStatus(params.threadId, params.status);
        break;
      case 'thread/name/updated': {
        const t = this.threads.get(params.threadId);
        if (t) {
          t.thread.name = params.threadName;
          t.hub.reregister();
        }
        break;
      }
      case 'thread/closed':
      case 'thread/archived':
      case 'thread/deleted':
        this.drop(params.threadId);
        break;
    }
  }

  private onStatus(threadId: string, status: CodexThreadStatus): void {
    const t = this.threads.get(threadId);
    if (!t) {
      if (status.type !== 'notLoaded') void this.refresh(threadId);
      return;
    }
    if (status.type === 'notLoaded') {
      this.drop(threadId);
      return;
    }
    t.thread.status = status;
    t.hub.send({ type: 'status', sessionId: codexSessionId(threadId), status: hubStatus(status) });
    if (status.type === 'systemError') this.notify(threadId, 'Codex error', 'The Codex conversation hit a system error.', 'error');
    void this.subscribe(threadId);
  }

  private notify(threadId: string, title: string, message: string, level: NotifyLevel): void {
    this.threads.get(threadId)?.hub.send({ type: 'notify', sessionId: codexSessionId(threadId), title, message, level });
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts
git commit -m "feat(codex): adapter registers Codex threads as hub sessions"
```

---

### Task 10: CodexAdapter — 응답 전달·지시·승인 대기 알림

**Files:**
- Modify: `src/codex/adapter.ts`
- Test: `test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `finalAnswer`, `withSourcePrefix` (Task 7), `HubClient.onMessage` (기존), `ChannelMessage`·`MessageSource` (Task 1)
- Produces: 동작만 추가 — 턴 완료 → `reply`, 실패/중단 → `notify`, `message_to_session` → `turn/start`(idle만), `image_to_session` → 경고, 승인 요청 → 경고 `notify`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-adapter.test.ts` 끝에 추가

```ts
test('final answers are relayed as replies', async () => {
  const d = await startAdapter([thread('t1')]);
  await until(() => d.calls('thread/resume').length > 0);
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm1', text: 'Looking into it', phase: 'commentary' } });
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm2', text: 'Done: tests pass', phase: 'final_answer' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => dash.inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === 'codex:t1'));
    assert.equal(reply.content, 'Done: tests pass');
  } finally {
    dash.ws.close();
  }
});

test('failed turns raise an error notification', async () => {
  const d = await startAdapter([thread('t1')]);
  await until(() => d.calls('thread/resume').length > 0);
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u2', status: 'failed', items: [], error: { message: 'usage limit reached' } } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'error');
    assert.match(n.message, /usage limit reached/);
  } finally {
    dash.ws.close();
  }
});

test('dashboard messages start a turn with a source prefix', async () => {
  const d = await startAdapter([thread('t1')]);
  await until(() => d.calls('thread/resume').length > 0);
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'run the tests' }));
    await until(() => d.calls('turn/start').length > 0);
    assert.deepEqual(d.calls('turn/start')[0].params, {
      threadId: 't1',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] run the tests' }],
    });
  } finally {
    dash.ws.close();
  }
});

test('messages to a thread waiting for approval are refused, not queued', async () => {
  const d = await startAdapter([thread('t1')]);
  await until(() => d.calls('thread/resume').length > 0);
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await session('codex:t1', (s) => s.status === 'waiting_input');
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello?' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.match(n.message, /busy/);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await session('codex:t1', (s) => s.status === 'idle');
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('approval requests raise a warning that names the command', async () => {
  const d = await startAdapter([thread('t1')]);
  await until(() => d.calls('thread/resume').length > 0);
  const dash = await openDashboard();
  try {
    d.serverRequest(90, 'item/commandExecution/requestApproval', {
      threadId: 't1',
      turnId: 'u3',
      itemId: 'i1',
      command: '"powershell.exe" -Command \'curl.exe https://example.com\'',
      commandActions: [{ type: 'unknown', command: 'curl.exe https://example.com' }],
    });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Codex approval needed');
    assert.match(n.message, /curl\.exe https:\/\/example\.com/);
  } finally {
    dash.ws.close();
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: 새 테스트 5개 FAIL(시간 초과 `condition not met in time`), 기존 4개 PASS.

- [ ] **Step 3: 구현** — `src/codex/adapter.ts`

import를 바꾼다:

```ts
import type { ChannelMessage, MessageSource, NotifyLevel, SessionInfo } from '../shared/types.js';
```

```ts
import {
  codexSessionId,
  finalAnswer,
  hubStatus,
  isTrackable,
  threadTitle,
  withSourcePrefix,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';
```

클래스 위에 추가:

```ts
const APPROVAL_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'mcpServer/elicitation/request',
]);
```

`connect()`에서 `live.on('notification', ...)` 다음 줄에 추가:

```ts
      live.on('request', (_id: unknown, method: string, params: any) => this.onServerRequest(method, params));
```

`upsert()`의 `hub.connect();` 바로 앞에 추가:

```ts
      hub.onMessage((msg) => this.onHubMessage(thread.id, msg));
```

`onNotification`의 `switch`에 case 추가:

```ts
      case 'item/completed':
        if (params.item?.type === 'agentMessage') this.collect(params.threadId, params.turnId, params.item);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params.threadId, params.turn);
        break;
```

클래스에 메서드 추가:

```ts
  private collect(threadId: string, turnId: string, item: AgentMessage): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    const list = t.turns.get(turnId) ?? [];
    list.push({ text: item.text, phase: item.phase });
    t.turns.set(turnId, list);
  }

  private onTurnCompleted(
    threadId: string,
    turn: { id: string; status: string; error?: { message: string } | null; items?: Array<{ type: string } & AgentMessage> },
  ): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    const collected = t.turns.get(turn.id) ?? [];
    t.turns.delete(turn.id);
    if (turn.status === 'failed' || turn.error) {
      this.notify(threadId, 'Codex task failed', turn.error?.message ?? 'The task ended with an error.', 'error');
      return;
    }
    if (turn.status === 'interrupted') {
      this.notify(threadId, 'Codex task stopped', 'The task was interrupted.', 'info');
      return;
    }
    // turn/completed may carry only a summary of the items, so prefer what was collected live.
    const fromTurn = (turn.items ?? []).filter((i) => i.type === 'agentMessage');
    const text = finalAnswer(collected.length ? collected : fromTurn);
    if (text) t.hub.send({ type: 'reply', sessionId: codexSessionId(threadId), content: text });
  }

  private onHubMessage(threadId: string, msg: ChannelMessage): void {
    if (msg.type === 'message_to_session') {
      void this.sendTurn(threadId, msg.content, msg.source);
    } else if (msg.type === 'image_to_session') {
      this.notify(threadId, 'Not delivered', 'Codex sessions do not accept images yet.', 'warning');
    }
  }

  private async sendTurn(threadId: string, content: string, source?: MessageSource): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (t.thread.status.type !== 'idle') {
      this.notify(threadId, 'Not delivered', 'Codex is busy, so the message was not delivered. Send it again when the task finishes.', 'warning');
      return;
    }
    try {
      if (!this.rpc) throw new Error('not connected to the Codex daemon');
      await this.subscribe(threadId);
      await this.rpc.request('turn/start', { threadId, input: [{ type: 'text', text: withSourcePrefix(content, source) }] });
    } catch (err) {
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }

  private onServerRequest(method: string, params: any): void {
    if (!APPROVAL_REQUESTS.has(method) || !params?.threadId) {
      logger.debug(`Ignoring Codex server request ${method}`);
      return;
    }
    const detail = params.commandActions?.[0]?.command ?? params.command ?? params.reason ?? params.message ?? method;
    this.notify(params.threadId, 'Codex approval needed', `Approve or decline in Codex: ${String(detail).slice(0, 300)}`, 'warning');
  }
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts` → 9개 PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts
git commit -m "feat(codex): relay Codex replies and send dashboard messages to idle threads"
```

---

### Task 11: CodexAdapter — 데몬 끊김 처리와 재연결

**Files:**
- Modify: `src/codex/adapter.ts`
- Test: `test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexAdapterOptions.reconnectMinMs`(기본 2000), `reconnectMaxMs`(기본 60000)
- Produces: 데몬 연결이 끊기거나 연결에 실패하면 모든 Codex 세션을 닫고 `min`부터 두 배씩(최대 `max`) 기다려 다시 연결·발견한다. 연결에 성공하면 간격을 `min`으로 되돌린다. `stop()` 뒤에는 재시도하지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-adapter.test.ts`

import에 추가: `import { spawn } from 'node:child_process';`

끝에 추가:

```ts
test('losing the daemon removes Codex sessions and reconnecting restores them', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  d.dropClient();
  await until(async () => !(await sessions()).some((x) => x.id === 'codex:t1'));
  await until(() => d.connections === 2, 5000);
  await session('codex:t1');
});

test('a missing Codex binary is retried without crashing', async () => {
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex',
    hub: HUB,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    spawnFn: () => {
      attempts++;
      return spawn('claude-alarm-no-such-codex-binary', [], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 3000);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: 새 테스트 2개 FAIL(시간 초과), 기존 9개 PASS.

- [ ] **Step 3: 구현** — `src/codex/adapter.ts`

필드와 생성자:

```ts
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private delay: number;

  constructor(private opts: CodexAdapterOptions) {
    this.delay = opts.reconnectMinMs ?? 2000;
  }
```

`stop()`:

```ts
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const id of [...this.threads.keys()]) this.drop(id);
    this.conn?.close();
  }
```

`connect()`에서 `logger.info(\`Connected to Codex daemon ...\`)` 다음 줄에 추가:

```ts
      this.delay = this.opts.reconnectMinMs ?? 2000;
```

`connect()`의 `catch` 블록 끝에 추가:

```ts
      this.scheduleRetry();
```

`onDaemonLost()`를 교체하고 `scheduleRetry()`를 추가:

```ts
  private onDaemonLost(): void {
    this.rpc = undefined;
    this.conn = undefined;
    for (const id of [...this.threads.keys()]) this.drop(id);
    if (!this.stopped) logger.warn('Codex daemon connection lost');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.reconnectMaxMs ?? 60_000);
  }
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts` → 11개 PASS
Run: `npx tsc --noEmit` → 오류 없음
Run: `npm test` → 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts
git commit -m "feat(codex): reconnect to the daemon with backoff"
```

---

### Task 12: 어댑터 진입점 · Hub 감독 · 빌드

**Files:**
- Modify: `src/shared/constants.ts`
- Create: `src/codex/main.ts`
- Create: `src/hub/codex-supervisor.ts`
- Modify: `src/hub/server.ts` — 필드, 생성자, `start()`, `stop()`
- Modify: `tsup.config.ts`
- Test: `test/codex-supervisor.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter` (Task 9–11), `AppConfig.codex` (Task 1)
- Produces:
  - `CODEX_PID_FILE`, `CODEX_LOG_FILE` (`src/shared/constants.ts`)
  - `type SupervisorSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess`
  - `resolveAdapterScript(baseDir: string): string | undefined`
  - `class CodexSupervisor { constructor(script: string, spawnFn?: SupervisorSpawn, minDelayMs = 2000, maxDelayMs = 60000); start(): void; stop(): void }` — 자식을 `[script, '--watch-stdin']`로 띄우고, 0이 아닌 종료 코드면 백오프 후 재시작(종료 코드 0은 재시작 안 함, 60초 넘게 살았으면 간격 초기화)
  - 빌드 산출물 `dist/codex/main.js`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-supervisor.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSupervisor, resolveAdapterScript } from '../src/hub/codex-supervisor.js';

class FakeChild extends EventEmitter {
  ended = false;
  killed = false;
  stdin = { end: () => { this.ended = true; } };
  kill() { this.killed = true; return true; }
}

function harness() {
  const children: FakeChild[] = [];
  const args: string[][] = [];
  const sup = new CodexSupervisor('/x/codex/main.js', (_cmd, a) => {
    args.push(a);
    const c = new FakeChild();
    children.push(c);
    return c as any;
  }, 10, 40);
  return { sup, children, args };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('launches the adapter with stdin watching', () => {
  const { sup, args } = harness();
  sup.start();
  assert.deepEqual(args[0], ['/x/codex/main.js', '--watch-stdin']);
  sup.stop();
});

test('restarts after a crash', async () => {
  const { sup, children } = harness();
  sup.start();
  children[0].emit('exit', 1, null);
  await sleep(30);
  assert.equal(children.length, 2);
  sup.stop();
});

test('a clean exit is not restarted', async () => {
  const { sup, children } = harness();
  sup.start();
  children[0].emit('exit', 0, null);
  await sleep(30);
  assert.equal(children.length, 1);
  sup.stop();
});

test('stop closes stdin, kills the child and never restarts', async () => {
  const { sup, children } = harness();
  sup.start();
  sup.stop();
  assert.equal(children[0].ended, true);
  assert.equal(children[0].killed, true);
  children[0].emit('exit', null, 'SIGTERM');
  await sleep(30);
  assert.equal(children.length, 1);
});

test('resolveAdapterScript finds the adapter next to the hub or the bundled CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-dist-'));
  fs.mkdirSync(path.join(root, 'hub'));
  assert.equal(resolveAdapterScript(path.join(root, 'hub')), undefined);
  fs.mkdirSync(path.join(root, 'codex'));
  fs.writeFileSync(path.join(root, 'codex', 'main.js'), '');
  assert.equal(resolveAdapterScript(path.join(root, 'hub')), path.join(root, 'codex', 'main.js'));
  assert.equal(resolveAdapterScript(root), path.join(root, 'codex', 'main.js'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-supervisor.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 상수 추가** — `src/shared/constants.ts`의 `UPLOADS_DIR` 다음

```ts
export const CODEX_PID_FILE = path.join(CONFIG_DIR, 'codex.pid');
export const CODEX_LOG_FILE = path.join(CONFIG_DIR, 'codex.log');
```

- [ ] **Step 4: 감독 모듈 구현** — `src/hub/codex-supervisor.ts`

```ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../shared/logger.js';

export type SupervisorSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const HEALTHY_RUN_MS = 60_000;

// dist/hub/server.js runs standalone, but dist/cli.js bundles the hub inline, so both layouts occur.
export function resolveAdapterScript(baseDir: string): string | undefined {
  return [path.join(baseDir, '..', 'codex', 'main.js'), path.join(baseDir, 'codex', 'main.js')].find((p) => fs.existsSync(p));
}

export class CodexSupervisor {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private delay: number;

  constructor(
    private script: string,
    private spawnFn: SupervisorSpawn = spawn,
    private minDelayMs = 2000,
    private maxDelayMs = 60_000,
  ) {
    this.delay = minDelayMs;
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
  }

  private launch(): void {
    const startedAt = Date.now();
    const child = this.spawnFn(process.execPath, [this.script, '--watch-stdin'], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    this.child = child;
    child.on('error', (err) => logger.warn(`Codex adapter failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped || code === 0) return;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.delay = this.minDelayMs;
      logger.warn(`Codex adapter exited (${signal ?? code}); restarting in ${this.delay}ms`);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.stopped) this.launch();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelayMs);
    });
  }
}
```

- [ ] **Step 5: 진입점 구현** — `src/codex/main.ts`

```ts
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { CODEX_PID_FILE, DEFAULT_HUB_HOST } from '../shared/constants.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import { logger } from '../shared/logger.js';
import { CodexAdapter } from './adapter.js';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

installCrashGuard('codex adapter');
const config = loadConfig();

const existing = fs.existsSync(CODEX_PID_FILE) ? parseInt(fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim(), 10) : NaN;
if (!Number.isNaN(existing) && existing !== process.pid && isRunning(existing)) {
  logger.info(`Codex adapter already running (PID: ${existing})`);
  process.exit(0);
}
fs.writeFileSync(CODEX_PID_FILE, String(process.pid), 'utf-8');
logStartup('Codex adapter');

const host = process.env.CLAUDE_ALARM_HUB_HOST ?? (config.hub.host === '0.0.0.0' ? DEFAULT_HUB_HOST : config.hub.host);
const port = process.env.CLAUDE_ALARM_HUB_PORT ? parseInt(process.env.CLAUDE_ALARM_HUB_PORT, 10) : config.hub.port;
const token = process.env.CLAUDE_ALARM_HUB_TOKEN ?? config.hub.token;

const adapter = new CodexAdapter({ command: config.codex?.command ?? 'codex', hub: { host, port, token } });
adapter.start();

let exiting = false;
const shutdown = () => {
  if (exiting) return;
  exiting = true;
  adapter.stop();
  try {
    if (fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim() === String(process.pid)) fs.unlinkSync(CODEX_PID_FILE);
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// On Windows `hub stop` kills the hub without running its exit handlers, so stdin EOF is the only sign the parent is gone.
if (process.argv.includes('--watch-stdin')) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
```

- [ ] **Step 6: Hub 배선** — `src/hub/server.ts`

import 추가:

```ts
import { CodexSupervisor, resolveAdapterScript } from './codex-supervisor.js';
```

필드(`private token?: string;` 다음):

```ts
  private codexEnabled: boolean;
  private codexSupervisor?: CodexSupervisor;
```

생성자 첫 부분(`this.token = config?.hub?.token;` 다음):

```ts
    this.codexEnabled = config?.codex?.enabled === true;
```

`start()`의 listen 콜백에서 `resolve();` 바로 앞:

```ts
        this.startCodexAdapter();
```

`stop()`의 `return new Promise((resolve) => {` 바로 다음:

```ts
      this.codexSupervisor?.stop();
      this.codexSupervisor = undefined;
```

메서드 추가(`startHeartbeat()` 앞):

```ts
  private startCodexAdapter(): void {
    if (!this.codexEnabled) return;
    const script = resolveAdapterScript(__dirname);
    if (!script) {
      logger.warn('Codex adapter is enabled but codex/main.js was not found next to the hub');
      return;
    }
    this.codexSupervisor = new CodexSupervisor(script);
    this.codexSupervisor.start();
    logger.info('Codex adapter started');
  }
```

- [ ] **Step 7: 빌드 진입점** — `tsup.config.ts`의 세 번째 블록(Hub server) `entry`를 바꾼다:

```ts
    entry: {
      'hub/server': 'src/hub/server.ts',
      'codex/main': 'src/codex/main.ts',
    },
```

- [ ] **Step 8: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-supervisor.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음
Run: `npm run build` → 성공, `ls dist/codex/main.js` 존재
Run: `npm test` → 전체 PASS (테스트의 Hub는 `codex.enabled`가 없으므로 어댑터를 띄우지 않는다)

- [ ] **Step 9: 커밋**

```bash
git add src/shared/constants.ts src/codex/main.ts src/hub/codex-supervisor.ts src/hub/server.ts tsup.config.ts test/codex-supervisor.test.ts
git commit -m "feat(hub): launch and supervise the Codex adapter when enabled"
```

---

### Task 13: CLI `codex` 명령 · 설정 헬퍼 · README

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/cli.ts` — import, `printUsage`, 새 함수, `main()`
- Modify: `README.md` — Features, CLI Commands 표, 새 "Codex Sessions" 절(`## Permission Relay` 앞)
- Test: `test/codex-config.test.ts`

**Interfaces:**
- Consumes: `CODEX_PID_FILE`, `CODEX_LOG_FILE` (Task 12), `AppConfig.codex` (Task 1)
- Produces: `setCodexEnabled(enabled: boolean): AppConfig` (`src/shared/config.ts`) — 기존 `codex.command`는 유지. CLI `claude-alarm codex enable|disable|start|stop|status`.

- [ ] **Step 1: 실패하는 테스트 작성** — `test/codex-config.test.ts`

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig, setCodexEnabled } from '../src/shared/config.js';

test('setCodexEnabled toggles the flag and keeps the command', () => {
  const config = loadConfig();
  config.codex = { enabled: false, command: 'C:/tools/codex.exe' };
  saveConfig(config);
  setCodexEnabled(true);
  assert.deepEqual(loadConfig().codex, { enabled: true, command: 'C:/tools/codex.exe' });
  setCodexEnabled(false);
  assert.deepEqual(loadConfig().codex, { enabled: false, command: 'C:/tools/codex.exe' });
});

test('setCodexEnabled works without an existing codex section', () => {
  const config = loadConfig();
  delete config.codex;
  saveConfig(config);
  setCodexEnabled(true);
  assert.equal(loadConfig().codex?.enabled, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-config.test.ts`
Expected: FAIL — `setCodexEnabled` export 없음.

- [ ] **Step 3: 설정 헬퍼** — `src/shared/config.ts`의 `saveConfig` 다음

```ts
export function setCodexEnabled(enabled: boolean): AppConfig {
  const config = loadConfig();
  config.codex = { ...config.codex, enabled };
  saveConfig(config);
  return config;
}
```

- [ ] **Step 4: CLI** — `src/cli.ts`

import 두 줄을 바꾼다:

```ts
import { loadConfig, ensureConfigDir, setupMcpConfig, getOrCreateToken, setCodexEnabled } from './shared/config.js';
import { PID_FILE, LOG_FILE, DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, CODEX_PID_FILE, CODEX_LOG_FILE } from './shared/constants.js';
```

`printUsage`의 `claude-alarm token` 줄 다음에 추가:

```
  claude-alarm codex enable     Start the Codex adapter together with the hub
  claude-alarm codex disable    Stop starting the Codex adapter with the hub
  claude-alarm codex start      Run the Codex adapter on its own (e.g. Codex on another PC)
  claude-alarm codex stop       Stop a running Codex adapter
  claude-alarm codex status     Show Codex adapter status
```

`isProcessRunning` 다음에 함수 추가:

```ts
function readCodexPid(): number | undefined {
  if (!fs.existsSync(CODEX_PID_FILE)) return undefined;
  const pid = parseInt(fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

function codexEnable(enabled: boolean) {
  setCodexEnabled(enabled);
  console.log(enabled
    ? 'Codex adapter enabled. Restart the hub to apply: claude-alarm hub stop, then claude-alarm hub start'
    : 'Codex adapter disabled. Restart the hub to apply.');
}

function codexStart() {
  const pid = readCodexPid();
  if (pid !== undefined && isProcessRunning(pid)) {
    console.log(`Codex adapter is already running (PID: ${pid})`);
    return;
  }
  ensureConfigDir();
  const logFd = fs.openSync(CODEX_LOG_FILE, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'codex', 'main.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  console.log(`Codex adapter started (PID: ${child.pid}). Logs: ${CODEX_LOG_FILE}`);
}

function codexStop() {
  const pid = readCodexPid();
  if (pid === undefined) {
    console.log('Codex adapter is not running');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Codex adapter stopped (PID: ${pid})`);
  } catch {
    console.log('Codex adapter process not found (may have already stopped)');
  }
  try { fs.unlinkSync(CODEX_PID_FILE); } catch {}
}

function codexStatus() {
  const pid = readCodexPid();
  const state = pid === undefined ? 'not running' : isProcessRunning(pid) ? `running (PID: ${pid})` : 'not running (stale PID file)';
  console.log(`Codex adapter: ${state}`);
  console.log(`Start with hub: ${loadConfig().codex?.enabled ? 'enabled' : 'disabled'}`);
}
```

`main()`의 `if (cmd === 'setup')` 앞에 추가:

```ts
  if (cmd === 'codex') {
    if (sub === 'enable') codexEnable(true);
    else if (sub === 'disable') codexEnable(false);
    else if (sub === 'start') codexStart();
    else if (sub === 'stop') codexStop();
    else if (sub === 'status') codexStatus();
    else {
      console.error(`Unknown codex command: ${sub}`);
      printUsage();
      process.exit(1);
    }
    return;
  }
```

- [ ] **Step 5: README** — `README.md`

Features 목록의 `- **Multi-Machine** — Remote hub access support` 다음 줄:

```markdown
- **Codex Sessions** — See and message OpenAI Codex conversations next to Claude sessions
```

CLI Commands 표의 `claude-alarm test` 행 다음:

```markdown
| `claude-alarm codex enable` / `disable` | Start (or stop starting) the Codex adapter with the hub |
| `claude-alarm codex start` / `stop` / `status` | Run the Codex adapter on its own, e.g. when Codex runs on another PC |
```

`## Permission Relay` 바로 앞에 새 절:

````markdown
## Codex Sessions

claude-alarm can show OpenAI Codex conversations on the dashboard and in Telegram, next to your Claude sessions.

```bash
claude-alarm codex enable
claude-alarm hub stop && claude-alarm hub start
```

- Requires the Codex CLI with its app-server daemon (`codex app-server daemon version` shows `running`). Set `"codex": { "command": "C:/path/to/codex.exe" }` in `~/.claude-alarm/config.json` if `codex` is not on `PATH`.
- Every loaded Codex conversation appears as a session with a **Codex** badge. Replies, failures and approval waits are relayed to the dashboard and Telegram.
- Messages you send reach the conversation only while Codex is idle, and show up in Codex prefixed with `[claude-alarm · Dashboard]` or `[claude-alarm · Telegram]`.
- Approvals still have to be answered in Codex; claude-alarm only tells you one is waiting.
- If Codex runs on another PC, run `claude-alarm codex start` there with that PC's config pointing at your hub.
````

- [ ] **Step 6: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-config.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음
Run: `npm run build && node dist/cli.js help` → 출력에 `codex enable` 줄 5개 표시
Run: `npm test` → 전체 PASS

- [ ] **Step 7: 커밋**

```bash
git add src/shared/config.ts src/cli.ts README.md test/codex-config.test.ts
git commit -m "feat(cli): codex enable/disable/start/stop/status commands"
```

---

### Task 14: 실제 Codex로 수동 검증 (격리 Hub)

자동 테스트는 가짜 데몬만 쓴다. 이 작업은 실제 Codex 데몬과 함께 단계 A가 동작하는지 사용자와 확인한다. **사용자가 쓰는 실제 Hub(7900)·텔레그램 설정은 건드리지 않는다.**

**Files:** 없음(검증만). 결과는 Obsidian `Projects/claude_alarm/docs/tasks/2026-10-01-codex-어댑터-설계.md`에 기록.

- [ ] **Step 1: 격리 Hub 준비** (Git Bash)

```bash
npm run build
export CA_HOME="$(mktemp -d)"
mkdir -p "$CA_HOME/.claude-alarm"
cat > "$CA_HOME/.claude-alarm/config.json" <<'EOF'
{ "hub": { "host": "127.0.0.1", "port": 7990, "token": "manual-codex-check" },
  "notifications": { "desktop": false, "sound": false },
  "webhooks": [],
  "codex": { "enabled": true } }
EOF
```

- [ ] **Step 2: 격리 Hub 실행** — HOME을 바꾸면 Codex가 데몬 소켓을 못 찾으므로 `CODEX_HOME`에 실제 Codex 홈의 **절대 경로**를 준다(바꾸기 전 `$USERPROFILE/.codex` 값). 포그라운드로 실행하므로 백그라운드 작업으로 띄운다.

```bash
REAL_CODEX_HOME="$USERPROFILE/.codex"
HOME="$CA_HOME" USERPROFILE="$CA_HOME" CODEX_HOME="$REAL_CODEX_HOME" node dist/cli.js hub start
```

`CODEX_HOME`으로 데몬 소켓을 찾는지는 이 단계에서 처음 확인한다(못 찾으면 로그에 연결 실패가 반복된다). 로그에 `Codex adapter started`와 `Connected to Codex daemon (...)`이 보여야 한다.

- [ ] **Step 3: 확인 항목** — 사용자가 터미널에서 실험용 Codex 대화(`C:\tmp\codex-test`)를 열고, `http://127.0.0.1:7990/?token=manual-codex-check` 대시보드에서:

1. Codex 대화가 **Codex** 배지와 제목으로 보인다(VS Code/앱 대화가 있으면 함께)
2. 터미널에서 Codex에 질문 → 대시보드에 상태 working → idle, 응답이 메시지로 표시되고 작성자 표기가 "Codex"
3. 대시보드에서 지시 → 터미널에 `[claude-alarm · Dashboard] …`로 보이고 Codex가 답함
4. Codex가 작업 중일 때 지시 → 경고 알림, 터미널에는 아무것도 들어가지 않음
5. 네트워크 명령 요청 → 대시보드에 "Codex approval needed" 경고, 상태 waiting input. 승인은 터미널에서
6. Codex 창을 닫음 → 대시보드에서 세션이 사라짐
7. `node dist/cli.js hub stop`(격리 HOME으로) 후 어댑터 프로세스가 남지 않음 (`tasklist | grep node`로 확인)

- [ ] **Step 4: 정리와 기록**

격리 Hub를 끄고 `$CA_HOME`을 지운다. 확인한 항목과 못 한 항목(텔레그램 전달은 격리 Hub에 봇이 없어 미확인)을 Obsidian 문서에 적는다.
