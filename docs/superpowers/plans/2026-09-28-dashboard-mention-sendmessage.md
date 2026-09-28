# Dashboard @mention → SendMessage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 허브 페이지 입력창의 `@사용자 지정 이름`을 Claude Code 기본 `SendMessage`의 정확한 대상 이름으로 바꿔, 선택된 세션의 Claude가 그 세션에 전달하게 한다.

**Architecture:** 채널 서버가 `~/.claude/sessions/*.json`에서 자기 `ListAgents` 이름(`peerName`)을 찾아 허브에 등록하고, 허브는 이를 `SessionInfo`에 담아 대시보드로 방송만 한다. 대시보드가 `@토큰`을 사용자 지정 이름/폴더명으로 해석해 `[claude-alarm] @X = SendMessage to "Y"` 라우팅 줄을 붙여 기존 `message_to_session`으로 보낸다. 실제 전달은 Claude Code 기본 `SendMessage`.

**Tech Stack:** TypeScript (ESM, tsup), `ws`, `@modelcontextprotocol/sdk` 1.x, 단일 파일 대시보드(`src/dashboard/index.html`, 인라인 vanilla JS), 테스트는 `node:test` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-28-dashboard-mention-sendmessage-design.md`

## Global Constraints

- `@modelcontextprotocol/sdk`는 1.x 유지 — `server/discover`/`2026-07-28`을 지원하는 버전으로 올리면 채널이 admission에서 탈락한다.
- 채널 capability `'claude/channel'`, `'claude/channel/permission'` 값은 truthy(`{}`) 유지.
- 채널 instructions 총 길이 < 2,048자 (Claude Code가 초과분을 자름).
- `sessions/*.json` 읽기 실패는 절대 예외를 던지지 않고 `peerName` 없음으로 강등.
- 사용자 지정 이름은 대시보드 `localStorage`(`claude-alarm-session-meta`)에만 존재 — 허브로 동기화하지 않는다.
- 주석 규칙: 기본 없음. 외부 제약/함정만 영어로. 코드 재진술·변경 이력 주석 금지.
- 대시보드 UI 문자열은 기존과 같이 영어.
- `engines.node >=18` 유지(런타임 코드). 테스트 스크립트는 개발 환경 Node 22 기준.

## Review Focus

1. **한글 조사가 붙은 멘션** (`@프론트에 알려줘`) — 토큰이 `프론트에`가 되어 해석 실패. 조용히 잘못 보내지 말고 "이름 뒤에 공백" 안내와 함께 전송 차단해야 함. → Task 3 Step 6 수동 검증 항목.
2. **IME 조합 중 Enter** — 한글 `@프론` 입력 중 팝업이 열린 상태에서 조합 확정용 Enter가 전송이나 선택으로 처리되면 안 됨. → Task 4 keydown의 `e.isComposing` 분기 + Step 5 검증.
3. **이름에 `[`, `]`, `@` 포함** — `@[a]b]` 형태가 되어 파싱이 깨짐. rename 단계에서 거부. → Task 5.
4. **다른 세션의 폴더명과 같은 사용자 지정 이름** — 해석 1단계(사용자 이름)와 2단계(폴더명)가 서로 다른 세션을 가리켜 모호해짐. rename에서 거부. → Task 5.
5. **`sessions/*.json` 중 깨진 파일 혼입 / 폴더 없음** — 나머지 정상 파일로 계속 찾거나 `undefined`. → Task 1 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/channel/peer-name.ts` | 세션 레지스트리에서 자기 `ListAgents` 이름 찾기 (순수 함수 + I/O 래퍼) | 생성 |
| `test/peer-name.test.ts` | `findPeerName`/`readPeerName` 단위 테스트 | 생성 |
| `package.json` | `tsx` devDependency, `test` 스크립트 | 수정 |
| `src/shared/types.ts` | `SessionInfo.peerName`, `peer_name` 메시지 | 수정 |
| `src/channel/hub-client.ts` | 등록 시 최신 `peerName` 포함 | 수정 |
| `src/channel/server.ts` | `peerName` 폴링·허브 통지, instructions 라우팅 규칙 | 수정 |
| `src/hub/session-manager.ts` | `setPeerName` | 수정 |
| `src/hub/server.ts` | `peer_name` 처리·방송, 등록 로그에 peerName | 수정 |
| `src/dashboard/index.html` | 멘션 해석/라우팅 줄, 자동완성 팝업, rename 검증 | 수정 |
| `README.md` | `@mention` 사용법 | 수정 |

---

### Task 1: `peer-name` 모듈 + 테스트 인프라

**Files:**
- Create: `src/channel/peer-name.ts`
- Create: `test/peer-name.test.ts`
- Modify: `package.json` (scripts, devDependencies)

**Interfaces:**
- Produces:
  - `export interface PeerLookupEnv { messagingSocket?: string; sessionId?: string }`
  - `export function findPeerName(records: unknown[], env: PeerLookupEnv): string | undefined`
  - `export function readPeerName(env?: NodeJS.ProcessEnv): string | undefined`

- [ ] **Step 1: tsx 설치와 test 스크립트 추가**

Run: `npm install -D tsx`

`package.json`의 `scripts`에 추가:

```json
    "test": "node --import tsx --test \"test/**/*.test.ts\"",
```

(`--test`의 glob 인자는 Node 21+ 필요. 개발 환경은 Node 22.)

- [ ] **Step 2: 실패하는 테스트 작성**

`test/peer-name.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPeerName, readPeerName } from '../src/channel/peer-name.js';

const SOCK_A = '\\\\.\\pipe\\LOCAL\\cc-msg-aaa';
const SOCK_B = '\\\\.\\pipe\\LOCAL\\cc-msg-bbb';
const recA = { pid: 1, sessionId: 'sid-a', messagingSocketPath: SOCK_A, name: 'front-3a' };
const recB = { pid: 2, sessionId: 'sid-b', messagingSocketPath: SOCK_B, name: 'back-7f' };

test('matches by messaging socket', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: SOCK_B }), 'back-7f');
});

test('falls back to session id when socket is absent', () => {
  assert.equal(findPeerName([recA, recB], { sessionId: 'sid-a' }), 'front-3a');
});

test('socket match wins over session id match', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: SOCK_A, sessionId: 'sid-b' }), 'front-3a');
});

test('falls back to session id when socket matches nothing', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: 'nope', sessionId: 'sid-b' }), 'back-7f');
});

test('returns undefined when nothing matches', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: 'nope', sessionId: 'nope' }), undefined);
});

test('returns undefined when env is empty', () => {
  assert.equal(findPeerName([recA, recB], {}), undefined);
});

test('ignores empty or non-string names', () => {
  const blank = { ...recA, name: '  ' };
  const numeric = { ...recB, name: 42 };
  assert.equal(findPeerName([blank], { messagingSocket: SOCK_A }), undefined);
  assert.equal(findPeerName([numeric], { messagingSocket: SOCK_B }), undefined);
});

test('skips malformed records', () => {
  assert.equal(findPeerName([null, 'x', 7, recB], { messagingSocket: SOCK_B }), 'back-7f');
});

function makeConfigDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-name-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'sessions', name), body);
  }
  return dir;
}

test('readPeerName reads registry and skips corrupt files', () => {
  const dir = makeConfigDir({
    '1.json': '{ not json',
    '2.json': JSON.stringify(recB),
    '2.abc.key': 'secret',
  });
  const name = readPeerName({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK_B });
  assert.equal(name, 'back-7f');
});

test('readPeerName returns undefined when sessions dir is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-name-'));
  assert.equal(readPeerName({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-a' }), undefined);
});

test('readPeerName returns undefined without lookup env', () => {
  const dir = makeConfigDir({ '2.json': JSON.stringify(recB) });
  assert.equal(readPeerName({ CLAUDE_CONFIG_DIR: dir }), undefined);
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/channel/peer-name.js'` 계열 오류.

- [ ] **Step 4: 구현**

`src/channel/peer-name.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PeerLookupEnv {
  messagingSocket?: string;
  sessionId?: string;
}

interface SessionRecord {
  name?: unknown;
  messagingSocketPath?: unknown;
  sessionId?: unknown;
}

export function findPeerName(records: unknown[], env: PeerLookupEnv): string | undefined {
  const valid = records.filter((r): r is SessionRecord => typeof r === 'object' && r !== null);
  const nameOf = (match: (r: SessionRecord) => boolean): string | undefined => {
    const rec = valid.find(match);
    return typeof rec?.name === 'string' && rec.name.trim() ? rec.name : undefined;
  };
  if (env.messagingSocket) {
    const bySocket = nameOf((r) => r.messagingSocketPath === env.messagingSocket);
    if (bySocket) return bySocket;
  }
  if (env.sessionId) return nameOf((r) => r.sessionId === env.sessionId);
  return undefined;
}

// <configDir>/sessions/<pid>.json is Claude Code's undocumented peer registry
// (the source of ListAgents/SendMessage names, verified on 2.1.283). Its format
// may change between releases, so every failure must degrade to "no name".
export function readPeerName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lookup: PeerLookupEnv = {
    messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET,
    sessionId: env.CLAUDE_CODE_SESSION_ID,
  };
  if (!lookup.messagingSocket && !lookup.sessionId) return undefined;

  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dir = path.join(configDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }

  const records: unknown[] = [];
  for (const f of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {}
  }
  return findPeerName(records, lookup);
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm test`
Expected: 11 tests PASS.

- [ ] **Step 6: 빌드 확인**

Run: `npm run build`
Expected: 오류 없이 완료 (`test/`는 tsup 엔트리가 아니므로 번들에 포함되지 않음).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/channel/peer-name.ts test/peer-name.test.ts
git commit -m "feat(channel): resolve own SendMessage peer name from session registry"
```

---

### Task 2: peerName을 채널 → 허브 → 대시보드로 전달

**Files:**
- Modify: `src/shared/types.ts` (`SessionInfo`, `ChannelMessage`)
- Modify: `src/channel/hub-client.ts:13-19, 34-45`
- Modify: `src/channel/server.ts:13, 32-45, 55-62, 202-205`
- Modify: `src/hub/session-manager.ts` (메서드 추가)
- Modify: `src/hub/server.ts:356-377`

**Interfaces:**
- Consumes: `readPeerName(env?)` (Task 1)
- Produces:
  - `SessionInfo.peerName?: string` — 대시보드가 `state.sessions[id].peerName`으로 읽음 (Task 3, 4)
  - `ChannelMessage` 추가 멤버 `{ type: 'peer_name'; sessionId: string; peerName?: string }`
  - `SessionManager.setPeerName(sessionId: string, peerName: string | undefined): SessionInfo | undefined`
  - `HubClient` 생성자 6번째 인자 `getPeerName: () => string | undefined`

- [ ] **Step 1: 타입 추가**

`src/shared/types.ts` — `SessionInfo`에 `isLocal?: boolean;` 다음 줄로:

```ts
  peerName?: string;
```

`ChannelMessage` 유니온의 `| { type: 'status'; ... }` 다음 줄로:

```ts
  | { type: 'peer_name'; sessionId: string; peerName?: string }
```

- [ ] **Step 2: HubClient가 등록 시 최신 peerName 포함**

`src/channel/hub-client.ts` 생성자:

```ts
  constructor(
    private sessionId: string,
    private sessionName: string,
    private hubHost = DEFAULT_HUB_HOST,
    private hubPort = DEFAULT_HUB_PORT,
    private token?: string,
    private getPeerName: () => string | undefined = () => undefined,
  ) {}
```

`registration.session` 객체의 `channelEnabled: true,` 다음 줄로:

```ts
            peerName: this.getPeerName(),
```

- [ ] **Step 3: 채널 서버 — 폴링과 통지**

`src/channel/server.ts` import 블록(`import { HubClient } from './hub-client.js';` 다음)에:

```ts
import { readPeerName } from './peer-name.js';
```

`const sessionName = ...` 다음 줄에:

```ts
let peerName = readPeerName();
```

HubClient 생성을 다음으로 교체:

```ts
const hubClient = new HubClient(
  sessionId,
  sessionName,
  hubHost,
  hubPort,
  hubToken,
  () => peerName,
);
```

`main()` 안의 `hubClient.connect();` 바로 다음에:

```ts
  // The registry entry can be written after this MCP server starts, so re-check
  // shortly after boot, then poll to follow /rename.
  const refreshPeerName = () => {
    const next = readPeerName();
    if (next === peerName) return;
    peerName = next;
    logger.info(`Peer name: ${next ?? '(none)'}`);
    hubClient.send({ type: 'peer_name', sessionId, peerName: next });
  };
  setTimeout(refreshPeerName, 2_000).unref();
  setInterval(refreshPeerName, 30_000).unref();
```

- [ ] **Step 4: 채널 instructions에 라우팅 규칙 추가**

`src/channel/server.ts` instructions 템플릿 문자열에서 `IMAGES: ...` 단락 다음, `STATUS:` 단락 앞에 빈 줄로 구분해 추가:

```
ROUTING: If a dashboard message has lines like [claude-alarm] @X = SendMessage to "Y", do what the message asks and deliver the result with the SendMessage tool to exactly "Y". Never guess other recipients. Then reply to the dashboard with what you sent.
```

길이 확인:

Run: `node -e "const s=require('fs').readFileSync('src/channel/server.ts','utf8');console.log(s.match(/instructions: \`([\s\S]*?)\`,/)[1].length)"`
Expected: 2048 미만 (약 1,370).

- [ ] **Step 5: SessionManager.setPeerName**

`src/hub/session-manager.ts`의 `updateActivity` 앞에:

```ts
  setPeerName(sessionId: string, peerName: string | undefined): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.peerName = peerName;
    }
    return session;
  }
```

- [ ] **Step 6: 허브가 peer_name 처리**

`src/hub/server.ts` `handleChannelMessage`의 `register` 로그 줄을 교체:

```ts
        logger.info(`Session registered: ${session.id} (${session.name}, channel: ${session.channelEnabled ?? false}, peer: ${session.peerName ?? '-'})`);
```

`case 'status': { ... }` 블록 다음에:

```ts
      case 'peer_name': {
        const updated = this.sessions.setPeerName(msg.sessionId, msg.peerName);
        if (updated) {
          logger.info(`Peer name for ${msg.sessionId}: ${msg.peerName ?? '-'}`);
          this.broadcastToDashboards({ type: 'session_updated', session: updated });
        }
        break;
      }
```

- [ ] **Step 7: 타입체크·빌드·단위 테스트**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: 오류 없음, 11 tests PASS.

- [ ] **Step 8: E2E — 실제 Claude가 띄운 채널 서버의 peerName 도착 확인 (spike 미확인 항목)**

기존 허브(기본 포트)와 겹치지 않게 **포트 7999**의 임시 허브를 scratchpad 스크립트로 띄운다. 이 스크립트는 커밋하지 않는다.

`<scratchpad>/e2e-hub.mjs`:

```js
import { HubServer } from 'file:///C:/workspace/claude-alarm/dist/hub/server.js';
const hub = new HubServer({ hub: { host: '127.0.0.1', port: 7999, token: 'e2e-token' } });
await hub.start();
setTimeout(async () => {
  console.log(JSON.stringify(hub['sessions'].getAll().map(s => ({ name: s.name, peerName: s.peerName }))));
  await hub.stop();
  process.exit(0);
}, 25_000);
```

`<scratchpad>/e2e-mcp.json` (`<ABS>`는 `cygpath -m`한 저장소 절대 경로):

```json
{"mcpServers":{"claude-alarm":{"command":"node","args":["<ABS>/dist/channel/server.js"],"env":{"CLAUDE_ALARM_HUB_PORT":"7999","CLAUDE_ALARM_HUB_TOKEN":"e2e-token"}}}}
```

Run (두 명령을 병렬로. 허브 먼저):

```bash
node <scratchpad>/e2e-hub.mjs &
claude -p "Run the shell command: sleep 15. Then say ok." --mcp-config <scratchpad>/e2e-mcp.json --strict-mcp-config --allowedTools Bash --model haiku
wait
```

Expected: 허브 출력 JSON에 `peerName`이 `"<폴더명>-xx"` 형태로 존재하고, 같은 시각 `~/.claude/sessions/*.json` 중 하나의 `name`과 일치.

`peerName`이 비어 있으면: `-p` 세션이 레지스트리에 등록되지 않는 경우일 수 있다. 이때는 **사용자에게** interactive 세션으로 확인을 요청한다 (`claude --mcp-config <scratchpad>/e2e-mcp.json --dangerously-load-development-channels server:claude-alarm` 실행 후 허브 로그 `Session registered ... peer: <name>` 확인). 둘 다 비어 있으면 중단하고 보고 — 설계 전제가 깨진 것.

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/channel/hub-client.ts src/channel/server.ts src/hub/session-manager.ts src/hub/server.ts
git commit -m "feat: propagate SendMessage peer name from channel to dashboard"
```

---

### Task 3: 대시보드 — 전송 시 `@멘션` 해석과 라우팅 줄

**Files:**
- Modify: `src/dashboard/index.html` — CSS(`.message-input-area` 근처 ~403행), 마크업(~966행), `sessionDisplayName` 다음(~1096행)에 헬퍼, `sendMessage`(~1573행)
- Modify: `README.md` (`## Image Support` 앞에 섹션 추가)

**Interfaces:**
- Consumes: `state.sessions[id].peerName` (Task 2), 기존 `state.sessionMeta.names`, `state.selectedSession`, `$`, `esc`
- Produces (Task 4, 5가 사용하는 전역 함수):
  - `normName(s: string): string` — NFC + trim + lowercase
  - `folderName(s): string` — `s.displayName || s.name`
  - `mentionTargets(): SessionInfo[]` — 선택 세션 제외, `peerName` 있는 세션
  - `resolveMention(name: string): SessionInfo | null`
  - `buildRouting(text: string): { ok: true, content: string } | { ok: false, unknown: string[] }`
  - `showMentionError(msg: string | null): void`

- [ ] **Step 1: 오류 표시 영역 CSS**

`.message-input-area { ... }` 규칙 바로 앞에:

```css
  .mention-error {
    display: none;
    padding: 6px 20px 0;
    color: var(--red);
    font-size: 12px;
  }
  .mention-error.show { display: block; }
```

- [ ] **Step 2: 마크업**

`<div class="message-input-area">` 바로 앞에:

```html
    <div class="mention-error" id="mentionError"></div>
```

- [ ] **Step 3: 해석 헬퍼**

`function sessionDisplayName(s) { ... }` 바로 다음에:

```js
  // --- @mention → Claude Code SendMessage routing ---
  function normName(s) {
    return String(s).normalize('NFC').trim().toLowerCase();
  }

  function folderName(s) {
    return s.displayName || s.name;
  }

  function mentionTargets() {
    return Object.values(state.sessions).filter(s => s.id !== state.selectedSession && s.peerName);
  }

  function resolveMention(name) {
    const key = normName(name);
    const targets = mentionTargets();
    const byCustom = targets.filter(s => state.sessionMeta.names[s.id] && normName(state.sessionMeta.names[s.id]) === key);
    if (byCustom.length) return byCustom.length === 1 ? byCustom[0] : null;
    const byFolder = targets.filter(s => normName(folderName(s)) === key);
    return byFolder.length === 1 ? byFolder[0] : null;
  }

  function extractMentions(text) {
    const re = /(^|\s)@(?:\[([^\]\n]+)\]|([^\s\[\]]+))/g;
    const found = [];
    let m;
    while ((m = re.exec(text))) {
      const name = m[2] !== undefined ? m[2] : m[3].replace(/[.,!?;:)]+$/, '');
      found.push({ raw: m[0].trim(), name });
    }
    return found;
  }

  function buildRouting(text) {
    const mentions = extractMentions(text);
    if (!mentions.length) return { ok: true, content: text };
    const unknown = [];
    const lines = [];
    const seen = new Set();
    for (const m of mentions) {
      const s = resolveMention(m.name);
      if (!s) { unknown.push(m.raw); continue; }
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      lines.push(`[claude-alarm] @${m.name} = SendMessage to "${s.peerName}"`);
    }
    if (unknown.length) return { ok: false, unknown };
    return { ok: true, content: `${text}\n\n${lines.join('\n')}` };
  }

  function showMentionError(msg) {
    const el = $('#mentionError');
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
  }
```

- [ ] **Step 4: sendMessage에 적용**

`sendMessage()`에서 `if (!state.selectedSession || !state.ws) return;` 다음 줄에:

```js
    const routing = buildRouting(content);
    if (!routing.ok) {
      showMentionError(`Unknown session: ${routing.unknown.join(', ')} — pick from the @ list, or put a space right after the name.`);
      return;
    }
    showMentionError(null);
```

같은 함수의 두 전송 지점을 라우팅된 내용으로 교체:
- `image_upload`의 `content: content || '',` → `content: routing.content || '',`
- `message_to_session`의 `content }` → `content: routing.content }`

로컬 메시지 기록(`state.messages[...].push`)은 원문 `content`를 그대로 둔다 (라우팅 줄은 사용자에게 보여줄 필요 없음).

입력 시 오류 숨김 — 기존 `$('#msgInput').addEventListener('input', function() {` 본문 첫 줄에:

```js
    showMentionError(null);
```

- [ ] **Step 5: README 섹션**

`README.md`의 `## Image Support` 바로 앞에:

~~~markdown
## Mentioning Other Sessions

In the dashboard input, type `@<session name>` to have the selected session send something to another session through Claude Code's built-in `SendMessage`:

```
@front The UserVo response gained a deptNm field — let them know
```

- Names are the ones shown in the dashboard (your custom name, or the folder name). Names with spaces are written `@[my name]`.
- The dashboard resolves each mention to the target's `SendMessage` name and appends a routing line; unknown or ambiguous names block the send.
- Messages exchanged between sessions are not shown in the dashboard.
- Requires Claude Code with cross-session messaging (2.1.239+ on Windows).
~~~

- [ ] **Step 6: 수동 검증 (브라우저)**

`npm run build` 후 Task 2 Step 8의 임시 허브 방식이나 로컬 허브(`node dist/cli.js hub start`)로 대시보드를 열고, `peerName`이 있는 세션 2개(A, B)를 띄운다. A를 선택하고 B의 사용자 지정 이름을 `front`로 바꾼 뒤 확인한다.

| 입력 | 기대 결과 |
|---|---|
| `@front hi` | 전송됨. A 세션이 받은 채널 메시지 끝에 `[claude-alarm] @front = SendMessage to "<B peerName>"` |
| `@FRONT hi` | 위와 동일 (대소문자 무시) |
| `@front, hi` | 전송됨 (끝 쉼표 제거) |
| `@front에 알려줘` | 전송 차단, `Unknown session: @front에 — …` 표시 |
| `@nobody hi` | 전송 차단 |
| `mail a@b.com` | 멘션으로 보지 않음, 그대로 전송 |
| `@front @front hi` | 라우팅 줄 1개 |
| 입력창에 다시 타이핑 | 오류 문구 사라짐 |

A의 채널 메시지 원문은 A 터미널 transcript에서 확인한다.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/index.html README.md
git commit -m "feat(dashboard): route @mentions to Claude Code SendMessage targets"
```

---

### Task 4: 대시보드 — `@` 자동완성 팝업

**Files:**
- Modify: `src/dashboard/index.html` — CSS, `.message-input-area`에 팝업 마크업, Task 3 헬퍼 다음에 팝업 로직, 기존 `keydown`/`input` 리스너(~1614행)

**Interfaces:**
- Consumes: `normName`, `folderName`, `mentionTargets`, `sessionDisplayName`, `esc`, `$` (Task 3 및 기존)
- Produces: `closeMentionPopup(): void` (세션 전환 시 호출)

- [ ] **Step 1: CSS**

Task 3의 `.mention-error` 규칙 다음에:

```css
  .message-input-area { position: relative; }
  .mention-popup {
    display: none;
    position: absolute;
    bottom: calc(100% + 4px);
    left: 20px;
    min-width: 220px;
    max-height: 200px;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    z-index: 20;
  }
  .mention-popup.open { display: block; }
  .mention-item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .mention-item.active, .mention-item:hover { background: var(--border); }
  .mention-folder { color: var(--text-dim); font-size: 11px; }
```

- [ ] **Step 2: 마크업**

`<div class="message-input-area">` 여는 태그 바로 다음 줄에:

```html
      <div class="mention-popup" id="mentionPopup"></div>
```

- [ ] **Step 3: 팝업 로직**

Task 3의 `showMentionError` 다음에:

```js
  let mentionState = { open: false, items: [], index: 0, start: -1 };

  function currentMentionQuery(input) {
    const upto = input.value.slice(0, input.selectionStart);
    const m = upto.match(/(^|\s)@(\[[^\]\n]*|[^\s\[\]]*)$/);
    if (!m) return null;
    return { start: upto.length - m[2].length - 1, query: m[2].replace(/^\[/, '') };
  }

  function closeMentionPopup() {
    mentionState = { open: false, items: [], index: 0, start: -1 };
    $('#mentionPopup').classList.remove('open');
  }

  function renderMentionPopup() {
    $('#mentionPopup').innerHTML = mentionState.items.map((s, i) =>
      `<div class="mention-item${i === mentionState.index ? ' active' : ''}" data-idx="${i}">` +
      `<span>${esc(sessionDisplayName(s))}</span><span class="mention-folder">${esc(folderName(s))}</span></div>`
    ).join('');
  }

  function updateMentionPopup() {
    const q = currentMentionQuery($('#msgInput'));
    if (!q) return closeMentionPopup();
    const key = normName(q.query);
    const items = mentionTargets().filter(s =>
      normName(sessionDisplayName(s)).includes(key) || normName(folderName(s)).includes(key));
    if (!items.length) return closeMentionPopup();
    const index = mentionState.open ? Math.min(mentionState.index, items.length - 1) : 0;
    mentionState = { open: true, items, index, start: q.start };
    renderMentionPopup();
    $('#mentionPopup').classList.add('open');
  }

  function applyMention(s) {
    const input = $('#msgInput');
    const label = sessionDisplayName(s);
    const token = /\s/.test(label) ? `@[${label}] ` : `@${label} `;
    const before = input.value.slice(0, mentionState.start);
    const after = input.value.slice(input.selectionStart);
    input.value = before + token + after;
    const pos = before.length + token.length;
    input.setSelectionRange(pos, pos);
    closeMentionPopup();
    input.focus();
  }

  $('#mentionPopup').addEventListener('mousedown', (e) => {
    const item = e.target.closest('.mention-item');
    if (!item) return;
    e.preventDefault();
    applyMention(mentionState.items[Number(item.dataset.idx)]);
  });
```

- [ ] **Step 4: 키 입력 연결**

기존 리스너를 교체:

```js
  $('#msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
```

→

```js
  $('#msgInput').addEventListener('keydown', (e) => {
    if (mentionState.open) {
      // Enter while an IME (e.g. Korean) is composing only commits the syllable.
      if (e.isComposing) return;
      const n = mentionState.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.index = (mentionState.index + 1) % n; renderMentionPopup(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.index = (mentionState.index - 1 + n) % n; renderMentionPopup(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionState.items[mentionState.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeMentionPopup(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#msgInput').addEventListener('blur', closeMentionPopup);
  $('#msgInput').addEventListener('click', updateMentionPopup);
```

기존 `input` 리스너 본문 끝(높이 조정 다음)에:

```js
    updateMentionPopup();
```

`sendMessage()`의 `input.value = '';` 다음 줄에:

```js
    closeMentionPopup();
```

- [ ] **Step 5: 수동 검증 (브라우저)**

Task 3 Step 6과 같은 환경에서:

| 동작 | 기대 결과 |
|---|---|
| 빈 입력에 `@` | 선택 세션을 뺀 peerName 있는 세션 목록 팝업 |
| `@fr` | `front` 등 부분 일치만 남음 |
| ↓/↑ | 강조 이동, 끝에서 순환 |
| Enter | `@front ` 삽입 (끝에 공백), 메시지는 전송 안 됨 |
| Tab | Enter와 동일 |
| Esc | 팝업 닫힘, 다음 Enter는 전송 |
| 항목 클릭 | 삽입, 입력창 포커스 유지 |
| 공백 이름(`ebill back`) 선택 | `@[ebill back] ` 삽입 → 전송 시 해석 성공 |
| 한글 IME로 `@프론` 입력 중 Enter | 음절 확정만 되고 선택/전송 안 됨. 다음 Enter에 선택 |
| `a@` (앞이 공백 아님) | 팝업 안 뜸 |
| peerName 있는 다른 세션 없음 | 팝업 안 뜸 |

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/index.html
git commit -m "feat(dashboard): add @ session autocomplete in message input"
```

---

### Task 5: 대시보드 — rename 이름 검증

**Files:**
- Modify: `src/dashboard/index.html` — CSS, `startRename`의 `commit`(~1311-1325행)

**Interfaces:**
- Consumes: `normName`, `folderName`, `sessionDisplayName` (Task 3 및 기존)
- Produces: `renameError(val: string, id: string): string | null`

- [ ] **Step 1: CSS**

기존 `.name-edit-input { ... }` 규칙(~178행) 바로 다음에:

```css
  .name-edit-input.invalid { border-color: var(--red) !important; }
```

- [ ] **Step 2: 검증 함수**

Task 3의 `normName` 다음에:

```js
  function renameError(val, id) {
    if (/[\[\]@]/.test(val)) return 'Name cannot contain [, ] or @';
    const key = normName(val);
    const taken = Object.values(state.sessions).some(o => o.id !== id &&
      (normName(sessionDisplayName(o)) === key || normName(folderName(o)) === key));
    return taken ? 'Name already used by another session' : null;
  }
```

- [ ] **Step 3: commit 로직 교체**

`startRename` 안의 `commit`과 리스너를 교체:

```js
    let done = false;
    const commit = (save, fromBlur) => {
      if (done) return;
      if (save) {
        const val = input.value.trim();
        const baseName = s.displayName || s.name;
        const err = val && val !== baseName ? renameError(val, id) : null;
        if (err) {
          if (!fromBlur) {
            input.classList.add('invalid');
            input.title = err;
            return;
          }
          save = false;
        }
      }
      done = true;
      if (save) {
        const val = input.value.trim();
        const baseName = s.displayName || s.name;
        if (!val || val === baseName) delete state.sessionMeta.names[id];
        else state.sessionMeta.names[id] = val;
        saveSessionMeta();
      }
      renderSessions();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true, false); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false, false); }
    });
    input.addEventListener('input', () => { input.classList.remove('invalid'); input.title = ''; });
    input.addEventListener('blur', () => commit(true, true));
```

(Enter에서 오류 → 편집 유지 + 빨간 테두리 + title 툴팁. blur에서 오류 → 변경 버림.)

- [ ] **Step 4: 수동 검증 (브라우저)**

세션 A, B(폴더명 `kg_ebill_front`)가 떠 있는 상태:

| 동작 (A 이름 편집) | 기대 결과 |
|---|---|
| `kg_ebill_front` + Enter | 빨간 테두리, 저장 안 됨, 편집 유지 |
| B를 `front`로 바꾼 뒤 A에 `FRONT` + Enter | 거부 |
| `a[b]` + Enter | 거부 (`[, ] or @`) |
| 거부 상태에서 다른 곳 클릭(blur) | 원래 이름으로 복귀 |
| 거부 후 타이핑 | 빨간 테두리 해제 |
| `backend` + Enter | 저장됨, `@backend` 자동완성에 반영 (B를 선택한 상태에서 확인) |
| 빈 값 + Enter | 사용자 지정 이름 삭제 (기존 동작) |

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html
git commit -m "feat(dashboard): reject duplicate or unparseable session names"
```

---

## 최종 확인

- [ ] `npx tsc --noEmit && npm run build && npm test` 모두 통과
- [ ] 실제 흐름 1회: 세션 A에서 `@<B> …` 전송 → A의 Claude가 `SendMessage`로 B에 전달 → B 터미널에 수신 → A가 대시보드에 reply
- [ ] `git diff main --stat`에 `src/locales` 등 무관 파일 없음
