# Codex Adapter Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드·텔레그램에서 Codex 승인 요청에 Codex가 제시한 선택지로 답하고, 어디서 해결되든(터미널·대시보드·텔레그램) 모든 화면의 버튼이 닫히게 한다(스펙 단계 B, §8).

**Architecture:** 어댑터가 데몬의 승인 서버 요청(명령·파일 변경·MCP 도구)을 선택지가 붙은 `permission_request`로 바꿔 Hub에 보내고, Hub는 선택지 요청을 기억해 대시보드·텔레그램의 `choiceId` 응답만 그 세션으로 넘긴다. 어댑터는 고른 선택지의 정확한 응답 값을 JSON-RPC 응답으로 한 번만 돌려주고, 데몬의 `serverRequest/resolved`·연결 끊김을 `permission_resolved{resolved|expired}`로 알린다. 기존 Claude 승인(허용/거절)은 그대로다.

**Tech Stack:** TypeScript ESM, `ws`, `node:test` + `tsx`, 단일 파일 대시보드(`src/dashboard/index.html`), Telegram Bot API(fetch).

**Spec:** `docs/superpowers/specs/2026-10-01-codex-adapter-design.md` §8(단계 B). "확인된 전제"의 단계 B 사전 실측 4줄이 이 계획의 근거다.

## Global Constraints

- Claude 세션의 승인 흐름(대시보드 Allow/Deny·Enter/Esc, 텔레그램 `perm:` 버튼, `behavior: 'allow'|'deny'`)은 동작이 바뀌지 않는다.
- 메시지 형식(스펙 §8): `permission_request.choices?: { id: string; label: string }[]`, `permission_response.choiceId?: string`(선택지 모드는 `behavior` 대신), 신규 `{ type: 'permission_resolved'; sessionId; requestId; state: 'resolved' | 'expired' }`.
- `choiceId`는 선택지 배열의 인덱스 문자열(`'0'`, `'1'`, …). Hub용 `requestId`는 어댑터가 만든 `randomUUID()`.
- 선택지 라벨: `accept` Allow once / `acceptForSession` Allow for this session / `acceptWithExecpolicyAmendment` Always allow this command / `applyNetworkPolicyAmendment` `Network rule: <host> <allow|deny>` / `decline` Decline / `cancel` Cancel task. MCP 도구: Allow / Decline / Cancel.
- 응답 값: 명령·파일 변경 `{ decision }`(선택지 값 그대로, 객체 포함), MCP 도구 `{ action: 'accept', content: {} }` / `{ action: 'decline' }` / `{ action: 'cancel' }`.
- 응답은 어댑터가 요청당 한 번만 보낸다. `serverRequest/resolved`는 누가 무엇을 골랐는지 모르므로 "Resolved"로만 표시한다.
- 사용자에게 보이는 문구는 영어. 로그에 승인 입력 원문(명령·diff)을 남기지 않는다.
- `thread/resume`에는 `{ threadId, excludeTurns: true }`만 보낸다(단계 A 그대로).
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선 주석 금지.
- 테스트에서 Hub를 띄우면 `test/isolate-home.ts`를 첫 import로 두고 `notifications: { desktop: false, sound: false }`를 넘긴다. 실제 Codex·데몬·텔레그램에 접근하지 않는다(텔레그램은 `fetch` mock).
- 테스트 포트: 7993–7998 사용 중. 이 계획은 7992(hub-permission-choices).

## Review Focus

1. **터미널에서 먼저 승인** — 대시보드·텔레그램 버튼이 "Resolved"로 닫히고, 뒤늦게 누른 버튼은 Codex에 두 번째 응답을 보내지 않아야 한다. → Task 5 "answered elsewhere" 테스트, Task 3 "resolved … takes no more answers" 테스트.
2. **어댑터·데몬이 죽은 동안 대기 중이던 요청** — 버튼이 영원히 남지 않고 "Expired"가 되어야 한다. → Task 5 "losing the daemon" 테스트, Task 3 "disconnects expires" 테스트.
3. **승인 대기 중 재구독** — 데몬이 같은 요청을 다시 보내도 화면에는 한 번만 떠야 한다. → Task 5 "re-sent" 테스트.
4. **텔레그램 전송보다 해결이 먼저 도착** — `sendMessage` 응답 전에 resolved가 와도 메시지 버튼이 지워져야 한다. → Task 2 "expiry that lands before the message is sent" 테스트.
5. **대시보드에서 Codex 선택지 대기 중 Enter** — Enter가 승인으로 가로채지지 않고 입력한 메시지가 보내져야 한다. → Task 4 `shortcutRequest` 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | `PermissionChoice`, 승인 메시지 확장, `permission_resolved` | 수정 |
| `src/codex/approvals.ts` | 승인 요청 → 표시 내용·선택지·응답 값(순수 함수) | 생성 |
| `src/codex/rpc.ts` | `respond(id, result)` | 수정 |
| `src/hub/telegram.ts` | 선택지 버튼(`pc:` 토큰), 선택 콜백, 해결 표시 | 수정 |
| `src/hub/server.ts` | 선택지 요청 기억·응답 검증·해결 중계·연결 끊김 시 만료 | 수정 |
| `src/dashboard/index.html` | 선택지 버튼·설명·Sent/Resolved/Expired 표시, 단축키 제외, `Command` 미리보기 | 수정 |
| `src/codex/adapter.ts` | 승인 요청 중계·응답·해결·만료·재전송 중복 제거·파일 목록 | 수정 |
| `README.md` | Codex 승인 안내 | 수정 |
| `test/helpers/fake-codex-daemon.ts` | 어댑터가 보낸 응답 기록(`responses`) | 수정 |
| `test/codex-approvals.test.ts`, `test/telegram-choices.test.ts`, `test/hub-permission-choices.test.ts`, `test/dashboard-permissions.test.ts` | 새 테스트 | 생성 |
| `test/codex-rpc.test.ts`, `test/codex-adapter.test.ts` | 테스트 추가·교체 | 수정 |

단일 테스트 파일 실행: `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`
전체: `npm test` / 타입 검사: `npx tsc --noEmit`

---

### Task 1: 공용 타입 · 승인 선택지 변환 · RPC 응답

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/codex/approvals.ts`
- Modify: `src/codex/rpc.ts`
- Test: `test/codex-approvals.test.ts`(생성), `test/codex-rpc.test.ts`(추가)

**Interfaces:**
- Produces:
  - `src/shared/types.ts`: `export interface PermissionChoice { id: string; label: string }`; `ChannelMessage`의 `permission_request`에 `choices?: PermissionChoice[]`, `permission_response`는 `behavior?: 'allow' | 'deny'; choiceId?: string`, 신규 `{ type: 'permission_resolved'; sessionId: string; requestId: string; state: 'resolved' | 'expired' }`
  - `src/codex/approvals.ts`: `ApprovalChoice { label: string; response: unknown }`, `ApprovalView { toolName; description; inputPreview; choices: ApprovalChoice[] }`, `FileChange { path: string; diff: string }`, `decisionLabel(decision: unknown): string`, `fileChanges(item): FileChange[]`, `approvalView(method: string, params: any, files?: FileChange[]): ApprovalView | null`
  - `RpcClient.respond(id: RpcId, result: unknown): void`

- [ ] **Step 1: Write the failing tests**

`test/codex-approvals.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalView, decisionLabel, fileChanges } from '../src/codex/approvals.js';

const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['New-Item', '-Name', 'x'] } };

test('command approvals offer the decisions Codex sent, in order', () => {
  const v = approvalView('item/commandExecution/requestApproval', {
    threadId: 't',
    reason: 'Allow creating x?',
    command: 'New-Item -Name x',
    availableDecisions: ['accept', amendment, 'cancel'],
  })!;
  assert.equal(v.toolName, 'Command');
  assert.equal(v.description, 'Allow creating x?');
  assert.deepEqual(JSON.parse(v.inputPreview), { command: 'New-Item -Name x' });
  assert.deepEqual(v.choices.map((c) => c.label), ['Allow once', 'Always allow this command', 'Cancel task']);
  assert.deepEqual(v.choices.map((c) => c.response), [{ decision: 'accept' }, { decision: amendment }, { decision: 'cancel' }]);
});

test('command approvals without availableDecisions fall back to allow, decline and cancel', () => {
  const v = approvalView('item/commandExecution/requestApproval', {
    threadId: 't',
    commandActions: [{ type: 'unknown', command: 'ls' }],
  })!;
  assert.equal(v.description, 'Codex wants to run a command.');
  assert.deepEqual(JSON.parse(v.inputPreview), { command: 'ls' });
  assert.deepEqual(v.choices.map((c) => c.response), [{ decision: 'accept' }, { decision: 'decline' }, { decision: 'cancel' }]);
});

test('decision labels cover session, network and unknown decisions', () => {
  assert.equal(decisionLabel('acceptForSession'), 'Allow for this session');
  assert.equal(
    decisionLabel({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }),
    'Network rule: example.com allow',
  );
  assert.equal(decisionLabel('somethingNew'), 'somethingNew');
  assert.equal(decisionLabel({ somethingElse: {} }), 'somethingElse');
});

test('file change approvals show the files from the started item', () => {
  const files = fileChanges({ changes: [{ path: 'C:\\w\\a.txt', diff: 'hi' }, { path: 'C:\\w\\b.txt', diff: '' }] });
  const v = approvalView('item/fileChange/requestApproval', { threadId: 't', itemId: 'p1', reason: null }, files)!;
  assert.equal(v.toolName, 'File change');
  assert.equal(v.description, 'Codex wants to change files.');
  assert.equal(JSON.parse(v.inputPreview).content, 'C:\\w\\a.txt\nhi\n\nC:\\w\\b.txt');
  assert.deepEqual(v.choices.map((c) => c.response), [
    { decision: 'accept' },
    { decision: 'acceptForSession' },
    { decision: 'decline' },
    { decision: 'cancel' },
  ]);
});

test('file change approvals say so when the file list was missed', () => {
  const v = approvalView('item/fileChange/requestApproval', { threadId: 't', itemId: 'p1' })!;
  assert.match(JSON.parse(v.inputPreview).content, /not available/);
});

test('MCP tool-call elicitations become allow, decline and cancel actions', () => {
  const v = approvalView('mcpServer/elicitation/request', {
    threadId: 't',
    serverName: 'claude-alarm',
    mode: 'form',
    message: 'Allow notify?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call' },
  })!;
  assert.equal(v.toolName, 'MCP tool');
  assert.equal(v.description, 'MCP server: claude-alarm');
  assert.deepEqual(JSON.parse(v.inputPreview), { content: 'Allow notify?' });
  assert.deepEqual(v.choices.map((c) => c.label), ['Allow', 'Decline', 'Cancel']);
  assert.deepEqual(v.choices.map((c) => c.response), [{ action: 'accept', content: {} }, { action: 'decline' }, { action: 'cancel' }]);
});

test('other requests are not approvals claude-alarm can answer', () => {
  assert.equal(approvalView('mcpServer/elicitation/request', { threadId: 't', mode: 'form', message: 'Your name?' }), null);
  assert.equal(approvalView('item/tool/requestUserInput', { threadId: 't' }), null);
});
```

`test/codex-rpc.test.ts` 끝에 추가:

```ts
test('respond answers a server request with its own id while the socket is open', () => {
  const ws = new FakeWs();
  const rpc = new RpcClient(ws as any);
  rpc.respond('req-7', { decision: 'accept' });
  rpc.respond(31, { decision: 'decline' });
  ws.readyState = 3;
  rpc.respond(32, { decision: 'cancel' });
  assert.deepEqual(ws.sent, [
    { id: 'req-7', result: { decision: 'accept' } },
    { id: 31, result: { decision: 'decline' } },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-approvals.test.ts test/codex-rpc.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/approvals.js'`, `rpc.respond is not a function`.

- [ ] **Step 3: Implement**

`src/shared/types.ts` — `MessageSource` 아래에 추가:

```ts
export interface PermissionChoice {
  id: string;
  label: string;
}
```

`ChannelMessage`의 두 줄을 바꾸고 한 줄을 추가:

```ts
  | { type: 'permission_request'; sessionId: string; requestId: string; toolName: string; description: string; inputPreview: string; timestamp: number; choices?: PermissionChoice[] }
  | { type: 'permission_response'; sessionId: string; requestId: string; behavior?: 'allow' | 'deny'; choiceId?: string }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; state: 'resolved' | 'expired' }
```

`src/codex/approvals.ts`:

```ts
export interface ApprovalChoice {
  label: string;
  response: unknown;
}

export interface ApprovalView {
  toolName: string;
  description: string;
  inputPreview: string;
  choices: ApprovalChoice[];
}

export interface FileChange {
  path: string;
  diff: string;
}

const DECISION_LABELS: Record<string, string> = {
  accept: 'Allow once',
  acceptForSession: 'Allow for this session',
  acceptWithExecpolicyAmendment: 'Always allow this command',
  decline: 'Decline',
  cancel: 'Cancel task',
};

export function decisionLabel(decision: unknown): string {
  if (typeof decision === 'string') return DECISION_LABELS[decision] ?? decision;
  const [key, value] = Object.entries(decision ?? {})[0] ?? [];
  if (key === 'applyNetworkPolicyAmendment') {
    const rule = (value as { network_policy_amendment?: { host?: string; action?: string } } | undefined)?.network_policy_amendment;
    return `Network rule: ${rule?.host ?? 'unknown host'} ${rule?.action ?? ''}`.trim();
  }
  return key ? (DECISION_LABELS[key] ?? key) : 'Unknown';
}

function decisions(offered: unknown[]): ApprovalChoice[] {
  return offered.map((decision) => ({ label: decisionLabel(decision), response: { decision } }));
}

export function fileChanges(item: { changes?: Array<{ path?: string; diff?: string }> }): FileChange[] {
  return (item.changes ?? []).map((c) => ({ path: String(c.path ?? ''), diff: String(c.diff ?? '') }));
}

export function approvalView(method: string, params: any, files: FileChange[] = []): ApprovalView | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      // availableDecisions is sent by Codex 0.159.3 but absent from its generated schema.
      const offered: unknown[] =
        Array.isArray(params.availableDecisions) && params.availableDecisions.length
          ? params.availableDecisions
          : ['accept', 'decline', 'cancel'];
      const command = params.command ?? (params.commandActions ?? []).map((a: { command: string }) => a.command).join('\n');
      return {
        toolName: 'Command',
        description: params.reason || 'Codex wants to run a command.',
        inputPreview: JSON.stringify({ command: String(command) }),
        choices: decisions(offered),
      };
    }
    case 'item/fileChange/requestApproval': {
      // The request names only the item; the file list arrives earlier in item/started.
      const content = files.length
        ? files.map((f) => (f.diff ? `${f.path}\n${f.diff}` : f.path)).join('\n\n')
        : 'The file list is not available here. Check the Codex window.';
      return {
        toolName: 'File change',
        description: params.reason || 'Codex wants to change files.',
        inputPreview: JSON.stringify({ content }),
        choices: decisions(['accept', 'acceptForSession', 'decline', 'cancel']),
      };
    }
    case 'mcpServer/elicitation/request':
      if (params._meta?.codex_approval_kind !== 'mcp_tool_call') return null;
      return {
        toolName: 'MCP tool',
        description: `MCP server: ${params.serverName ?? 'unknown'}`,
        inputPreview: JSON.stringify({ content: String(params.message ?? '') }),
        choices: [
          { label: 'Allow', response: { action: 'accept', content: {} } },
          { label: 'Decline', response: { action: 'decline' } },
          { label: 'Cancel', response: { action: 'cancel' } },
        ],
      };
    default:
      return null;
  }
}
```

`src/codex/rpc.ts` — `notify()` 아래에 추가:

```ts
  respond(id: RpcId, result: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ id, result }));
  }
```

- [ ] **Step 4: Run tests and type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-approvals.test.ts test/codex-rpc.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음(`behavior`가 선택 필드가 되어도 기존 사용처는 문자열 보간·통과만 한다)

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/codex/approvals.ts src/codex/rpc.ts test/codex-approvals.test.ts test/codex-rpc.test.ts
git commit -m "feat(codex): map approval requests to choices and answer server requests"
```

---

### Task 2: 텔레그램 — 선택지 버튼 · 선택 콜백 · 해결 표시

**Files:**
- Modify: `src/hub/telegram.ts`
- Test: `test/telegram-choices.test.ts`(생성)

**Interfaces:**
- Consumes: `PermissionChoice`(Task 1)
- Produces (Task 3이 호출):
  - `TelegramBot.onChoiceVerdict?: (sessionId: string, requestId: string, choiceId: string) => void`
  - `TelegramBot.sendChoiceRequest(sessionId, sessionLabel, requestId, toolName, description, inputPreview, choices: PermissionChoice[]): Promise<void>`
  - `TelegramBot.resolveChoiceRequest(sessionId, requestId, state: 'resolved' | 'expired'): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/telegram-choices.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const choices = [
  { id: '0', label: 'Allow once' },
  { id: '1', label: 'Always allow this command' },
  { id: '2', label: 'Cancel task' },
];

function setup(t: any) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ api: String(url).split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const verdicts: string[] = [];
  bot.onChoiceVerdict = (s, r, c) => { verdicts.push(`${s}|${r}|${c}`); };
  return { bot, calls, verdicts };
}

const offer = (bot: TelegramBot) =>
  bot.sendChoiceRequest('codex:t1', 'Codex · proj', 'req-1', 'Command', 'Allow creating <x>?', '{"command":"New-Item x"}', choices);

const press = (bot: TelegramBot, data: string, chatId = 111) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: chatId }, message_id: 42, text: '' } });

const buttons = (calls: Array<{ api: string; body: any }>) =>
  calls.find((c) => c.api === 'sendMessage')!.body.reply_markup.inline_keyboard.flat();

test('a choice request gets one button per choice with short callback data', async (t) => {
  const { bot, calls } = setup(t);
  await offer(bot);
  const sent = calls.find((c) => c.api === 'sendMessage')!.body;
  assert.match(sent.text, /Allow creating &lt;x&gt;\?/);
  assert.match(sent.text, /\$ New-Item x/);
  const b = buttons(calls);
  assert.deepEqual(b.map((x: any) => x.text), choices.map((c) => c.label));
  for (const x of b) {
    assert.match(x.callback_data, /^pc:[0-9a-f]+$/);
    assert.ok(Buffer.byteLength(x.callback_data) <= 64);
  }
});

test('pressing a choice sends it once and removes the buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  const b = buttons(calls);
  await press(bot, b[1].callback_data);
  await press(bot, b[0].callback_data);
  assert.deepEqual(verdicts, ['codex:t1|req-1|1']);
  assert.deepEqual(
    calls.filter((c) => c.api === 'answerCallbackQuery').map((c) => c.body.text),
    ['Sent: Always allow this command', 'Expired'],
  );
  const edit = calls.find((c) => c.api === 'editMessageText')!.body;
  assert.equal(edit.message_id, 42);
  assert.equal(edit.reply_markup, undefined);
  assert.match(edit.text, /Sent: Always allow this command/);
});

test('an unknown token answers Expired', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await press(bot, 'pc:deadbeef');
  assert.deepEqual(verdicts, []);
  assert.equal(calls.find((c) => c.api === 'answerCallbackQuery')!.body.text, 'Expired');
});

test('resolution edits the message and retires its buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  const b = buttons(calls);
  await bot.resolveChoiceRequest('codex:t1', 'req-1', 'resolved');
  assert.match(calls.find((c) => c.api === 'editMessageText')!.body.text, /Resolved/);
  await press(bot, b[0].callback_data);
  assert.deepEqual(verdicts, []);
});

test('an expiry that lands before the message is sent still removes the buttons', async (t) => {
  const { bot, calls } = setup(t);
  const sending = offer(bot);
  await bot.resolveChoiceRequest('codex:t1', 'req-1', 'expired');
  await sending;
  const edit = calls.find((c) => c.api === 'editMessageText');
  assert.ok(edit, 'message was not edited');
  assert.match(edit.body.text, /Expired/);
});

test('choice callbacks from another chat are ignored', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await offer(bot);
  await press(bot, buttons(calls)[0].callback_data, 999);
  assert.deepEqual(verdicts, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-choices.test.ts`
Expected: FAIL — `bot.sendChoiceRequest is not a function`.

- [ ] **Step 3: Implement**

`src/hub/telegram.ts`:

import 줄을 바꾼다:

```ts
import type { TelegramConfig, SessionInfo, PermissionChoice } from '../shared/types.js';
```

`const TELEGRAM_API` 아래에 추가:

```ts
const MAX_CHOICE_MESSAGES = 200;
const choiceKey = (sessionId: string, requestId: string) => `${sessionId}\n${requestId}`;

interface ChoiceMessage {
  html: string;
  messageId?: number;
  outcome?: string;
}
```

클래스 필드(`onPermissionVerdict` 아래)에 추가:

```ts
  // Callback: when a Codex approval choice arrives from Telegram
  public onChoiceVerdict?: (sessionId: string, requestId: string, choiceId: string) => void;
  // Telegram caps callback_data at 64 bytes, so buttons carry a short token instead of the ids.
  private choiceTokens = new Map<string, { sessionId: string; requestId: string; choiceId: string; label: string }>();
  private choiceMessages = new Map<string, ChoiceMessage>();
```

`sendPermissionRequest()` 아래에 메서드 추가:

```ts
  async sendChoiceRequest(
    sessionId: string,
    sessionLabel: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
    choices: PermissionChoice[],
  ): Promise<void> {
    let preview = inputPreview;
    try {
      const p = JSON.parse(inputPreview);
      if (typeof p.command === 'string') preview = `$ ${p.command}`;
      else if (typeof p.content === 'string') preview = p.content;
    } catch {}
    const slice = preview.slice(0, 3000);
    const html =
      `⚠️ <b>Permission Request</b> — ${this.escHtml(sessionLabel)}\n\n` +
      `🔧 <b>${this.escHtml(toolName)}</b>` +
      (description ? `\n${this.escHtml(description)}` : '') +
      (slice ? `\n<pre>${this.escHtml(slice)}</pre>` : '') +
      (preview.length > slice.length ? '\n<i>...truncated</i>' : '');

    const entry: ChoiceMessage = { html };
    this.choiceMessages.set(choiceKey(sessionId, requestId), entry);
    const rows = choices.map((c) => {
      const token = randomUUID().replace(/-/g, '').slice(0, 16);
      this.choiceTokens.set(token, { sessionId, requestId, choiceId: c.id, label: c.label });
      return [{ text: c.label, callback_data: `pc:${token}` }];
    });
    this.trimChoiceMessages();

    const sent = await this.sendMessage(html, undefined, { inline_keyboard: rows });
    if (!sent) return;
    entry.messageId = sent.message_id;
    if (entry.outcome) await this.editMessageText(this.config.chatId, sent.message_id, html + entry.outcome);
  }

  async resolveChoiceRequest(sessionId: string, requestId: string, state: 'resolved' | 'expired'): Promise<void> {
    this.dropChoiceTokens(sessionId, requestId);
    const key = choiceKey(sessionId, requestId);
    const entry = this.choiceMessages.get(key);
    if (!entry) return;
    this.choiceMessages.delete(key);
    entry.outcome = state === 'resolved' ? '\n\n✅ <b>Resolved</b>' : '\n\n⌛ <b>Expired</b>';
    if (entry.messageId !== undefined) await this.editMessageText(this.config.chatId, entry.messageId, entry.html + entry.outcome);
  }

  private async handleChoiceCallback(query: TelegramCallbackQuery): Promise<void> {
    const choice = this.choiceTokens.get(query.data!.slice('pc:'.length));
    if (!choice) {
      await this.answerCallbackQuery(query.id, 'Expired');
      return;
    }
    this.dropChoiceTokens(choice.sessionId, choice.requestId);
    this.onChoiceVerdict?.(choice.sessionId, choice.requestId, choice.choiceId);
    await this.answerCallbackQuery(query.id, `Sent: ${choice.label}`);
    const entry = this.choiceMessages.get(choiceKey(choice.sessionId, choice.requestId));
    if (entry?.messageId !== undefined && !entry.outcome) {
      await this.editMessageText(this.config.chatId, entry.messageId, `${entry.html}\n\n⏳ <b>Sent: ${this.escHtml(choice.label)}</b>`);
    }
  }

  private dropChoiceTokens(sessionId: string, requestId: string): void {
    for (const [token, c] of this.choiceTokens) {
      if (c.sessionId === sessionId && c.requestId === requestId) this.choiceTokens.delete(token);
    }
  }

  private trimChoiceMessages(): void {
    while (this.choiceMessages.size > MAX_CHOICE_MESSAGES) {
      const oldest = this.choiceMessages.keys().next().value as string;
      this.choiceMessages.delete(oldest);
      const [sessionId, requestId] = oldest.split('\n');
      this.dropChoiceTokens(sessionId, requestId);
    }
  }
```

`handleCallbackQuery()`의 `sess:` 분기 바로 아래에 추가:

```ts
    if (query.data.startsWith('pc:')) {
      await this.handleChoiceCallback(query);
      return;
    }
```

`editMessageText`의 첫 매개변수 타입을 `chatId: number | string`으로 바꾼다(설정의 `chatId`는 문자열이다. Bot API는 둘 다 받는다).

- [ ] **Step 4: Run tests**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-choices.test.ts test/telegram-callback.test.ts test/telegram-session-select.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram.ts test/telegram-choices.test.ts
git commit -m "feat(telegram): offer Codex approval choices as buttons and close them on resolution"
```

---

### Task 3: Hub — 선택지 요청 중계 · 응답 검증 · 해결 동기화

**Files:**
- Modify: `src/hub/server.ts`
- Test: `test/hub-permission-choices.test.ts`(생성)

**Interfaces:**
- Consumes: `PermissionChoice`, 메시지 타입(Task 1), `TelegramBot.sendChoiceRequest` / `resolveChoiceRequest` / `onChoiceVerdict`(Task 2)
- Produces (Task 4·5가 기대하는 Hub 동작):
  - 채널 → 대시보드: `permission_request`에 `choices`가 있으면 그대로 실어 방송, 텔레그램은 `sendChoiceRequest`
  - 대시보드·텔레그램 → 채널: 선택지 요청에는 선택지에 있는 `choiceId`만 `{ type, sessionId, requestId, choiceId }`로, 그 밖의 요청에는 `behavior`만 넘긴다
  - 채널 → 대시보드: `permission_resolved`를 한 번만 방송하고 텔레그램 메시지를 고친다. 세션 연결이 끊기면 그 세션의 대기 중 선택지 요청을 `expired`로 방송

- [ ] **Step 1: Write the failing tests**

`test/hub-permission-choices.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';

const PORT = 7992;
const TOKEN = 'choice-test';
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

const choices = [{ id: '0', label: 'Allow once' }, { id: '1', label: 'Cancel task' }];

function request(ws: WebSocket, sessionId: string, requestId: string, withChoices = true) {
  ws.send(JSON.stringify({
    type: 'permission_request',
    sessionId,
    requestId,
    toolName: 'Command',
    description: 'Allow?',
    inputPreview: '{"command":"ls"}',
    timestamp: 0,
    ...(withChoices ? { choices } : {}),
  }));
}

const responses = (inbox: any[]) => inbox.filter((m) => m.type === 'permission_response');
const answer = (ws: WebSocket, body: object) => ws.send(JSON.stringify({ type: 'permission_response', ...body }));

test('choice requests reach dashboards with their choices and only a listed choiceId is forwarded', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c1');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c1', 'r1');
  await settle();
  assert.deepEqual(dash.inbox.find((m) => m.type === 'permission_request')?.choices, choices);
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', behavior: 'allow' });
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', choiceId: '7' });
  answer(dash.ws, { sessionId: 'codex:c1', requestId: 'r1', choiceId: '1' });
  await settle();
  assert.deepEqual(responses(ch.inbox), [{ type: 'permission_response', sessionId: 'codex:c1', requestId: 'r1', choiceId: '1' }]);
  dash.ws.close();
  ch.ws.close();
});

test('Claude requests still take allow or deny and drop choice ids', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'claude-1');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'claude-1', 'r2', false);
  await settle();
  assert.equal(dash.inbox.find((m) => m.type === 'permission_request')?.choices, undefined);
  answer(dash.ws, { sessionId: 'claude-1', requestId: 'r2', choiceId: '0' });
  answer(dash.ws, { sessionId: 'claude-1', requestId: 'r2', behavior: 'deny' });
  await settle();
  assert.deepEqual(responses(ch.inbox), [{ type: 'permission_response', sessionId: 'claude-1', requestId: 'r2', behavior: 'deny' }]);
  dash.ws.close();
  ch.ws.close();
});

test('a resolved choice request is announced once and takes no more answers', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c2');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c2', 'r3');
  await settle();
  ch.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' }));
  ch.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' }));
  await settle();
  assert.deepEqual(dash.inbox.filter((m) => m.type === 'permission_resolved'), [
    { type: 'permission_resolved', sessionId: 'codex:c2', requestId: 'r3', state: 'resolved' },
  ]);
  answer(dash.ws, { sessionId: 'codex:c2', requestId: 'r3', choiceId: '0' });
  await settle();
  assert.deepEqual(responses(ch.inbox), []);
  dash.ws.close();
  ch.ws.close();
});

test('a session that disconnects expires its pending choice requests', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c3');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c3', 'r4');
  await settle();
  ch.ws.close();
  await settle();
  assert.deepEqual(dash.inbox.find((m) => m.type === 'permission_resolved'), {
    type: 'permission_resolved', sessionId: 'codex:c3', requestId: 'r4', state: 'expired',
  });
  dash.ws.close();
});

test('another connection cannot resolve a session it does not own', async () => {
  const ch = await open('/ws/channel');
  register(ch.ws, 'codex:c4');
  const other = await open('/ws/channel');
  register(other.ws, 'codex:other');
  await settle();
  const dash = await open('/ws/dashboard');
  request(ch.ws, 'codex:c4', 'r5');
  await settle();
  other.ws.send(JSON.stringify({ type: 'permission_resolved', sessionId: 'codex:c4', requestId: 'r5', state: 'resolved' }));
  await settle();
  assert.equal(dash.inbox.filter((m) => m.type === 'permission_resolved').length, 0);
  answer(dash.ws, { sessionId: 'codex:c4', requestId: 'r5', choiceId: '0' });
  await settle();
  assert.equal(responses(ch.inbox).length, 1);
  dash.ws.close();
  ch.ws.close();
  other.ws.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-permission-choices.test.ts`
Expected: FAIL — `choices`가 방송에 없음(undefined), `behavior: 'allow'`가 선택지 요청에 그대로 넘어감 등.

- [ ] **Step 3: Implement**

`src/hub/server.ts`:

타입 import에 `PermissionChoice`를 더한다:

```ts
import type { ChannelMessage, AppConfig, SessionInfo, WebhookConfig, TelegramConfig, PermissionChoice } from '../shared/types.js';
```

`const MAX_WS_PAYLOAD = …;` 아래에 추가:

```ts
const permissionKey = (sessionId: string, requestId: string) => `${sessionId}\n${requestId}`;

function validChoices(choices: unknown): PermissionChoice[] | undefined {
  if (!Array.isArray(choices)) return undefined;
  const valid = choices.filter((c): c is PermissionChoice => typeof c?.id === 'string' && typeof c?.label === 'string');
  return valid.length ? valid : undefined;
}
```

클래스 필드(`socketOwners` 아래)에 추가:

```ts
  // Codex approvals carry their own choices; a response is forwarded only in the mode of the request it answers.
  private choiceRequests = new Map<string, { sessionId: string; requestId: string; choiceIds: Set<string> }>();
```

`DELETE /api/sessions/:id` 분기의 `this.channelAlive.delete(sessionId);` 다음 줄에 `this.expireChoices(sessionId);`를 넣는다.

`handleChannelConnection`의 `ws.on('close')` 안 `this.channelAlive.delete(sessionId);` 다음 줄에 `this.expireChoices(sessionId);`를 넣는다(`broadcastToDashboards({ type: 'session_disconnected' … })`보다 앞).

`handleChannelMessage`의 `case 'permission_request'`를 통째로 바꾸고 `case 'permission_resolved'`를 추가:

```ts
      case 'permission_request': {
        this.sessions.updateActivity(msg.sessionId);
        const choices = validChoices(msg.choices);
        logger.info(`Permission request [${msg.requestId}] from ${msg.sessionId}: ${msg.toolName}`);
        if (choices) {
          this.choiceRequests.set(permissionKey(msg.sessionId, msg.requestId), {
            sessionId: msg.sessionId,
            requestId: msg.requestId,
            choiceIds: new Set(choices.map((c) => c.id)),
          });
        }
        this.broadcastToDashboards({
          type: 'permission_request',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          toolName: msg.toolName,
          description: msg.description,
          inputPreview: msg.inputPreview,
          timestamp: msg.timestamp,
          ...(choices ? { choices } : {}),
        });
        // Forward to Telegram
        if (this.telegramBot) {
          const label = this.getSessionLabel(this.sessions.get(msg.sessionId));
          if (choices) {
            void this.telegramBot.sendChoiceRequest(msg.sessionId, label, msg.requestId, msg.toolName, msg.description, msg.inputPreview, choices);
          } else {
            this.telegramBot.sendPermissionRequest(msg.sessionId, label, msg.requestId, msg.toolName, msg.description, msg.inputPreview);
          }
        }
        break;
      }

      case 'permission_resolved': {
        this.resolveChoice(msg.sessionId, msg.requestId, msg.state === 'expired' ? 'expired' : 'resolved');
        break;
      }
```

`handleDashboardConnection`의 `permission_response` 분기를 바꾼다:

```ts
        } else if (msg.type === 'permission_response') {
          if (this.forwardPermissionResponse(msg)) {
            const verdict = msg.choiceId !== undefined ? `choice ${msg.choiceId}` : msg.behavior;
            logger.info(`Permission verdict [${msg.requestId}]: ${verdict} -> session ${msg.sessionId}`);
          }
        }
```

`initTelegram`의 `onPermissionVerdict`를 바꾸고 `onChoiceVerdict`를 추가:

```ts
    this.telegramBot.onPermissionVerdict = (sessionId, requestId, behavior) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, behavior })) {
        logger.info(`Telegram permission verdict [${requestId}]: ${behavior} -> session ${sessionId}`);
      }
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    this.telegramBot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
      }
    };
```

`// --- Helpers ---` 아래(`broadcastToDashboards` 앞)에 메서드 추가:

```ts
  private forwardPermissionResponse(msg: { sessionId: string; requestId: string; behavior?: unknown; choiceId?: unknown }): boolean {
    const pending = this.choiceRequests.get(permissionKey(msg.sessionId, msg.requestId));
    let out: ChannelMessage;
    if (pending) {
      if (typeof msg.choiceId !== 'string' || !pending.choiceIds.has(msg.choiceId)) return false;
      out = { type: 'permission_response', sessionId: msg.sessionId, requestId: msg.requestId, choiceId: msg.choiceId };
    } else {
      if ((msg.behavior !== 'allow' && msg.behavior !== 'deny') || msg.choiceId !== undefined) return false;
      out = { type: 'permission_response', sessionId: msg.sessionId, requestId: msg.requestId, behavior: msg.behavior };
    }
    const channelWs = this.channelSockets.get(msg.sessionId);
    if (channelWs?.readyState !== WebSocket.OPEN) return false;
    channelWs.send(JSON.stringify(out));
    return true;
  }

  private resolveChoice(sessionId: string, requestId: string, state: 'resolved' | 'expired'): void {
    if (!this.choiceRequests.delete(permissionKey(sessionId, requestId))) return;
    this.broadcastToDashboards({ type: 'permission_resolved', sessionId, requestId, state });
    void this.telegramBot?.resolveChoiceRequest(sessionId, requestId, state);
  }

  private expireChoices(sessionId: string): void {
    for (const pending of [...this.choiceRequests.values()]) {
      if (pending.sessionId === sessionId) this.resolveChoice(sessionId, pending.requestId, 'expired');
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-permission-choices.test.ts test/hub-message-source.test.ts test/hub-ownership.test.ts` → PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 5: Commit**

```bash
git add src/hub/server.ts test/hub-permission-choices.test.ts
git commit -m "feat(hub): relay Codex approval choices and their resolution"
```

---

### Task 4: 대시보드 — 선택지 버튼 · 해결 표시 · 단축키 제외

**Files:**
- Modify: `src/dashboard/index.html`
- Test: `test/dashboard-permissions.test.ts`(생성)

**Interfaces:**
- Consumes: Hub가 방송하는 `permission_request.choices`, `permission_resolved`(Task 3). 대시보드는 `{ type: 'permission_response', sessionId, requestId, choiceId }`를 보낸다.
- Produces: 권한 블록 안의 함수 `permissionActions(r, sid)`, `shortcutRequest(reqs)`, `sendPermissionChoice(sessionId, requestId, choiceId)`.

- [ ] **Step 1: Write the failing tests**

`test/dashboard-permissions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate the permission relay block in a sandbox.
function loadPermissionHelpers() {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  // --- Permission relay ---');
  const end = html.indexOf('  // Flash title for attention');
  assert.ok(start > 0 && end > start, 'permission block anchors not found');
  const ctx: Record<string, unknown> = {
    state: { permissionRequests: {}, selectedSession: null },
    document: { addEventListener() {} },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderMarkdown: (s: string) => s,
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx as any;
}

const choiceReq = {
  requestId: 'r1',
  toolName: 'Command',
  description: 'Allow?',
  inputPreview: '{"command":"ls"}',
  resolved: false,
  choices: [{ id: '0', label: 'Allow once' }, { id: '1', label: 'Cancel task' }],
  sent: null,
};
const claudeReq = { requestId: 'r2', toolName: 'Bash', description: '', inputPreview: '{"command":"ls"}', resolved: false, choices: null };

test('Codex requests get one button per choice and no Enter/Esc hint', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions(choiceReq, 'codex:t1');
  assert.equal((html.match(/class="perm-choice"/g) || []).length, 2);
  assert.match(html, /data-choice-id="1"/);
  assert.doesNotMatch(html, /Enter|Esc/);
});

test('a sent choice shows what was sent instead of buttons', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions({ ...choiceReq, sent: '1' }, 'codex:t1');
  assert.doesNotMatch(html, /perm-choice/);
  assert.match(html, /Sent: Cancel task/);
});

test('Claude requests keep Allow and Deny', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions(claudeReq, 'claude-1');
  assert.match(html, /class="perm-allow"/);
  assert.match(html, /class="perm-deny"/);
});

test('Enter and Esc only answer Claude requests', () => {
  const h = loadPermissionHelpers();
  assert.equal(h.shortcutRequest([choiceReq]), undefined);
  assert.equal(h.shortcutRequest([choiceReq, claudeReq]).requestId, 'r2');
  assert.equal(h.shortcutRequest([{ ...claudeReq, resolved: true }]), undefined);
});

test('Codex commands preview like shell commands', () => {
  const h = loadPermissionHelpers();
  assert.equal(h.formatPermPreview('Command', '{"command":"New-Item x"}').text, '$ New-Item x');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-permissions.test.ts`
Expected: FAIL — `h.permissionActions is not a function`.

- [ ] **Step 3: Implement**

`src/dashboard/index.html`:

(a) CSS — `.perm-kbd { … }` 블록 바로 아래에 추가:

```css
  .perm-actions.choices {
    flex-direction: column;
    gap: 6px;
  }
  .perm-actions .perm-choice {
    padding: 7px 16px;
    font-size: 13px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .perm-actions .perm-choice:hover { border-color: var(--yellow); }
```

(b) `handleMessage`의 `case 'permission_request':` 안 `unshift({ … })` 객체에 세 필드를 더한다(`behavior: null,` 다음):

```js
          choices: msg.choices || null,
          sent: null,
          outcome: null,
```

(c) `case 'permission_response':` 블록 바로 뒤(`}` 닫기 전, 같은 switch 안)에 추가:

```js
      case 'permission_resolved': {
        const req = (state.permissionRequests[msg.sessionId] || []).find(r => r.requestId === msg.requestId);
        if (req && !req.resolved) {
          req.resolved = true;
          req.outcome = msg.state;
          renderPermissionBar();
          renderNotifications();
        }
        break;
      }
```

(d) `renderNotifications()`의 권한 버튼 부분 — `if (req && !req.resolved) {` 앞에 선택지 요청 분기를 넣어 다음처럼 만든다:

```js
        if (req && req.choices) {
          if (req.resolved) permButtons = `<div class="perm-resolved-label">${req.outcome === 'expired' ? 'Expired' : 'Resolved'}</div>`;
          else if (req.sent != null) permButtons = '<div class="perm-resolved-label">Sent</div>';
        } else if (req && !req.resolved) {
```

(기존 `else if (req && req.resolved) { … }`는 그대로 이어진다.)

(e) `formatPermPreview`의 `case 'Bash':` 위에 `case 'Command':`를 추가한다(둘이 같은 처리).

(f) `sendPermissionVerdict` 아래에 추가:

```js
  function sendPermissionChoice(sessionId, requestId, choiceId) {
    if (!state.ws) return;
    state.ws.send(JSON.stringify({ type: 'permission_response', sessionId, requestId, choiceId }));
    const req = (state.permissionRequests[sessionId] || []).find(r => r.requestId === requestId);
    if (req) req.sent = choiceId;
    renderPermissionBar();
    renderNotifications();
  }

  function permissionActions(r, sid) {
    const ids = `data-req-id="${esc(r.requestId)}" data-session-id="${esc(sid)}"`;
    if (!r.choices) {
      return `<button class="perm-allow" ${ids}>Allow <span class="perm-kbd">(Enter)</span></button>
          <button class="perm-deny" ${ids}>Deny <span class="perm-kbd">(Esc)</span></button>`;
    }
    if (r.sent != null) {
      const chosen = r.choices.find(c => c.id === r.sent);
      return `<div class="perm-resolved-label">Sent: ${esc(chosen ? chosen.label : r.sent)}</div>`;
    }
    return r.choices.map(c => `<button class="perm-choice" ${ids} data-choice-id="${esc(c.id)}">${esc(c.label)}</button>`).join('');
  }

  // Codex choices have no safe default, so Enter/Esc stay with the message box for them.
  function shortcutRequest(reqs) {
    return reqs.find(r => !r.resolved && !r.choices);
  }
```

(g) `renderPermissionBar()`의 `bar.innerHTML = reqs.map(r => { … })` 안 반환 템플릿을 다음으로 바꾼다:

```js
      return `<div class="perm-item">
        <div class="perm-icon">&#9888;</div>
        <div class="perm-info">
          <div class="perm-header">
            <span class="perm-tool">${esc(displayName)}</span>
          </div>
          ${r.choices && r.description ? `<div class="perm-desc">${esc(r.description)}</div>` : ''}
          ${previewText ? renderPermPreview(previewText, previewKind, previewLang) : ''}
        </div>
        <div class="perm-actions${r.choices ? ' choices' : ''}">${permissionActions(r, sid)}</div>
      </div>`;
```

(h) `bindPermissionButtons()` 끝에 추가:

```js
    (container || document).querySelectorAll('.perm-choice').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); sendPermissionChoice(btn.dataset.sessionId, btn.dataset.reqId, btn.dataset.choiceId); });
    });
```

(i) 키보드 처리기의 `const pending = reqs.find(r => !r.resolved);`를 `const pending = shortcutRequest(reqs);`로 바꾼다.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-permissions.test.ts test/dashboard-mention.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html test/dashboard-permissions.test.ts
git commit -m "feat(dashboard): answer Codex approvals with their own choices"
```

---

### Task 5: 어댑터 — 승인 요청 중계 · 응답 · 해결 · 만료

**Files:**
- Modify: `src/codex/adapter.ts`
- Modify: `test/helpers/fake-codex-daemon.ts`
- Test: `test/codex-adapter.test.ts`(기존 "approval requests raise a warning that names the command" 테스트를 지우고 아래 테스트 추가)

**Interfaces:**
- Consumes: `approvalView`, `fileChanges`, `ApprovalChoice`, `FileChange`(Task 1), `RpcClient.respond`, `RpcId`(Task 1), Hub 동작(Task 3)
- Produces: 데몬 승인 요청 → `permission_request{choices}`, Hub의 `permission_response{choiceId}` → JSON-RPC 응답 1회, `serverRequest/resolved` → `permission_resolved{resolved}`, Hub 연결을 닫을 때(대화 종료·데몬 끊김·정지) → `permission_resolved{expired}`

- [ ] **Step 1: Record adapter responses in the fake daemon**

`test/helpers/fake-codex-daemon.ts` — `FakeDaemon`에 필드를 추가하고 `onMessage` 첫 줄을 바꾼다:

```ts
  readonly responses: Array<{ id: number | string; result?: any; error?: any }> = [];
```

```ts
  private onMessage(ws: WebSocket, m: any): void {
    if (m.method === undefined) {
      if (m.id !== undefined) this.responses.push(m.error ? { id: m.id, error: m.error } : { id: m.id, result: m.result });
      return;
    }
```

- [ ] **Step 2: Write the failing tests**

`test/codex-adapter.test.ts` — 기존 `test('approval requests raise a warning that names the command', …)`를 지우고 파일 끝에 추가:

```ts
const approvalParams = {
  threadId: 't1',
  turnId: 'u3',
  itemId: 'i1',
  reason: 'Allow creating x?',
  command: 'New-Item x',
  availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['New-Item', 'x'] } }, 'cancel'],
};

async function approvalOnDashboard(
  d: FakeDaemon,
  dash: { inbox: any[] },
  id: number,
  method = 'item/commandExecution/requestApproval',
  params: any = approvalParams,
) {
  const before = dash.inbox.filter((m) => m.type === 'permission_request').length;
  d.serverRequest(id, method, params);
  return until(() => dash.inbox.filter((m) => m.type === 'permission_request')[before]);
}

const choose = (dash: { ws: WebSocket }, requestId: string, choiceId: string) =>
  dash.ws.send(JSON.stringify({ type: 'permission_response', sessionId: 'codex:t1', requestId, choiceId }));

test('command approvals reach the dashboard with the choices Codex offered', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 90);
    assert.equal(req.sessionId, 'codex:t1');
    assert.equal(req.toolName, 'Command');
    assert.equal(req.description, 'Allow creating x?');
    assert.deepEqual(JSON.parse(req.inputPreview), { command: 'New-Item x' });
    assert.deepEqual(req.choices, [
      { id: '0', label: 'Allow once' },
      { id: '1', label: 'Always allow this command' },
      { id: '2', label: 'Cancel task' },
    ]);
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.title === 'Codex approval needed'));
  } finally {
    dash.ws.close();
  }
});

test('the chosen decision is sent to Codex once', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 90);
    choose(dash, req.requestId, '1');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 90, result: { decision: approvalParams.availableDecisions[1] } });
    choose(dash, req.requestId, '0');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.responses.length, 1);
  } finally {
    dash.ws.close();
  }
});

test('a request answered elsewhere closes on the dashboard and takes no late answer', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 91);
    d.notify('serverRequest/resolved', { threadId: 't1', requestId: 91 });
    const resolved = await until(() => dash.inbox.find((m) => m.type === 'permission_resolved'));
    assert.deepEqual(resolved, { type: 'permission_resolved', sessionId: 'codex:t1', requestId: req.requestId, state: 'resolved' });
    choose(dash, req.requestId, '0');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('file change approvals list the files from the started item', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/started', {
      threadId: 't1',
      turnId: 'u3',
      startedAtMs: 0,
      item: { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: 'C:\\w\\proj\\a.txt', kind: { type: 'add' }, diff: 'hi' }] },
    });
    const req = await approvalOnDashboard(d, dash, 92, 'item/fileChange/requestApproval', {
      threadId: 't1', turnId: 'u3', itemId: 'p1', reason: null, grantRoot: null,
    });
    assert.equal(req.toolName, 'File change');
    assert.equal(JSON.parse(req.inputPreview).content, 'C:\\w\\proj\\a.txt\nhi');
    assert.deepEqual(req.choices.map((c: any) => c.label), ['Allow once', 'Allow for this session', 'Decline', 'Cancel task']);
    choose(dash, req.requestId, '2');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 92, result: { decision: 'decline' } });
  } finally {
    dash.ws.close();
  }
});

test('MCP tool approvals answer with an elicitation action', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 93, 'mcpServer/elicitation/request', {
      threadId: 't1',
      turnId: 'u3',
      serverName: 'claude-alarm',
      mode: 'form',
      message: 'Allow notify?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call' },
    });
    assert.equal(req.toolName, 'MCP tool');
    choose(dash, req.requestId, '0');
    await until(() => d.responses.length === 1);
    assert.deepEqual(d.responses[0], { id: 93, result: { action: 'accept', content: {} } });
  } finally {
    dash.ws.close();
  }
});

test('requests claude-alarm cannot relay point the user to Codex', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(94, 'item/tool/requestUserInput', { threadId: 't1', turnId: 'u3', itemId: 'q1', questions: [] });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.level, 'warning');
    assert.match(n.message, /Handle it in Codex/);
    assert.ok(!dash.inbox.some((m) => m.type === 'permission_request'));
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a request re-sent to a new subscription is shown once', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    await approvalOnDashboard(d, dash, 95);
    d.serverRequest(95, 'item/commandExecution/requestApproval', approvalParams);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(dash.inbox.filter((m) => m.type === 'permission_request').length, 1);
  } finally {
    dash.ws.close();
  }
});

test('losing the daemon expires pending approvals', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const req = await approvalOnDashboard(d, dash, 96);
    d.dropClient();
    const gone = await until(() => dash.inbox.find((m) => m.type === 'permission_resolved'));
    assert.deepEqual(gone, { type: 'permission_resolved', sessionId: 'codex:t1', requestId: req.requestId, state: 'expired' });
  } finally {
    dash.ws.close();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: 새 테스트 8개 FAIL(`permission_request`가 오지 않고 "Codex approval needed" 알림만 옴). 기존 테스트는 PASS.

- [ ] **Step 4: Implement**

`src/codex/adapter.ts`:

import를 바꾼다:

```ts
import { randomUUID } from 'node:crypto';
import { HubClient } from '../channel/hub-client.js';
import { CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { ChannelMessage, MessageSource, NotifyLevel, SessionInfo } from '../shared/types.js';
import { connectProxy, type ProxyConnection, type SpawnFn } from './transport.js';
import { RpcClient, type RpcId } from './rpc.js';
import { approvalView, fileChanges, type ApprovalChoice, type FileChange } from './approvals.js';
```

(`./mapping.js` import는 그대로.)

`Tracked`에 필드 추가:

```ts
  files: Map<string, FileChange[]>;
```

`APPROVAL_REQUESTS` 상수를 지우고 다음으로 바꾼다:

```ts
// Requests a person must answer that claude-alarm cannot relay; the user is pointed back to Codex.
const USER_REQUESTS = new Set(['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);

interface PendingApproval {
  threadId: string;
  rpcId: RpcId;
  choices: ApprovalChoice[];
  answered: boolean;
}
```

클래스 필드에 추가:

```ts
  private approvals = new Map<string, PendingApproval>();
```

`connect()`의 요청 리스너를 바꾼다:

```ts
      live.on('request', (id: RpcId, method: string, params: any) => this.onServerRequest(id, method, params));
```

`upsert()`의 `this.threads.set(thread.id, { … })` 객체에 `files: new Map(),`를 더한다.

`drop()`을 바꾼다(만료 알림은 Hub 연결을 닫기 전에 보내야 한다):

```ts
  private drop(threadId: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    for (const [requestId, a] of this.approvals) {
      if (a.threadId === threadId) this.finishApproval(requestId, 'expired');
    }
    this.threads.delete(threadId);
    clearTimeout(t.releaseTimer);
    t.releaseTimer = undefined;
    t.hub.disconnect();
  }
```

`onNotification()`의 `item/completed` 분기를 바꾸고 두 분기를 추가:

```ts
      case 'item/started':
        if (params.item?.type === 'fileChange') this.threads.get(params.threadId)?.files.set(params.item.id, fileChanges(params.item));
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') this.collect(params.threadId, params.turnId, params.item);
        if (params.item?.type === 'fileChange') this.threads.get(params.threadId)?.files.delete(params.item.id);
        break;
      case 'serverRequest/resolved':
        this.onResolved(params.threadId, params.requestId);
        break;
```

`onTurnCompleted()`에서 `t.turns.delete(turn.id);` 다음 줄에 `t.files.clear();`를 넣는다.

`onHubMessage()`에 분기 추가:

```ts
    } else if (msg.type === 'permission_response') {
      this.answer(threadId, msg.requestId, msg.choiceId);
    }
```

`onServerRequest()`를 통째로 바꾸고 아래 메서드들을 추가:

```ts
  private onServerRequest(rpcId: RpcId, method: string, params: any): void {
    const t = params?.threadId ? this.threads.get(params.threadId) : undefined;
    const view = t ? approvalView(method, params, t.files.get(params.itemId)) : null;
    if (!t || !view) {
      if (t && USER_REQUESTS.has(method)) {
        this.notify(t.thread.id, 'Codex is waiting', 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.', 'warning');
      } else {
        logger.debug(`Ignoring Codex server request ${method}`);
      }
      return;
    }
    // The daemon re-sends a pending request to every new subscriber, so a resubscribe can deliver it twice.
    for (const a of this.approvals.values()) {
      if (a.threadId === t.thread.id && a.rpcId === rpcId) return;
    }
    const requestId = randomUUID();
    this.approvals.set(requestId, { threadId: t.thread.id, rpcId, choices: view.choices, answered: false });
    t.hub.send({
      type: 'permission_request',
      sessionId: codexSessionId(t.thread.id),
      requestId,
      toolName: view.toolName,
      description: view.description,
      inputPreview: view.inputPreview,
      timestamp: Date.now(),
      choices: view.choices.map((c, i) => ({ id: String(i), label: c.label })),
    });
  }

  private answer(threadId: string, requestId: string, choiceId?: string): void {
    const a = this.approvals.get(requestId);
    if (!a || a.threadId !== threadId || a.answered || !this.rpc || !choiceId || !/^\d+$/.test(choiceId)) return;
    const choice = a.choices[Number(choiceId)];
    if (!choice) return;
    a.answered = true;
    this.rpc.respond(a.rpcId, choice.response);
  }

  private onResolved(threadId: string, rpcId: RpcId): void {
    for (const [requestId, a] of this.approvals) {
      if (a.threadId === threadId && a.rpcId === rpcId) this.finishApproval(requestId, 'resolved');
    }
  }

  private finishApproval(requestId: string, state: 'resolved' | 'expired'): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    this.threads.get(a.threadId)?.hub.send({ type: 'permission_resolved', sessionId: codexSessionId(a.threadId), requestId, state });
  }
```

- [ ] **Step 5: Run tests**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts` → PASS
Run: `npm test` → 전부 PASS
Run: `npx tsc --noEmit` → 오류 없음

- [ ] **Step 6: Commit**

```bash
git add src/codex/adapter.ts test/helpers/fake-codex-daemon.ts test/codex-adapter.test.ts
git commit -m "feat(codex): relay approvals with Codex's choices and sync their resolution"
```

---

### Task 6: README · 빌드 · 실제 Codex 확인(격리 Hub)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

`## Codex Sessions`의 목록에서 두 줄을 바꾼다.

`- Every loaded Codex conversation appears as a session with a **Codex** badge. Replies, failures and approval waits are relayed to the dashboard and Telegram.` →

```markdown
- Every loaded Codex conversation appears as a session with a **Codex** badge. Replies, failures and approval requests are relayed to the dashboard and Telegram.
```

`- Approvals still have to be answered in Codex; claude-alarm only tells you one is waiting.` →

```markdown
- Approvals for commands, file changes and MCP tools can be answered from the dashboard or Telegram with the choices Codex offers (for example **Allow once**, **Always allow this command**, **Cancel task**). Whoever answers first wins, in Codex or here; the other buttons close as **Resolved**, which does not say what was chosen. Requests that were pending when the hub or the adapter restarted show **Expired**; answer those in Codex.
- Questions Codex asks you (not approvals) still have to be answered in Codex; claude-alarm tells you one is waiting.
```

- [ ] **Step 2: Build and full test**

Run: `npm run build` → 성공
Run: `npm test` → 전부 PASS

- [ ] **Step 3: 실제 Codex 확인(지휘자가 직접, 격리 Hub)**

격리 HOME(`USERPROFILE`/`HOME` = 임시 폴더, 포트 7990, `codex.enabled: true`)으로 빌드된 Hub를 띄우고, 공유 데몬에 시험 대화(`sandbox: read-only`, `approvalPolicy: on-request`, cwd = scratchpad)를 만들어 확인한다. 대시보드는 WebSocket 클라이언트로 대신한다.

| 항목 | 기대 |
|---|---|
| 명령 승인 요청 | 대시보드에 `choices`(Allow once / Always allow this command / Cancel task 등)가 붙은 `permission_request`, 설명에 Codex의 `reason` |
| 대시보드에서 Decline 선택 | Codex가 거절로 처리하고 턴이 이어짐, `permission_resolved{resolved}` 수신 |
| 파일 변경 승인 | 미리보기에 대상 파일 경로·diff |
| 다른 클라이언트(터미널 대신 시험 스크립트)가 먼저 답함 | `permission_resolved{resolved}`, 그 뒤 대시보드 응답은 무시 |
| 시험 대화 | 끝나면 `thread/delete` |

사용자의 실제 Hub(1.0.1) 어댑터도 같은 데몬에 붙어 있으므로 시험 중 "Codex approval needed" 텔레그램이 갈 수 있다(사용자에게 미리 알림). 텔레그램 선택지 버튼은 배포 뒤 실제 Hub에서 사용자와 확인한다.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: explain answering Codex approvals from the dashboard and Telegram"
```
