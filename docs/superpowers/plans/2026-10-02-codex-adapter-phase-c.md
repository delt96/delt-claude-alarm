# Codex Adapter Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex가 작업 중일 때도 대시보드·텔레그램 메시지를 진행 중인 턴에 추가 지시(steer)로 넣고, 대시보드·텔레그램 이미지를 Codex 대화에 보낸다(스펙 단계 C, §9).

**Architecture:** 어댑터가 대화별로 메시지를 하나씩 처리한다. 승인·입력 대기면 거절하고, 그 밖에는 `thread/turns/list`로 진행 중 턴을 확인해 있으면 `turn/steer`, 없으면(조회 실패 포함) `turn/start`로 보낸다. 이미지는 Hub가 저장한 파일을 어댑터가 읽어 data URL로 만들어 같은 경로로 보낸다. Hub는 `image_to_session`에 출처를 붙이고, 대시보드는 로컬 Codex 세션에서도 첨부 버튼을 켠다.

**Tech Stack:** TypeScript ESM, `ws`, `node:test` + `tsx`, 단일 파일 대시보드(`src/dashboard/index.html`), Codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-10-01-codex-adapter-design.md` §9(단계 C). "확인된 전제"의 단계 C 사전 실측 7줄이 이 계획의 근거다.

## Global Constraints

- Claude 세션의 지시·이미지 흐름은 바뀌지 않는다. `image_to_session`에 `source?`가 더해질 뿐이고 Claude 채널은 이 필드를 쓰지 않는다.
- 사용자에게 보이는 문구(영어, 정확히 이대로):
  - 승인·입력 대기: 제목 `Not delivered`, 내용 `Codex is waiting for an approval or input. Answer it first, then send the message again.`, level `warning`
  - steer 접수: 제목 `Queued`, 내용 `Queued: Codex will read it after its current step.`, level `info`
  - 이미지를 못 읽음·형식 미지원: 제목 `Not delivered`, 내용 `The image could not be read here, so it was not delivered. Codex may be running on another PC.`, level `warning`
  - steer·start 실패: 기존 그대로 제목 `Not delivered`, 내용 `Codex rejected the message: <오류 메시지>`, level `warning`
  - 캡션 없는 이미지의 텍스트: `(image)`(출처 접두어 뒤)
- RPC 파라미터(정확히 이대로): `thread/turns/list` → `{ threadId, limit: 1, sortDirection: 'desc' }`, `turn/steer` → `{ threadId, expectedTurnId, input }`, `turn/start` → `{ threadId, input }`(단계 A 그대로).
- 이미지 입력: `[{ type: 'text', text: withSourcePrefix(캡션 또는 '(image)', source) }, { type: 'image', url: 'data:<mimeType>;base64,<파일 내용 base64>' }]`. 허용 MIME: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. `localImage`는 쓰지 않는다.
- 자동 재전송은 하지 않는다(steer가 실패하면 알리고 끝).
- `thread/resume`에는 `{ threadId, excludeTurns: true }`만 보낸다(단계 A 그대로).
- 로그에 메시지 원문·이미지 데이터를 남기지 않는다.
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선 주석 금지.
- 테스트에서 Hub를 띄우면 `test/isolate-home.ts`를 첫 import로 두고 `notifications: { desktop: false, sound: false }`를 넘긴다. 실제 Codex·데몬·텔레그램에 접근하지 않는다(텔레그램은 `fetch` mock).
- 테스트 포트: 7992–7998 사용 중. 이 계획은 텔레그램을 켠 두 번째 Hub에 7991을 쓴다.

## Review Focus

1. **턴이 막 끝나는 순간 보낸 메시지** — steer가 `no active turn to steer`로 실패해도 조용히 사라지지 않고 "Codex rejected the message" 경고가 와야 한다(재시도는 없음). → Task 3 "a steer the daemon rejects" 테스트.
2. **첫 턴 전의 새 대화에 보낸 첫 메시지** — `thread/turns/list`가 실패해도 새 턴으로 전달돼야 한다. → Task 3 "no turn list yet" 테스트.
3. **텔레그램에서 연달아 보낸 두 메시지** — 두 번째가 거절되거나 별도 턴을 만들지 않고 첫 메시지가 시작한 턴에 steer돼야 한다. → Task 3 "a second message right after the first" 테스트.
4. **읽을 수 없는 이미지**(다른 PC의 어댑터, 지워진 파일) — 경고만 하고, 대화별 처리 순서가 막혀 다음 메시지가 안 가는 일이 없어야 한다. → Task 3 "an image that cannot be read" 테스트.
5. **승인 대기 중 보낸 메시지** — steer되면 승인이 끝날 때까지 읽히지 않으므로, 보내지 않고 승인부터 답하라고 알려야 한다. → Task 3에서 고치는 "waiting for approval are refused" 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | `image_to_session.source?` | 수정 |
| `src/hub/server.ts` | 이미지 출처 채우기, 업로드 정리 타이머 `unref` | 수정 |
| `src/dashboard/index.html` | 로컬 Codex 세션 첨부 버튼 | 수정 |
| `src/codex/inputs.ts` | 텍스트·이미지 → Codex `UserInput[]`(순수 함수 + 파일 읽기) | 생성 |
| `src/codex/adapter.ts` | 대화별 직렬 전송, 승인 대기 거절, steer/start 선택, 이미지 | 수정 |
| `README.md` | Codex 지시·이미지 안내 | 수정 |
| `test/hub-message-source.test.ts` | 이미지 출처 테스트 | 수정 |
| `test/dashboard-images.test.ts`, `test/codex-inputs.test.ts` | 새 테스트 | 생성 |
| `test/codex-adapter.test.ts` | 기본 핸들러 추가, 테스트 교체·추가 | 수정 |

단일 테스트 파일 실행: `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`
전체: `npm test` / 타입 검사: `npx tsc --noEmit`

---

### Task 1: Hub·대시보드가 Codex 세션으로 이미지를 넘긴다

**Files:**
- Modify: `src/shared/types.ts` (`image_to_session` 줄)
- Modify: `src/hub/server.ts` (`handleImageUpload`의 `forwardMsg`와 정리 타이머, `initTelegram`의 `onImageToSession`)
- Modify: `src/dashboard/index.html` (`updateImageUI`)
- Modify: `test/hub-message-source.test.ts`
- Create: `test/dashboard-images.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `ChannelMessage`의 `{ type: 'image_to_session'; sessionId; imagePath; mimeType; originalName?; content?; source?: MessageSource }`. Hub는 대시보드 업로드에 `source: 'dashboard'`, 텔레그램 사진에 `source: 'telegram'`을 채운다(Task 3이 사용).

- [ ] **Step 1: Write the failing hub tests**

`test/hub-message-source.test.ts`에서 `import WebSocket from 'ws';` 아래에 `import fs from 'node:fs';`를 더하고, `open` 헬퍼가 포트를 받게 바꾼다:

```ts
function open(path: string, port = PORT): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}
```

파일 끝에 추가:

```ts
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
  const tgHub = new HubServer({
    hub: { host: '127.0.0.1', port: 7991, token: TOKEN },
    notifications: { desktop: false, sound: false },
    telegram: { enabled: true, botToken: 'x', chatId: '111' },
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
```

- [ ] **Step 2: Write the failing dashboard test**

Create `test/dashboard-images.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate updateImageUI in a sandbox.
function attachDisabledFor(session: Record<string, unknown>): boolean {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  function updateImageUI() {');
  const end = html.indexOf('  function renderMessages() {');
  assert.ok(start > 0 && end > start, 'updateImageUI anchors not found');
  const attach = { disabled: true };
  const ctx: Record<string, any> = { state: { selectedSession: 's1', sessions: { s1: session } }, $: () => attach };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  ctx.updateImageUI();
  return attach.disabled;
}

test('local Codex sessions can attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: true, agentKind: 'codex' }), false);
});

test('local Claude sessions can attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: true }), false);
});

test('remote sessions cannot attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: false, agentKind: 'codex' }), true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-message-source.test.ts test/dashboard-images.test.ts`
Expected: "dashboard image uploads are tagged dashboard"와 "Telegram photos are tagged telegram"이 `source` `undefined`로 FAIL, "local Codex sessions can attach images"가 FAIL(`true !== false`). 나머지는 PASS. (업로드 테스트 뒤 프로세스가 5분 동안 끝나지 않을 수 있다 — Step 4의 `unref`가 고친다. 기다리지 말고 결과 줄을 확인한 뒤 Ctrl+C.)

- [ ] **Step 4: Implement**

`src/shared/types.ts`의 `image_to_session` 줄:

```ts
  | { type: 'image_to_session'; sessionId: string; imagePath: string; mimeType: string; originalName?: string; content?: string; source?: MessageSource }
```

`src/hub/server.ts` `handleImageUpload`의 `forwardMsg`에 `source: 'dashboard'`를 더하고 정리 타이머를 `unref`한다:

```ts
    const forwardMsg: ChannelMessage = {
      type: 'image_to_session',
      sessionId,
      imagePath: filePath,
      mimeType,
      originalName,
      content,
      source: 'dashboard',
    };
```

```ts
    // Cleanup after 5 minutes
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 5 * 60 * 1000).unref();
```

`initTelegram`의 `onImageToSession`:

```ts
        const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
```

`src/dashboard/index.html` `updateImageUI`:

```js
  function updateImageUI() {
    const s = state.selectedSession ? state.sessions[state.selectedSession] : null;
    const canImage = s && s.isLocal;
    $('#attachBtn').disabled = !canImage;
  }
```

(붙여넣기·끌어놓기 처리기는 이미 `isLocal`만 본다. 손대지 않는다.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-message-source.test.ts test/dashboard-images.test.ts`
Expected: 전부 PASS, 프로세스가 바로 끝난다.
Run: `npm test` 그리고 `npx tsc --noEmit`
Expected: 전부 PASS, 타입 오류 없음.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/hub/server.ts src/dashboard/index.html test/hub-message-source.test.ts test/dashboard-images.test.ts
git commit -m "feat(hub): tag forwarded images with their source and let local Codex sessions attach images"
```

---

### Task 2: Codex 입력 만들기 (텍스트·이미지)

**Files:**
- Create: `src/codex/inputs.ts`
- Create: `test/codex-inputs.test.ts`

**Interfaces:**
- Consumes: `withSourcePrefix(content: string, source?: MessageSource): string` (`src/codex/mapping.ts`, 기존)
- Produces:
  - `type UserInput = { type: 'text'; text: string } | { type: 'image'; url: string }`
  - `textInput(content: string, source?: MessageSource): UserInput[]`
  - `imageInput(imagePath: string, mimeType: string, caption: string | undefined, source?: MessageSource): Promise<UserInput[]>` — 형식이 허용 목록에 없으면 `Error('unsupported image type <mime>')`, 파일을 못 읽으면 `fs` 오류를 그대로 던진다.

- [ ] **Step 1: Write the failing test**

Create `test/codex-inputs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageInput, textInput } from '../src/codex/inputs.js';

function tmpFile(name: string, bytes: Buffer): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inputs-')), name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('text is sent with its source prefix', () => {
  assert.deepEqual(textInput('run the tests', 'telegram'), [{ type: 'text', text: '[claude-alarm · Telegram] run the tests' }]);
});

test('an image becomes a data URL behind its prefixed caption', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const file = tmpFile('a.png', bytes);
  assert.deepEqual(await imageInput(file, 'image/png', 'what is this?', 'dashboard'), [
    { type: 'text', text: '[claude-alarm · Dashboard] what is this?' },
    { type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` },
  ]);
});

test('an image without a caption still says where it came from', async () => {
  const file = tmpFile('b.jpg', Buffer.from('jpeg'));
  const [text] = await imageInput(file, 'image/jpeg', '  ', 'telegram');
  assert.deepEqual(text, { type: 'text', text: '[claude-alarm · Telegram] (image)' });
});

test('unsupported image types are refused', async () => {
  const file = tmpFile('c.svg', Buffer.from('<svg/>'));
  await assert.rejects(imageInput(file, 'image/svg+xml', undefined, 'dashboard'), /unsupported image type image\/svg\+xml/);
});

test('a missing image file is refused', async () => {
  await assert.rejects(imageInput(path.join(os.tmpdir(), 'claude-alarm-no-such-image.png'), 'image/png', undefined, 'dashboard'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-inputs.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/inputs.js'`.

- [ ] **Step 3: Implement**

Create `src/codex/inputs.ts`:

```ts
import fs from 'node:fs/promises';
import type { MessageSource } from '../shared/types.js';
import { withSourcePrefix } from './mapping.js';

export type UserInput = { type: 'text'; text: string } | { type: 'image'; url: string };

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function textInput(content: string, source?: MessageSource): UserInput[] {
  return [{ type: 'text', text: withSourcePrefix(content, source) }];
}

// Codex reads a localImage path only when it builds the model request, and the hub deletes uploads after 5 minutes, so the bytes go inline.
export async function imageInput(imagePath: string, mimeType: string, caption: string | undefined, source?: MessageSource): Promise<UserInput[]> {
  if (!IMAGE_TYPES.has(mimeType)) throw new Error(`unsupported image type ${mimeType}`);
  const data = await fs.readFile(imagePath);
  return [
    { type: 'text', text: withSourcePrefix(caption?.trim() || '(image)', source) },
    { type: 'image', url: `data:${mimeType};base64,${data.toString('base64')}` },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-inputs.test.ts`
Expected: 5개 PASS.
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 5: Commit**

```bash
git add src/codex/inputs.ts test/codex-inputs.test.ts
git commit -m "feat(codex): build text and inline image inputs for Codex turns"
```

---

### Task 3: 어댑터가 실행 중인 대화에 steer하고 이미지를 보낸다

**Files:**
- Modify: `src/codex/adapter.ts` (`Tracked`, `upsert`의 초기값, `onHubMessage`, `sendTurn` 교체)
- Modify: `test/codex-adapter.test.ts`
- Modify: `README.md` (Codex Sessions 절, Image Support 절)

**Interfaces:**
- Consumes: Task 1의 `image_to_session.source`(Hub가 채움), Task 2의 `UserInput`, `textInput`, `imageInput`, 기존 `hubStatus`(`src/codex/mapping.ts`)
- Produces: 없음(최종 동작)

- [ ] **Step 1: Give the fake daemon defaults and write the failing tests**

`test/codex-adapter.test.ts` 상단 import에 추가(첫 줄 `import './isolate-home.js';`는 그대로 첫 줄):

```ts
import os from 'node:os';
import path from 'node:path';
```

`startAdapter`의 기본 핸들러에 두 줄 추가(`d.handle('turn/start', …)` 바로 아래):

```ts
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('turn/steer', (p) => ({ turnId: p.expectedTurnId }));
```

"messages to a thread waiting for approval are refused, not queued" 테스트를 다음으로 바꾼다:

```ts
test('messages to a thread waiting for approval are refused, not queued', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await session('codex:t1', (s) => s.status === 'waiting_input');
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello?' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex is waiting for an approval or input. Answer it first, then send the message again.');
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await session('codex:t1', (s) => s.status === 'idle');
    assert.equal(d.calls('turn/start').length, 0);
    assert.equal(d.calls('turn/steer').length, 0);
  } finally {
    dash.ws.close();
  }
});
```

"back-to-back messages start only one turn" 테스트를 지우고 같은 자리에 넣는다:

```ts
test('a second message right after the first is steered into the turn the first one started', async () => {
  let running: string | undefined;
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('turn/start', () => {
      running = 'turn-new';
      return { turn: { id: 'turn-new', status: 'inProgress', items: [] } };
    });
    dm.handle('thread/turns/list', () => ({ data: running ? [{ id: running, status: 'inProgress', items: [] }] : [], nextCursor: null }));
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'first' }));
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'second' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.equal(d.calls('turn/start').length, 1);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] first');
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'turn-new',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] second' }],
    });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'info');
    assert.equal(n.message, 'Queued: Codex will read it after its current step.');
  } finally {
    dash.ws.close();
  }
});
```

파일 끝에 추가:

```ts
test('a message to a running thread is steered into the turn in progress', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also update the README' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.deepEqual(d.calls('thread/turns/list')[0].params, { threadId: 't1', limit: 1, sortDirection: 'desc' });
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'u9',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] also update the README' }],
    });
    assert.equal(d.calls('turn/start').length, 0);
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Queued');
    assert.equal(n.level, 'info');
  } finally {
    dash.ws.close();
  }
});

test('a conversation with no turn list yet still gets its first message as a new turn', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/turns/list', () => {
    throw new Error('thread t1 is not materialized yet; thread/turns/list is unavailable before first user message');
  }));
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.equal(d.calls('turn/steer').length, 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
  } finally {
    dash.ws.close();
  }
});

test('a steer the daemon rejects is reported and not retried', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
    dm.handle('turn/steer', () => {
      throw new Error('no active turn to steer');
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'one more thing' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex rejected the message: no active turn to steer');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/steer').length, 1);
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a dashboard image starts a turn with the picture as a data URL', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const imageData = Buffer.from('png bytes').toString('base64');
    dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'codex:t1', imageData, mimeType: 'image/png', content: 'what is wrong here?' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.deepEqual(d.calls('turn/start')[0].params.input, [
      { type: 'text', text: '[claude-alarm · Dashboard] what is wrong here?' },
      { type: 'image', url: `data:image/png;base64,${imageData}` },
    ]);
  } finally {
    dash.ws.close();
  }
});

test('an image sent while Codex works is steered into the running turn', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    const imageData = Buffer.from('jpeg bytes').toString('base64');
    dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId: 'codex:t1', imageData, mimeType: 'image/jpeg' }));
    await until(() => d.calls('turn/steer').length === 1);
    assert.deepEqual(d.calls('turn/steer')[0].params.input, [
      { type: 'text', text: '[claude-alarm · Dashboard] (image)' },
      { type: 'image', url: `data:image/jpeg;base64,${imageData}` },
    ]);
  } finally {
    dash.ws.close();
  }
});

test('an image that cannot be read is reported and later messages still go through', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const missing = path.join(os.tmpdir(), 'claude-alarm-missing-image.png');
    (adapter as any).onHubMessage('t1', { type: 'image_to_session', sessionId: 'codex:t1', imagePath: missing, mimeType: 'image/png', source: 'telegram' });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'The image could not be read here, so it was not delivered. Codex may be running on another PC.');
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'text still works' }));
    await until(() => d.calls('turn/start').length === 1);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] text still works');
  } finally {
    dash.ws.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: 새 테스트 7개와 바꾼 승인 대기 테스트가 FAIL(steer 미구현, "busy" 문구, 이미지 미지원 경고). 나머지 기존 테스트는 PASS.

- [ ] **Step 3: Implement the adapter changes**

`src/codex/adapter.ts`:

import 추가:

```ts
import { imageInput, textInput, type UserInput } from './inputs.js';
```

`withSourcePrefix`는 더 쓰지 않으므로 `./mapping.js` import 목록에서 뺀다(`hubStatus`는 그대로 쓴다).

`Tracked`에 필드 추가:

```ts
  sending: Promise<void>;
```

`upsert`에서 `this.threads.set(thread.id, { … })` 객체에 `sending: Promise.resolve(),`를 더한다.

`onHubMessage`를 다음으로 바꾼다:

```ts
  private onHubMessage(threadId: string, msg: ChannelMessage): void {
    if (msg.type === 'message_to_session') {
      this.enqueue(threadId, async () => textInput(msg.content, msg.source));
    } else if (msg.type === 'image_to_session') {
      this.enqueue(threadId, () => imageInput(msg.imagePath, msg.mimeType, msg.content, msg.source));
    } else if (msg.type === 'permission_response') {
      this.answer(threadId, msg.requestId, msg.choiceId);
    }
  }
```

`sendTurn` 메서드를 지우고 그 자리에 넣는다:

```ts
  // One message at a time per conversation, so a message right behind another sees the turn the first one started.
  private enqueue(threadId: string, build: () => Promise<UserInput[]>): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.sending = t.sending
      .then(() => this.deliver(t, build))
      .catch((err) => logger.warn(`Codex delivery for ${threadId} failed: ${(err as Error).message}`));
  }

  private async deliver(t: Tracked, build: () => Promise<UserInput[]>): Promise<void> {
    const threadId = t.thread.id;
    if (this.threads.get(threadId) !== t) return;
    // A steer is accepted while an approval is pending but read only after it is answered, which reads like an answer.
    if (hubStatus(t.thread.status) === 'waiting_input') {
      this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
      return;
    }
    let input: UserInput[];
    try {
      input = await build();
    } catch (err) {
      logger.debug(`Codex input for ${threadId} could not be built: ${(err as Error).message}`);
      this.notify(threadId, 'Not delivered', 'The image could not be read here, so it was not delivered. Codex may be running on another PC.', 'warning');
      return;
    }
    t.pendingTurn = true;
    try {
      if (!this.rpc) throw new Error('not connected to the Codex daemon');
      await this.want(threadId, true);
      const running = await this.runningTurn(threadId);
      if (running) {
        await this.rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info');
        return;
      }
      // A new conversation cannot be subscribed before its first turn (no rollout found); the active broadcast retries it.
      t.unrelayed = !t.subscribed;
      await this.rpc.request('turn/start', { threadId, input });
    } catch (err) {
      t.pendingTurn = false;
      t.unrelayed = false;
      this.releaseLater(t);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }

  // The list is unavailable before a new conversation's first turn; starting a turn is safe then, since turn/start steers a running turn.
  private async runningTurn(threadId: string): Promise<string | undefined> {
    try {
      const page = await this.rpc!.request<{ data: Array<{ id: string; status: string }> }>('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
      });
      const turn = page.data?.[0];
      return turn?.status === 'inProgress' ? turn.id : undefined;
    } catch (err) {
      logger.debug(`thread/turns/list ${threadId} failed: ${(err as Error).message}`);
      return undefined;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: 전부 PASS.
Run: `grep -n "busy\|do not accept images" src/codex/adapter.ts`
Expected: 결과 없음.

- [ ] **Step 5: Update the README**

`README.md` Codex Sessions 절에서 이 줄을

```markdown
- Messages you send reach the conversation only while Codex is idle, and show up in Codex prefixed with `[claude-alarm · Dashboard]` or `[claude-alarm · Telegram]`.
```

다음 두 줄로 바꾼다:

```markdown
- Messages you send show up in Codex prefixed with `[claude-alarm · Dashboard]` or `[claude-alarm · Telegram]`. If Codex is idle they start a new task; if it is working they join the current task and Codex reads them after its current step (you get a **Queued** notice). While Codex waits for an approval or for your answer, messages are not delivered; answer that first.
- Images work the same way: paste, drag & drop or 📎 on the dashboard, or send a photo to the Telegram bot. The Codex adapter must run on the same PC as the hub to read them.
```

같은 절의 `- After updating claude-alarm, reload open dashboard tabs so they pick up the new approval buttons.`를 `- After updating claude-alarm, reload open dashboard tabs so they pick up the changes.`로 바꾼다.

Image Support 절의 `- Send photos to the bot → forwarded to Claude session`을 `- Send photos to the bot → forwarded to the Claude or Codex session`으로 바꾼다.

- [ ] **Step 6: Run the full suite and type check**

Run: `npm test`
Expected: 전부 PASS.
Run: `npx tsc --noEmit`
Expected: 오류 없음.

- [ ] **Step 7: Commit**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts README.md
git commit -m "feat(codex): steer messages into a running Codex turn and send images"
```
