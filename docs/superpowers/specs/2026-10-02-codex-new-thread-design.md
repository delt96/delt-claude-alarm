# 대시보드 "+"로 새 Codex 대화 만들기

날짜: 2026-10-02 · 상태: 설계 승인(섹션별, 2026-10-02) · Codex 읽기 전용 검토 반영(REVISE, important 4건: `thread/start` RPC 시간 제한, 닫기 경쟁, 구독 해제 실패, discover 중 고정 정리) · 사용자 스펙 검토 대기

## 배경

사용자 요청: "session + 눌렀을때 코덱스를 추가하는거 만들면 좋겠어 예전에 클로드도 하고싶었는데 안된대서 안했는데 코덱스는 가능하니까"

지금 대시보드의 "+"(`src/dashboard/index.html` `#addSessionBtn`)는 Claude를 연결하는 터미널 명령 두 줄을 복사하게 해 줄 뿐이다. Codex는 공유 데몬(app-server)에 대화를 만들 수 있으므로 대시보드에서 바로 새 대화를 시작할 수 있다.

현재 구조에서 막히는 점:

- 어댑터는 Codex 대화마다 HubClient를 하나씩 만들어 Hub에 붙는다(`src/codex/adapter.ts` `upsert`). 대화가 0개면 Hub가 어댑터에 닿을 길이 없다. Hub가 띄운 어댑터만 stdin/stdout 파이프가 있고(`src/hub/codex-supervisor.ts`), `codex start`로 다른 PC에서 띄운 어댑터에는 없다.
- 데몬은 마지막 구독자가 떠나거나 `thread/unsubscribe`한 지 정확히 60초 뒤에 대화를 내린다(실측, 어댑터 설계 Task 15). 어댑터는 Codex 창이 대화를 붙잡게 하려고 작업 중일 때만 구독한다(idle 약 1초 뒤 해제). 대시보드에서 만든 대화는 붙잡는 창이 없어서 이대로면 매 턴 끝나고 약 1분 뒤 사라진다.
- 첫 턴 전 대화는 `thread/loaded/list`와 `thread/started`에는 나오지만 `thread/list`에는 없고 `thread/resume`이 실패할 수 있다(어댑터 설계 0단계 로그).

프로토콜(codex-cli 0.159.3 `codex app-server generate-ts`):

- `thread/start`의 파라미터는 모두 선택: `cwd`, `sandbox`(`SandboxMode`), `approvalPolicy`, `ephemeral` 등. 응답 `{ thread, cwd, sandbox, approvalPolicy, … }`
- `thread/list { cursor?, limit?, sortKey?: 'created_at' | 'updated_at' | 'recency_at' | 'section_position', sortDirection? }` → `{ data: Thread[], nextCursor }`. 기본은 최신순, interactive 출처만
- `thread/unsubscribe` 응답 상태: `notLoaded` · `notSubscribed` · `unsubscribed`
- 미리보기(preview) 변경을 알리는 알림은 없다(`thread/name/updated`만 있음)

## 목표

1. 대시보드 "+" 팝업에서 PC와 폴더를 골라 새 Codex 대화를 만든다. 만들면 그 세션이 선택되고 평소 입력창으로 첫 지시를 보낸다.
2. Hub가 띄운 어댑터와 `codex start`로 다른 PC에서 띄운 어댑터 모두에 만들 수 있다.
3. 대시보드에서 만든 대화는 대시보드에서 닫을 때까지 세션 목록에 남는다.

## 결정 (사용자, 2026-10-02)

- 쓰는 곳: 같은 PC 브라우저와 폰·다른 PC 원격 둘 다
- 수명: 닫을 때까지 유지. 어댑터 메모리에만 기억 — Hub가 띄운 어댑터는 Hub 재시작 때 같이 재시작되므로 그 대화는 약 1분 뒤 목록에서 사라진다(대화 자체는 Codex 기록에 남음)
- 작업 중에 닫기: 작업을 중단하지 않는다. 턴이 끝난 뒤 사라진다
- 폴더 제안 목록: 그 PC의 Codex 기록(`thread/list`)
- 권한: 항상 전체 권한 — `sandbox: 'danger-full-access'`, `approvalPolicy: 'never'`
- 첫 지시: 만든 뒤 평소 입력창에서(양식에 첫 메시지 칸 없음)
- 통로: 어댑터 전용 WebSocket `/ws/codex` + 대시보드 HTTP 요청(접근안 A). 숨은 어댑터 세션(B), Hub가 데몬에 직접 연결(C)은 기각
- 표시: Codex를 쓸 수 있을 때만 팝업에 Codex 부분을 보인다. 데몬에 연결된 어댑터가 하나도 없으면 팝업은 지금처럼 Claude 명령만 보인다
- 데몬이 없을 때: 어댑터가 데몬을 띄우지 않는다. Codex 앱·TUI가 띄운 데몬만 쓴다

## 비목표

- 텔레그램에서 대화 만들기
- 첫 메시지·이름·권한을 양식에서 고르기
- Hub·PC 재시작 뒤 대시보드에서 만든 대화 복원, 지난 Codex 대화를 대시보드에서 다시 열기
- Codex 데몬 자동 시작
- Codex 창에서 연 대화를 대시보드에서 닫기
- 대화 삭제·보관(닫기는 구독 해제일 뿐이다)

## 설계

### 1. 어댑터 전용 연결 `/ws/codex`

새 상수 `WS_PATH_CODEX = '/ws/codex'`(`src/shared/constants.ts`). 인증은 다른 WS 경로와 같다(같은 출처 검사, 토큰 쿼리·헤더·쿠키).

메시지(새 타입 `CodexLinkMessage`, `ChannelMessage`와 별개 — 경로가 다르다):

| 방향 | 메시지 |
|---|---|
| 어댑터 → Hub | `{ type: 'adapter_hello', adapter: { id, host, ready } }` |
| Hub → 어댑터 | `{ type: 'adapter_call', requestId, call: { kind: 'folders' } \| { kind: 'create', cwd } }` |
| 어댑터 → Hub | `{ type: 'adapter_result', requestId, ok: true, data } \| { type: 'adapter_result', requestId, ok: false, error }` |

- `id`: 어댑터 프로세스마다 새로 만드는 UUID. `host`: `os.hostname()`. `ready`: Codex 데몬과 `initialize`를 마치고 기존 대화 탐색(`discover`)까지 끝났는지
- `adapter_hello`는 연결이 열릴 때마다, 그리고 `ready`가 바뀔 때마다 보낸다
- `data`: `folders` → `{ folders: string[] }`, `create` → `{ sessionId }`
- `error`: 사람이 읽을 영어 문장

어댑터 쪽 연결은 HubClient와 같은 방식(끊기면 5초 뒤 재접속, 열린 동안만 전송)의 작은 클래스로 둔다. 연결이 끊긴 동안 받은 `adapter_call`은 없다(Hub가 연결이 없는 어댑터에 보내지 않음). 결과를 보낼 때 연결이 끊겨 있으면 버린다 — Hub 쪽 대기 요청은 연결 끊김으로 이미 실패 처리된다.

호환성: 새 어댑터를 옛 Hub에 붙이면 옛 Hub가 모르는 경로를 끊고 어댑터는 재접속만 반복한다. 대화 중계는 지금처럼 된다. 옛 어댑터를 새 Hub에 붙이면 어댑터 목록이 비어 팝업에 Codex 부분이 안 보인다.

### 2. Hub (`src/hub/server.ts`)

상태:

- 어댑터 목록 `Map<id, { ws, info: { id, host, ready, isLocal } }>`. `isLocal`은 기존 `isLocalRequest`(Hub와 같은 PC)
- 대기 요청 `Map<requestId, { adapterId, resolve, timer }>`

동작:

- `/ws/codex` 연결의 `adapter_hello`로 등록·갱신. 한 연결은 하나의 어댑터 ID만 가진다(다른 ID로 다시 hello하면 무시). 같은 ID가 새 연결로 오면 새 연결이 이긴다(옛 연결 종료)
- 연결이 끊기면 목록에서 빼고, 그 어댑터의 대기 요청을 모두 502로 끝낸다
- 채널 소켓과 같은 30초 하트비트(ping/pong)를 `/ws/codex`에도 건다 — 다른 PC가 절전에 들어가면 죽은 소켓이 목록에 남아 요청이 60초 뒤 504가 되므로, 응답 없는 소켓을 끊어 약 1분 안에 목록에서 뺀다(계획 단계에서 추가)
- 목록이 바뀔 때마다 대시보드에 `{ type: 'codex_adapters', adapters: [{ id, host, ready, isLocal }] }`를 방송한다. 대시보드가 접속하면 `sessions_list`·`permission_pending` 다음에 한 번 보낸다
- 대기 요청의 시간 제한 기본 60초 — `thread/start`가 MCP 서버 기동(이 PC 설정 `startup_timeout_sec = 30`)을 기다릴 수 있다. 테스트에서 줄일 수 있게 주입 가능하게 한다. 실측 뒤 조정
- 끝난(시간 초과·연결 끊김) `requestId`로 늦게 온 결과는 무시한다

HTTP API(기존 인증·같은 출처 검사·POST JSON Content-Type 검사를 그대로 받는다):

| 요청 | 성공 | 실패 |
|---|---|---|
| `GET /api/codex/folders?adapterId=<id>` | 200 `{ folders }` | 아래 표 |
| `POST /api/codex/threads` 본문 `{ adapterId, cwd }` | 200 `{ sessionId }` | 아래 표 |
| `POST /api/codex/threads/close` 본문 `{ sessionId }` | 200 `{ ok: true }` | 404 |

| 실패 상황 | 응답 |
|---|---|
| `adapterId`·`cwd`·`sessionId`가 비어 있지 않은 문자열이 아님 | 400 |
| 그 ID의 어댑터가 연결돼 있지 않음 | 404 `Codex adapter is not connected` |
| 기다리는 중 어댑터 연결이 끊김 | 502 `Codex adapter disconnected` |
| 시간 초과 | 504 `Codex did not respond in time. The conversation may still appear.` |
| 어댑터가 `ok: false`로 답함 | 422, 어댑터의 `error` 문장 |
| 닫기 대상 세션이 없음, Codex 세션이 아님, `closable`이 아님 | 404 `No closable Codex conversation` |

실패 응답 본문은 기존 형식 `{ error }`.

닫기는 어댑터 전용 연결을 쓰지 않는다. Hub가 그 세션의 기존 채널 소켓으로 `{ type: 'codex_close', sessionId }`(새 `ChannelMessage`)를 보내고 바로 200을 돌려준다. 결과는 세션이 사라지거나 `closable`이 꺼지는 것으로 대시보드에 드러난다.

`SessionInfo`에 `closable?: boolean`을 더한다. 어댑터가 등록 정보로 채우고 Hub·SessionManager는 그대로 저장·전달한다.

### 3. 어댑터 (`src/codex/adapter.ts`)

새 상태: 고정 목록 `pins: Set<threadId>`(메모리만), 어댑터 ID(UUID), 어댑터 전용 연결.

**연결 수명**

- `start()`에서 어댑터 전용 연결을 열고 `stop()`에서 닫는다
- 데몬과 `initialize`를 마치고 `discover()`까지 끝나면 `ready = true`, 데몬 연결 실패·끊김이면 `ready = false`. 바뀔 때마다 `adapter_hello`. discover 중에 만든 대화의 고정이 정리 단계에서 지워지지 않게 하려고 discover가 끝난 뒤에 켠다

**만들기 (`create`)**

1. `ready`가 아니면 실패 `Codex is not connected on <host>.`
2. `cwd` 정리: 앞뒤 공백을 지우고, 전체가 큰따옴표 한 쌍으로 감싸져 있으면 벗긴다(탐색기 "경로로 복사"가 따옴표를 붙인다)
3. 절대 경로이고 그 PC에 있는 폴더인지 `fs.stat`으로 확인한다. 아니면 실패 `Folder not found on <host>: <cwd>`
4. `thread/start { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' }`. 거부되면 실패 `Codex could not start the conversation: <message>`. 이 요청에는 RPC 시간 제한을 두지 않는다(응답이나 데몬 연결 종료로만 끝남) — `RpcClient`의 기본 30초 제한으로 끝내면 늦게 만들어진 대화의 응답이 버려져 고정되지 않은 채 실제로는 구독된 대화가 남는다. 시간 제한은 Hub의 60초뿐이고, 늦게 성공한 대화는 고정되어 목록에 나타난다(Hub 504 문구와 일치). `RpcClient.request`에 요청별 시간 제한 옵션(제한 없음 포함)을 더한다
5. `pins`에 넣고 응답의 `thread`로 `upsert`한다. `thread/started` 방송이 먼저 와서 이미 추적 중이면 등록만 다시 해서 `closable: true`가 된다
6. 그 대화의 `subscribed = true`로 둔다 — `thread/start`를 부른 연결은 이미 구독자다(`codex run`은 resume 없이 그 대화 이벤트를 받는다). **실측 확인 항목 1**. `upsert`가 예약한 구독 동기화가 돌기 전에 표시해야 한다. 늦으면 첫 턴 전이라 실패할 `thread/resume`이 나간다
7. 성공 `{ sessionId: 'codex:<threadId>' }`

`create`·`folders` 처리는 모든 예외를 잡아 `ok: false`로 답한다.

**붙잡기**

- 구독 여부를 정하는 곳은 지금처럼 `want()` 하나다. 원하는 구독 상태를 `요청값 || pins.has(threadId)`로 바꾼다. 그래서 고정 대화는 턴이 끝나도(`releaseLater`, `onTurnCompleted`) 구독을 놓지 않는다
- 등록 정보(`registration()`)에 `closable: pins.has(threadId)`를 넣는다
- Codex 창에서 연 대화는 `pins`에 없으므로 지금과 같다

**닫기 (`codex_close`)**

- 고정 대화가 아니면 무시한다
- `pins`에서 빼고 등록을 다시 한다(`closable: false`). 그다음:
  - 작업 중이면(status가 active이거나 `pendingTurn`): 더 하지 않는다. 진행 중인 작업은 중단하지 않는다. 턴이 끝나면 지금의 창 대화처럼 구독을 놓고 약 1분 뒤 사라진다
  - 작업 중이 아니면: 구독 해제(`want(false)` → `thread/unsubscribe`)를 기다린 뒤 **다시 확인한다**. 추적에서 먼저 빼면 구독 해제가 건너뛰어지므로 순서를 지킨다
    - 그 사이 작업이 시작됐으면(같은 추적 객체인데 active, `pendingTurn`, 또는 다시 구독을 원함 — 기다리는 동안 지시 전달이나 active 방송이 `want(true)`를 걸 수 있다): 작업 중 닫기와 같이 둔다
    - 구독이 풀렸으면(`subscribed === false`): 추적에서 뺀다(`drop`) → 세션이 대시보드에서 바로 사라진다. 다른 구독자가 없으면 데몬이 60초 뒤 대화를 내린다
    - 구독 해제가 실패했으면(`subscribed`가 그대로 — `syncSubscription`은 오류를 로그만 남기고 삼킨다): 고정을 되돌리고(`closable: true`) 그 세션에 경고 알림 `Not closed` / `Codex did not release the conversation. Try closing it again.`을 보낸다. 구독된 대화를 추적 없이 버리지 않는다
- 대화를 삭제·보관하지 않는다 — Codex 기록에 남아 Codex 앱에서 이어 갈 수 있다

**고정이 풀리는 경우**

- 닫기, `thread/archived` · `thread/deleted` · `thread/closed`
- 데몬 연결이 끊기면(`onDaemonLost`, 연결 실패) 추적은 모두 빠지지만 `pins`는 유지한다. 60초 안에 다시 붙으면 `discover()`가 대화를 다시 찾고, 고정 대화는 `want()`에서 다시 구독된다
- `discover()`가 끝난 뒤 loaded 목록에 없는 고정 ID는 `pins`에서 지운다. 단 discover를 시작할 때 이미 있던 고정 ID만 대상으로 하고, discover 도중 데몬 연결이 바뀌었으면(시작 때의 `rpc`와 지금의 `rpc`가 다름) 정리하지 않는다 — 옛 연결의 목록으로 새 연결의 고정을 지우지 않기 위해서다
- 첫 턴 전 고정 대화는 다시 붙은 뒤 resume이 실패할 수 있어 60초 뒤 내려간다(`thread/closed` → 고정 해제). 받아들인다

**폴더 목록 (`folders`)**

- `ready`가 아니면 실패 `Codex is not connected on <host>.`
- `thread/list { limit: 50, sortKey: 'updated_at' }`의 `cwd`를 나온 순서대로 중복 없이 최대 10개

**제목 다시 읽기**

- `onTurnCompleted`에서 그 대화의 `name`도 `preview`도 비어 있으면 `thread/read`(기존 `refresh`)로 다시 읽어 등록을 갱신한다. 미리보기 변경 알림이 없어서다
- 고정 대화가 아니어도 같다(첫 입력 전에 등록된 Codex 창 대화). 이 대화들이 지금 폴더 이름으로 남아 있는지는 **실측 확인 항목 5**

### 4. 대시보드 (`src/dashboard/index.html`)

화면 디자인(색·간격·배치·폰 폭 대응)은 구현 단계에서 Codex가 맡는다. 동작은 다음과 같다. 화면 문구는 영어.

**상태:** `codex_adapters`로 받은 어댑터 목록. "쓸 수 있는 어댑터" = `ready`인 것.

**"+" 팝업:**

- 위: 지금의 Claude 명령 두 줄 그대로
- 아래 Codex 부분: 쓸 수 있는 어댑터가 하나 이상일 때만 보인다. 팝업이 열린 동안 목록이 바뀌면 바로 반영한다
  - PC 선택: 쓸 수 있는 어댑터가 둘 이상일 때만 보인다. 이름은 `host`, 같은 `host`가 둘 이상이면 ID 앞 4자를 덧붙인다. Hub와 같은 PC(`isLocal`)를 맨 앞에 둔다
  - 폴더 입력칸 + 제안 목록(datalist): 팝업을 열 때와 PC를 바꿀 때 `GET /api/codex/folders`로 채운다. 실패하면 제안 없이 둔다(직접 입력은 됨)
  - 경고 한 줄: `Runs with full access: no approval prompts.`
  - `Create` 버튼(폴더 입력칸 Enter도 같음): 폴더가 비어 있으면 아무것도 하지 않는다. 요청 중에는 `Creating…`으로 바뀌고 비활성
  - 성공: 팝업을 닫고 새 세션을 선택하고 메시지 입력창에 포커스. 세션 등록이 응답보다 늦으면 그 세션이 등록되는 순간 선택한다(다른 세션을 먼저 고르면 취소)
  - 실패: 양식 아래에 응답의 `error`를 보이고 입력값은 둔다

**닫기 버튼:** `closable` 세션에만 보인다(세션 카드·메시지 헤더 중 위치는 디자인 단계에서). 한 번 누르면 `Close?`로 바뀌고 3초 안에 다시 누르면 `POST /api/codex/threads/close`. 첫 탭 뒤 0.4초 안의 두 번째 탭은 무시한다 — 폰의 빠른 두 번 탭이 확정까지 가 버리지 않게(계획 단계에서 추가). 브라우저 `confirm` 대화상자는 쓰지 않는다. 툴팁 `Close — stays in Codex history`. 요청이 실패하면 버튼을 원래대로 돌린다.

### 5. README

"Codex Sessions"에 추가:

- "+"로 새 Codex 대화 만들기(쓸 수 있는 조건: 데몬이 떠 있는 PC의 어댑터, 첫 지시는 입력창에서)
- **전체 권한으로 실행**된다 — 승인 없이 그 PC에서 명령을 실행한다
- 닫을 때까지 유지, 닫아도 Codex 기록에 남음, Hub가 띄운 어댑터는 Hub 재시작 때 이 대화들이 약 1분 뒤 사라짐

"Remote Access"에: 대시보드에 들어올 수 있으면 어댑터가 있는 모든 PC에서 승인 없이 명령을 실행할 수 있으니 토큰을 공유하지 말 것.

## 보안

항상 전체 권한이므로 대시보드에 인증된 사람은 어댑터가 있는 모든 PC에서 승인 없이 명령을 실행할 수 있다. Hub 토큰이 유일한 관문이다. 지금도 대시보드로 기존 세션에 지시·승인을 할 수 있어 관문은 같지만, 승인 단계가 없어진다. 새 HTTP 경로와 `/ws/codex`는 기존 인증·같은 출처 검사를 그대로 받는다. `cwd`는 절대 경로이면서 있는 폴더인지만 확인하고 특정 폴더로 제한하지 않는다.

## 테스트

node:test(기존 방식). 새 테스트 파일은 포트 7980–7988을 쓴다(기존 테스트 7990–7998 고정, 다른 세션이 같은 저장소 작업 중).

Hub:

- `/ws/codex` hello → 대시보드가 `codex_adapters`를 받음. 끊기면 목록에서 빠짐. 대시보드 접속 시 현재 목록을 받음
- `POST /api/codex/threads` → 그 어댑터가 `adapter_call create`를 받고, 답한 `sessionId`가 응답으로 옴
- 시간 초과 504(짧게 주입), 대기 중 끊김 502, 모르는 어댑터 404, 어댑터 오류 422, 잘못된 본문 400, 늦게 온 결과 무시
- `GET /api/codex/folders` 전달·응답
- 닫기: `closable` Codex 세션의 채널 소켓이 `codex_close`를 받음. 없는 세션·Claude 세션·`closable` 아님 → 404
- 인증 없이 새 HTTP 경로 401, `/ws/codex` 업그레이드 401

어댑터(FakeDaemon 확장):

- `create`: `thread/start` 파라미터(`cwd`, `danger-full-access`, `never`), 등록에 `closable: true`, 턴이 끝나도 `thread/unsubscribe` 없음
- `create`: `thread/start` 응답이 30초를 넘겨 와도 고정된다(RPC 시간 제한 없음). `ready` 전(discover 중)에는 실패
- `RpcClient.request` 요청별 시간 제한(제한 없음 포함)
- `cwd` 정리(따옴표·공백), 없는 폴더·상대 경로 실패, 데몬 미연결 실패
- 닫기: 작업 중이 아니면 `thread/unsubscribe` 뒤 세션 사라짐. 작업 중이면 `closable: false`로 남고 턴이 끝나면 구독 해제. 고정 아닌 대화의 `codex_close`는 무시
- 닫기 경쟁: `thread/unsubscribe` 응답을 붙잡아 둔 사이 지시 전달 또는 active 방송 → 추적이 남고 작업 중 닫기처럼 동작(응답 중계됨)
- 닫기 실패: `thread/unsubscribe` 오류 → 세션이 남고 `closable: true`로 돌아오며 `Not closed` 알림
- `folders`: 중복 제거·순서·최대 10개, 데몬 미연결 실패
- 이름·미리보기 없는 대화: 턴이 끝나면 `thread/read` 후 새 제목으로 재등록
- 데몬 재연결 뒤 고정 대화 다시 구독, loaded 목록에 없는 고정 ID 정리. discover 중 데몬 연결이 바뀌면 정리하지 않음
- `ready` 변화에 따른 `adapter_hello`

대시보드(기존처럼 `vm`으로 뽑아낼 수 있는 부분): 쓸 수 있는 어댑터 0·1·여러 개(not ready 섞임)에 따른 Codex 부분 표시와 PC 선택, 등록이 늦을 때 나중 선택과 취소, 닫기 두 번 누르기.

## 실측 (실제 Codex 데몬)

조건: 격리한 HOME·USERPROFILE, 포트 7980–7988, 텔레그램 없음, 시작 전에 claude-alarm `notify`로 사용자에게 알림, 작업 폴더는 임시 폴더(예 `C:\tmp\codex-test`), 지시는 무해한 것만(전체 권한이므로).

1. `thread/start`를 부른 연결이 resume 없이 구독자인가 — 만들고 아무것도 보내지 않은 채 90초 넘게 loaded로 남는가. **아니면 구현을 멈추고 설계를 다시 본다**(첫 턴 전에는 resume도 실패하므로 붙잡을 방법이 달라진다). 이 항목은 어댑터 구현 전에 먼저 실측한다
2. `thread/start` 응답 시간(60초 제한이 맞는가)
3. 만들기 → 입력창 지시 → 응답이 대시보드에 옴, 승인 요청 없음
4. 턴이 끝나고 90초 넘게 세션이 남음
5. 제목이 폴더 이름에서 첫 메시지 내용으로 바뀜. 지금 코드에서 첫 입력 전에 등록된 Codex 창 대화가 폴더 이름으로 남는지도 확인
6. 닫기 → 세션 즉시 사라짐, 60초 뒤 `thread/loaded/list`에서 빠짐
7. Hub 재시작 → 약 1분 뒤 사라짐
8. `~/.codex/config.toml`에 그 폴더의 trusted 항목이 추가되는지(기록만 — `codex run`에서 관찰됨)
9. 대시보드를 브라우저로 열어 폰 폭·PC 폭에서 팝업과 닫기 버튼 확인

## 구현 배분

codex-sdd로 실행한다. 대시보드 화면 디자인은 Codex가 맡는다. 나머지는 계획 단계에서 작업마다 배정 정책을 따른다.
