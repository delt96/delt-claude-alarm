# Codex 어댑터 설계

날짜: 2026-10-01
대상: 신규 `src/codex/*`, `src/shared/types.ts`, `src/shared/config.ts`, `src/hub/server.ts`, `src/hub/session-manager.ts`, `src/hub/telegram.ts`, `src/dashboard/index.html`, `src/cli.ts`, `tsup.config.ts`, `README.md`

## 배경

claude-alarm은 Claude Code 세션만 대시보드·텔레그램으로 보고 제어한다. 사용자는 Codex도 함께 쓰며, 장기적으로 어느 AI가 주가 되든 같은 도구로 관리하려 한다. 이번 작업의 목표는 둘이다.

1. **Codex 추가** — Codex 대화를 대시보드 세션으로 보여 주고 상태·응답·승인을 중계한다
2. **Codex 세션에 메시지** — 대시보드·텔레그램에서 Codex 대화에 지시하고 응답을 받는다

설계 경위: Claude가 지시서를 쓰고 Codex가 초안을 작성(공유 데몬 위임, 읽기 전용) → Claude 검토 → 사용자 결정 → 사용자가 터미널에서 연 실험용 대화로 사전 확인. 경위와 원문은 Obsidian `Projects/claude_alarm/docs/tasks/2026-10-01-codex-어댑터-설계.md`, `…-codex-초안.md`, 0단계 실측은 `2026-10-01-ai-중립-협업-개발-실험-계획.md`.

## 목표 / 비목표

목표: 공유 app-server 데몬의 Codex 대화(터미널·앱 등에서 연 것)를 Hub 세션으로 등록하고, 응답·완료·오류를 대시보드·텔레그램에 전달하며, 대시보드·텔레그램에서 지시와 승인을 보낸다. Codex가 없는 환경에서는 아무것도 바뀌지 않는다.

비목표: 자동 승인(별도 조사 문서), Claude→Codex 작업 위임(Jev 판단 + CLI 위임 스킬로 별도 진행), 웹에서 새 Codex 대화 시작, 응답 스트리밍, Hub 재시작 후 대기 중 승인 복원, 다른 PC Hub로의 이미지 파일 공유.

## 확인된 전제 (Codex 0.159.3 실측)

| 사실 | 근거 |
|---|---|
| 데몬 연결은 `codex app-server proxy`를 자식으로 띄우고 그 stdio 위에 WebSocket을 얹는다. JSONL을 그대로 쓰면 응답 없음 | 0단계 |
| `thread/loaded/list` + `thread/read(includeTurns:false)`로 대화 발견. `thread/started`·`thread/status/changed`는 구독 없이 모든 클라이언트에 방송 | 0단계 |
| 사용자가 터미널에서 연 대화에 `thread/resume(excludeTurns:true)`로 구독해도 터미널 화면에 변화 없고 목표(goal)도 유지된다. 구독 시 오는 `thread/goal/cleared`는 "목표 없음" 상태 알림이다 | 사전 확인 |
| 새 대화는 첫 턴 전에는 resume이 `no rollout found`로 실패한다 | 0단계 |
| 외부 `turn/start`는 터미널에 사용자가 입력한 것과 똑같이 보인다 | 사전 확인 |
| 승인 요청은 구독자 전원에게 오고 누구든 답할 수 있다. 해결되면 `serverRequest/resolved{threadId, requestId}`가 전원에게 가며, 외부에서 승인하면 터미널 승인 창이 저절로 닫힌다. resolved는 누가 무엇을 골랐는지 알려 주지 않는다 | 사전 확인 |
| 명령 승인 요청에는 `availableDecisions`(예: `["accept", {acceptWithExecpolicyAmendment:{…}}, "cancel"]`)와 `reason`이 들어 있다. 이 필드는 생성한 스키마에는 없다 | 사전 확인 |
| `thread/turns/list({limit, sortDirection:'desc'})`의 첫 항목이 진행 중 턴(`inProgress`)이다 | 사전 확인 |
| `turn/steer`는 즉시 접수되지만 진행 중인 응답이 끝난 뒤 같은 턴에서 반영된다 | 0단계, 사전 확인 |
| Hub는 WebSocket 연결 하나에 세션 하나만 묶는다(`src/hub/server.ts:381-400` `socketOwners`) | 코드 |
| 승인 대기 중에 새로 구독(`thread/resume`)한 클라이언트에도 대기 중인 승인 요청이 **같은 요청 ID로 다시 온다**. 요청 ID는 데몬 전체에서 같은 값이다(두 클라이언트 모두 30) | 단계 B 사전 실측 |
| 이미 해결된 요청에 다시 답하면 데몬은 오류 없이 무시한다 | 단계 B 사전 실측 |
| 파일 변경 승인 요청(`item/fileChange/requestApproval`)에는 `threadId`·`turnId`·`itemId`·`reason`(null 가능)·`grantRoot`만 있고 파일 목록이 없다. 파일 목록은 같은 `itemId`의 `item/started`(`type:'fileChange'`, `changes[].path`·`diff`)에 먼저 온다 | 단계 B 사전 실측 |
| 승인 대기 중 상태는 `active` + `activeFlags:['waitingOnApproval']`이고, 해결되면 `serverRequest/resolved` 뒤 플래그가 빠진다 | 단계 B 사전 실측 |
| `turn/steer`는 즉시 `{turnId}`로 접수되고, 지금 진행 중인 단계(예: 12초 명령)가 끝난 뒤 같은 턴에서 읽혀 그 턴의 최종 답에 반영된다 | 단계 C 사전 실측(app-server 0.160.0) |
| 진행 중인 턴이 없으면(첫 턴 전, 턴 종료 직후) `turn/steer`는 `no active turn to steer`, 턴 ID가 다르면 ``expected active turn id `X` but found `Y` ``로 실패한다 | 단계 C 사전 실측 |
| 승인 대기 중에도 `turn/steer`는 접수되지만, 승인이 해결된 뒤에야 읽힌다. steer가 승인에 답하지는 않는다 | 단계 C 사전 실측 |
| `{type:'image', url:'data:image/png;base64,…'}`는 `turn/start`와 `turn/steer` 모두에서 동작한다 | 단계 C 사전 실측 |
| `{type:'localImage', path}`는 파일을 턴 시작 시점이 아니라 나중에 읽는다. `turn/start` 응답 직후 파일을 지우면 모델이 이미지를 보지 못했다 | 단계 C 사전 실측 |
| 첫 턴 전의 새 대화에는 `thread/turns/list`가 `… is not materialized yet; thread/turns/list is unavailable before first user message`로 실패한다 | 단계 C 사전 실측 |
| 실행 중인 대화에 `turn/start`를 보내면 새 턴을 만들지 않고 진행 중인 턴에 steer된다(같은 턴 ID를 돌려주고 최종 답에 반영) | 단계 C 사전 실측 |

## 설계

### 1. 실행 형태

- 어댑터는 **별도 Node 프로세스**(`dist/codex/adapter.js`)다. 포트를 열지 않고 데몬과 Hub 양쪽의 클라이언트로만 동작한다. Hub 내부 모듈로 넣지 않는 이유: Codex 쪽 장애·업데이트가 Hub 수명에 묶이지 않게 하기 위해서다.
- **Hub가 띄우는 경우(같은 PC, 기본 경로)**: `config.codex.enabled`가 `true`이면 Hub가 `start()`에서 어댑터를 자식 프로세스로 띄운다. 자식이 죽으면 2초부터 60초까지 간격을 늘려 다시 띄우고, `hub.stop()`에서 끈다. 자식의 stdin은 파이프로 연결해 두고 어댑터는 stdin이 닫히면 종료한다 — Windows에서 `hub stop`(`process.kill(pid,'SIGTERM')`)은 Hub의 종료 처리기를 실행하지 않으므로 이 방법으로 고아 프로세스를 막는다.
- **직접 띄우는 경우(Codex가 다른 PC)**: `claude-alarm codex start|stop|status`. Hub처럼 분리 실행하고 `~/.claude-alarm/codex.pid`를 쓴다. 접속할 Hub는 기존 설정(`hub.host`, `hub.port`, `hub.token`)을 쓴다.
- 한 PC에서는 어댑터 하나만 돈다. 어댑터가 시작할 때 `~/.claude-alarm/codex.pid`를 확인하고 살아 있는 다른 어댑터가 있으면 종료 코드 0으로 끝낸다(Hub는 종료 코드 0이면 다시 띄우지 않는다). 두 실행 경로가 같은 pid 파일을 쓴다.
- `claude-alarm codex enable|disable`로 `config.codex.enabled`를 바꾼다. 기본값은 꺼짐이다 — 켜지 않은 사용자의 Codex 대화가 대시보드·텔레그램에 나타나면 안 된다.
- Codex 실행 파일은 `config.codex.command`(기본 `codex`)이고, `spawn(command, ['app-server', 'proxy'], { shell: false, windowsHide: true })`로 띄운다. 예외: Windows에서 npm으로 설치한 Codex는 `codex.cmd` 셈이라 셸로만 실행되므로, PATH에서 `codex.exe`가 없고 `codex.cmd`만 있으면 셸로 실행한다. 어느 경우든 명령줄에는 고정 인자만 넣고 사용자 입력을 넣지 않는다.

```ts
// AppConfig 확장
codex?: { enabled: boolean; command?: string };
```

### 2. 어댑터 내부 구성

| 모듈 | 책임 |
|---|---|
| `src/codex/transport.ts` | proxy 자식 프로세스, stdio Duplex, WebSocket(`ws`의 `createConnection`), Windows 명령 해석 |
| `src/codex/rpc.ts` | 요청 ID·응답 매칭, 서버 요청·알림 분배, 타임아웃 |
| `src/codex/mapping.ts` | 대화→세션 변환 순수 함수(제목, 상태, 출처 표시, 최종 답) |
| `src/codex/adapter.ts` | 발견·구독·대화별 Hub 연결·응답·지시·재연결 |
| `src/codex/main.ts` | 실행 진입점, pid 파일, stdin 감시 |
| `src/codex/approvals.ts` | 승인 요청 → 선택지, 응답, 해결 동기화 (단계 B) |

대화별 Hub 연결은 기존 `HubClient`(`src/channel/hub-client.ts`)에 등록 정보 확장·재등록·끊은 뒤 재연결 금지를 더해 재사용한다.

### 3. 대화 발견과 구독

- 연결 후 `initialize({clientInfo:{name:'claude-alarm', version}})` → `initialized`. 응답의 `userAgent`를 로그에 남긴다(버전 문제 추적용).
- `thread/loaded/list`를 끝 페이지까지 읽고 각 ID를 `thread/read`로 보충한다. 이후 `thread/started`, `thread/status/changed`, `thread/name/updated`, `thread/closed`, `thread/archived`, `thread/deleted` 방송으로 갱신한다.
- 대상: loaded 상태이고 `parentThreadId`가 없으며(서브에이전트 제외) `ephemeral`이 아닌 대화.
- **대화는 작업 중일 때만 구독한다**(2026-10-01 수정). 상태가 `active`가 되거나 대시보드 지시를 보낼 때 `thread/resume({threadId, excludeTurns:true})`(다른 필드는 넣지 않음)로 구독하고, 턴이 끝나거나(`turn/completed`) `active`가 아닌 상태가 되면 `thread/unsubscribe`한다. 처음 스펙은 "전부 자동 구독"이었으나, 실측 결과 데몬은 구독자가 있는 동안 대화를 유지하고 마지막 구독자가 떠난 뒤 60초 뒤에 내린다. 그래서 자동 구독은 닫힌 Codex 창의 대화를 계속 붙잡았다(세션이 사라지지 않음). 상태 변화는 구독 없이도 방송되므로, 터미널에서 시킨 작업도 시작 시점에 구독해 응답·승인을 받는다.
- 구독이 실패하면(예: `no rollout found`) 다음 상태 방송 때 다시 시도한다.
- `notLoaded`·closed·archived·deleted가 되면 그 대화의 Hub 연결을 닫는다(→ 대시보드에서 사라짐). 다시 loaded되면 새로 등록한다. Codex 창을 닫으면, 어댑터가 그 대화를 구독하고 있지 않은 한 약 60초 뒤 `notLoaded`가 와서 세션이 사라진다.

### 4. Hub 세션 매핑

대화마다 Hub 연결(`/ws/channel`, 기존 토큰 인증)을 하나씩 열고 `register`한다. 기존 소유권·heartbeat·재연결 규칙을 그대로 쓴다.

```ts
// SessionInfo 확장 (생략 시 기존 Claude 세션)
agentKind?: 'claude' | 'codex';
title?: string;   // Codex 대화 제목
```

| 필드 | 값 |
|---|---|
| `id` | `codex:<threadId>` |
| `name`, `title` | `thread.name` → 없으면 `preview` 앞 30자 → 없으면 cwd 폴더명 |
| `cwd` | `thread.cwd` |
| `agentKind` | `'codex'` |
| `channelEnabled` | `true` |

- `SessionManager.register`는 `title`이 있으면 cwd 폴더명 대신 그것을 기준 이름으로 쓴다. 중복 번호 규칙은 같다.
- `thread/name/updated` → 같은 연결로 `register`를 다시 보낸다(Hub가 `session_updated`로 방송).
- 상태 변환: `active`(플래그 없음) → `working` / `active`+`waitingOnApproval` 또는 `waitingOnUserInput` → `waiting_input` / `idle` → `idle` / `systemError` → `idle` + 오류 `notify`.

### 5. 응답과 완료 알림

- `item/completed`의 `agentMessage`를 턴별로 모으고, `turn/completed`에서 `phase:'final_answer'`인 것들을 순서대로 이어(하나도 없으면 마지막 `agentMessage` 하나) `reply`로 보낸다. `turn/completed`의 `items`는 요약본일 수 있으므로 모아 둔 것을 쓴다. 기존 `reply` 경로라 대시보드 기록과 텔레그램 알림이 그대로 동작한다.
- **터미널에서 시킨 턴도 포함한다.** 자리를 비웠을 때 Codex 작업 완료를 텔레그램으로 받는 것이 이 기능의 핵심이다.
- 턴이 실패로 끝나면(`turn.status`가 failed 또는 `turn.error` 있음) `notify`(level `error`).
- 구독 이전 턴은 보내지 않는다.

### 6. 지시 보내기

- `message_to_session`에 `source?: 'dashboard' | 'telegram' | 'api'`를 추가한다. Hub가 채운다(대시보드 소켓, 텔레그램 콜백, `/api/send`). 기존 Claude 채널은 이 필드를 무시한다.
- 어댑터는 대화가 `idle`이면 `turn/start({threadId, input:[{type:'text', text}]})`로 보낸다. **text 앞에 출처를 붙인다**: `[claude-alarm · Dashboard]`, `[claude-alarm · Telegram]`, `[claude-alarm · API]` — 터미널에서 외부 지시를 구분할 수 있게 하기 위한 사용자 결정이다. 문구는 기존 UI와 같이 영어로 쓴다.
- 대화가 실행 중이거나 승인 대기면 보내지 않고 `notify`(level `warning`, "Codex is busy, so the message was not delivered. Send it again when the task finishes.")를 돌려준다. 실행 중 추가 지시는 단계 C(§9에서 이 규칙을 바꾼다).
- `turn/start` 실패도 `notify`(warning)로 알린다. 자동 재전송은 하지 않는다.
- `image_to_session`이 Codex 세션으로 오면 단계 A에서는 "Codex sessions do not accept images yet." `notify`(단계 C에서 §9로 바뀐다).
- 대시보드 `@멘션` 라우팅 줄(`[claude-alarm] @X = SendMessage …`, `index.html:1206`)은 대상 세션이 Codex면 붙이지 않는다. Codex 세션은 멘션 대상 목록에도 나오지 않는다(`peerName` 없음, `index.html:1157`).
- 텔레그램 세션 선택 버튼(`telegram.ts:244`, `410`)은 지금 현재 목록의 순번으로 해석된다. Codex 세션은 수시로 늘고 줄므로, 선택 메시지를 보낼 때의 세션 ID 목록을 메시지 ID별로 메모리에 보관하고 콜백은 그 목록으로 해석한다.

### 7. 대시보드·텔레그램 표시

- 세션 목록에 에이전트 배지(Claude/Codex)를 붙인다.
- 메시지 작성자 표기 `'Claude'` 고정(`index.html:1619`)을 세션의 `agentKind`에 따라 바꾼다.
- 텔레그램 응답·알림 제목의 세션 라벨 앞에 `[Codex]`를 붙인다(Claude 세션은 그대로).

### 8. 승인 중계 (단계 B)

대상 서버 요청:

| 요청 | 선택지 | 응답 형식 |
|---|---|---|
| `item/commandExecution/requestApproval` | `availableDecisions`가 있으면 그대로, 없으면 `accept`·`decline`·`cancel` | `{decision}` |
| `item/fileChange/requestApproval` | `accept`·`acceptForSession`·`decline`·`cancel` | `{decision}` |
| `mcpServer/elicitation/request`(`_meta.codex_approval_kind === 'mcp_tool_call'`만) | 허용·거절·취소 | `{action:'accept', content:{}}` / `{action:'decline'}` / `{action:'cancel'}` |

그 밖의 서버 요청(`item/tool/requestUserInput`, `item/permissions/requestApproval`, 일반 MCP 입력 요청 등)에는 응답하지 않는다. 세션은 `waiting_input`으로 보이고 "Handle it in Codex." `notify`를 보낸다.

선택지 라벨(영어 UI): `accept` Allow once / `acceptForSession` Allow for this session / `acceptWithExecpolicyAmendment` Always allow this command / `applyNetworkPolicyAmendment` Network rule: `<host>` `<allow|deny>` / `decline` Decline / `cancel` Cancel task.

```ts
// permission_request 확장: choices가 있으면 선택지 모드
choices?: { id: string; label: string }[];
// permission_response 확장: 선택지 모드는 behavior 대신 choiceId
choiceId?: string;
// 신규 (어댑터 → Hub → 대시보드·텔레그램)
{ type: 'permission_resolved'; sessionId: string; requestId: string; state: 'resolved' | 'expired' }
```

- Hub용 `requestId`는 어댑터가 만드는 불투명 문자열이다. 어댑터는 이를 원래 JSON-RPC ID(숫자/문자열 그대로)와 선택지별 정확한 응답 값에 매핑해 둔다. `choiceId`는 선택지 배열의 인덱스 문자열이다.
- 표시 내용(영어 UI): 명령은 `toolName:'Command'`, 설명은 요청의 `reason`(없으면 "Codex wants to run a command."), 미리보기는 `command` 원문. 파일 변경은 `toolName:'File change'`, 미리보기는 같은 `itemId`의 `item/started`에서 받아 둔 파일 경로와 diff(못 받았으면 "The file list is not available here. Check the Codex window."). MCP 도구는 `toolName:'MCP tool'`, 설명은 서버 이름, 미리보기는 요청의 `message`. MCP 선택지 라벨은 Allow / Decline / Cancel.
- 같은 대화·같은 JSON-RPC ID의 요청이 다시 오면(재구독 시 데몬이 다시 보냄) 새 요청으로 만들지 않는다.
- 응답은 어댑터가 한 번만 보낸다. 대시보드와 텔레그램에서 동시에 눌러도 두 번째는 무시한다.
- `serverRequest/resolved` → `permission_resolved{state:'resolved'}`. resolved는 결과를 알려 주지 않으므로 화면에는 "해결됨"으로만 표시하고 허용·거절을 추정하지 않는다. 데몬 연결이 끊기거나 대화가 닫혀(closed·notLoaded 등) Hub 연결을 닫을 때 대기 중 요청은 `expired`로 보낸다. Hub도 선택지 요청을 보낸 세션의 연결이 끊기면 그 요청들을 `expired`로 알린다(어댑터가 죽은 경우 대비).
- Hub는 선택지 모드 요청에 `behavior` 응답이 오거나, 기존 요청에 `choiceId`가 오거나, 선택지에 없는 `choiceId`가 오면 버린다. 해결·만료된 요청에 대한 응답도 버린다.
- 대시보드: 선택지 모드는 선택지마다 버튼을 그리고 설명(`reason`)을 함께 보인다. 누르면 "Sent: <라벨>"로 바꾼 뒤 `permission_resolved`를 받으면 닫는다(소켓이 열려 있지 않으면 보내지 않고 버튼을 그대로 둔다). Enter/Esc 단축키는 선택지 요청에 쓰지 않는다. 기존 Claude 요청(허용/거절, Enter/Esc)은 바꾸지 않는다.
- 대시보드 재연결(최종 리뷰 반영): Hub는 대시보드가 연결되면 `sessions_list` 바로 뒤에 대기 중인 선택지 요청 목록 `{ type: 'permission_pending'; requests: PendingChoiceRequest[] }`을 보낸다. 각 항목은 방송했던 `permission_request`와 같은 필드(`sessionId`, `requestId`, `toolName`, `description`, `inputPreview`, `timestamp`, `choices`)다. 대시보드는 목록에 없는 미해결 선택지 요청을 Expired로 바꾸고, 목록에 있는데 "Sent" 상태인 것은 버튼을 다시 보여 주며(보낸 것이 끊김 중에 사라졌을 수 있다. 다시 눌러도 어댑터가 한 번만 답한다), 목록에 있는데 자기에게 없는 요청은 새 요청처럼 추가한다. Hub 재시작 뒤 어댑터가 다시 보낸 승인이 대시보드 재연결보다 먼저 와도, 페이지를 새로 고쳐도 Codex 승인이 보인다(사용자 결정 2026-10-02, 최종 수정 뒤 실측에서 발견한 R1). Claude 요청은 건드리지 않는다.
- 턴이 끝났는데(`turn/completed`) 그 턴의 승인에 `serverRequest/resolved`가 오지 않았으면(예: 중단) 어댑터가 `permission_resolved{resolved}`로 닫는다.
- 크기 상한: 설명은 500자, 미리보기(명령·파일 diff·MCP 메시지)는 50,000자로 자른다(넘으면 끝에 "…(truncated)"). 텔레그램 메시지 4096자 제한과 WebSocket 16 MB 제한 때문이다.
- 승인 요청의 표시 내용을 만들다 예외가 나면(형식이 다른 요청) 버리지 않고 "Codex is waiting" 경고로 대신한다.
- 텔레그램: 선택지 버튼의 `callback_data`는 `pc:<짧은 토큰>`이고 토큰 → `{sessionId, requestId, choiceId}`는 메모리에 둔다(64바이트 제한). 누르면 그 요청의 토큰을 모두 지우고 메시지를 "Sent: <라벨>"로 고쳐 버튼을 없앤다. `permission_resolved`를 받으면 메시지를 "Resolved"/"Expired"로 고친다(전송 완료 전에 와도 전송 뒤 고친다). 모르는 토큰(재시작 등)은 "Expired"로 답한다.
- 승인으로 바꾸지 않는 사용자 입력 요청(`item/tool/requestUserInput`, `item/permissions/requestApproval`, 도구 승인이 아닌 MCP 입력 요청)은 "Codex is waiting" `notify`(warning, "… Handle it in Codex.")만 보낸다. 그 밖의 서버 요청은 로그만 남긴다.

### 9. 실행 중 추가 지시와 이미지 (단계 C)

**보내는 순서 (지시·이미지 공통)** — §6의 "busy" 거절을 대신한다.

1. 대화별로 한 번에 하나씩 처리한다(직렬화). 앞 메시지의 `turn/start`·`turn/steer`가 끝난 뒤 다음 메시지를 처리하므로, 연달아 보낸 두 번째 메시지는 첫 메시지가 시작한 턴에 steer된다.
2. 대화가 승인·입력 대기(`activeFlags`에 `waitingOnApproval` 또는 `waitingOnUserInput`)면 보내지 않고 `notify`(warning, "Codex is waiting for an approval or input. Answer it first, then send the message again."). steer는 접수되지만 승인이 해결될 때까지 읽히지 않고 승인에 답하지도 않아, 메시지로 승인한 줄 오해하기 쉽다.
3. 그 밖에는 구독을 요청한 뒤 `thread/turns/list({threadId, limit:1, sortDirection:'desc'})`로 진행 중 턴을 확인한다.
   - 첫 항목이 `inProgress`면 `turn/steer({threadId, expectedTurnId: 그 ID, input})`. 접수되면 `notify`(info, "Queued: Codex will read it after its current step.").
   - 아니면(목록이 비어 있거나 조회가 실패해도) 지금처럼 `turn/start`. 첫 턴 전의 새 대화는 목록 조회가 실패하고, 조회 직후 턴이 시작됐더라도 `turn/start`는 그 턴에 steer되므로 안전하다.
   - 로컬 상태 대신 목록을 보는 이유: 자기 `turn/start` 직후에는 `active` 상태 알림이 아직 안 왔을 수 있다.
4. steer·start가 실패하면 지금처럼 `notify`(warning, "Codex rejected the message: …")를 보낸다. 확인 직후 턴이 끝난 경우도 같다. 자동 재전송은 하지 않는다(§6).

**이미지**

- `image_to_session`에 `source?`를 더한다. Hub가 대시보드 업로드는 `dashboard`, 텔레그램 사진은 `telegram`으로 채운다. Claude 채널은 무시한다.
- 어댑터는 `imagePath` 파일을 읽어 `data:<mimeType>;base64,…`로 만들고, 입력을 `[{type:'text', text: 출처 접두어 + 캡션}, {type:'image', url}]`로 보낸다. 캡션이 없으면 `(image)`를 쓴다. 보내는 순서는 위와 같다(유휴면 start, 실행 중이면 steer).
- `localImage`는 쓰지 않는다. Codex가 파일을 나중에 읽는데 Hub는 업로드 파일을 5분 뒤 지우므로(`handleImageUpload`, 텔레그램 `deliverPhotoToSessionByFileId`), 긴 턴에 steer한 이미지는 읽기 전에 사라질 수 있다.
- MIME이 `image/png`·`image/jpeg`·`image/gif`·`image/webp`가 아니거나 파일을 읽지 못하면(어댑터가 다른 PC에서 도는 경우 등) 보내지 않고 `notify`(warning, "The image could not be read here, so it was not delivered. Codex may be running on another PC.").
- 대시보드: 로컬 Codex 세션에서도 첨부 버튼을 켠다. 원격 세션은 지금처럼 꺼 둔다(Hub가 원격 세션 업로드를 거절한다).
- 크기: Hub 업로드 상한은 10MB(base64로 약 13.4MB)다. 데몬·모델 쪽 상한은 미검증이며, 넘으면 `turn/start` 실패 경고나 턴 실패 알림으로 드러난다.

### 10. 오류와 재연결

| 상황 | 처리 |
|---|---|
| Codex 미설치·실행 실패 | 어댑터만 오류 로그 후 종료. Hub는 그대로이고 백오프로 재시도 |
| 데몬 미실행 | `proxy`의 동작 확인 필요(미검증). 연결 실패면 백오프 재시도 |
| proxy 종료·데몬 단절 | 모든 Codex 세션의 Hub 연결을 닫고, 대기 승인은 `expired`, 백오프 후 처음부터 다시 발견 |
| Hub 단절 | 대화별 연결이 기존 규칙대로 재연결하고 `register`를 다시 보낸다 |
| 로그아웃·인증 오류 | 미검증 — 데몬이 로그아웃을 어떤 신호로 알리는지 확인한 뒤 처리한다(단계 A 범위 밖). 그때까지는 `turn/start` 실패 경고로 드러난다 |
| 알 수 없는 서버 요청·메서드 | 응답하지 않고 로그만 남긴다 |

로그에 토큰, 승인 입력 원문, 대화 전문을 남기지 않는다.

### 11. 테스트

- **가짜 proxy**: stdin/stdout에서 WebSocket 서버 역할을 하는 Node 스크립트. transport가 받는 spawn 함수를 테스트에서 바꿔 끼워(`config.codex.command`는 실제 실행 파일 경로용) proxy 이후의 실제 transport 경로를 그대로 지난다. 실제 Codex·데몬에는 접근하지 않는다.
- 순수 함수: 상태 변환, 제목 결정, 출처 접두어, 선택지 생성(`availableDecisions` 있음/없음, 객체 선택지).
- 어댑터 + 가짜 proxy + 격리 Hub 통합: 대화 발견 → 세션 등록, 이름 변경, notLoaded → 해제, `reply` 전달, idle/working일 때 지시 처리, (단계 B) 승인 왕복·resolved·expired.
- 모든 Hub 테스트는 기존처럼 `test/isolate-home.ts`로 HOME·USERPROFILE을 격리하고 텔레그램·웹훅·데스크톱 알림을 막는다(실제 봇 오염 사고 이력).
- 수동 검증: 사전 확인과 같은 방식으로 실험용 터미널 대화에서 표시·응답·지시·승인을 확인한다.

### 12. 구현 단계

| 단계 | 범위 | 끝나면 되는 것 |
|---|---|---|
| A | 1–7 | 대시보드에 Codex 대화가 뜨고, 응답·완료가 대시보드·텔레그램으로 오고, 쉬고 있는 대화에 지시할 수 있다(목표 ①②) |
| B | 8 | 대시보드·텔레그램에서 Codex 승인 처리, 해결 동기화 |
| C | 9 | 실행 중 추가 지시, 이미지 |

단계마다 따로 계획을 세우고 구현한다.

## 위험과 미검증

- App Server 프로토콜은 실험적이다. `availableDecisions`처럼 생성 스키마에 없는 필드는 없을 때의 기본값을 둔다.
- Codex 앱·VS Code 확장에서 연 대화는 확인하지 않았다(터미널만). 같은 데몬을 쓰면 같은 방식으로 보일 것으로 추정한다.
- 이미 해결된 승인에 뒤늦게 답하면 무시되는 것은 확인했다(1.5초 간격). 거의 같은 순간에 두 곳에서 답할 때와 데몬이 꺼져 있을 때 `proxy`의 동작은 미검증이다.
- 터미널에서 시킨 모든 턴의 결과가 텔레그램으로 간다. 너무 잦으면 운영해 보고 필터를 따로 정한다.
- Codex 세션 원격 제어 권한은 Hub 토큰에 묶인다(Claude 세션과 같음). 기능은 기본 꺼짐이다.
- (단계 C) 큰 이미지(수 MB)의 데몬·모델 상한은 미검증이다.
