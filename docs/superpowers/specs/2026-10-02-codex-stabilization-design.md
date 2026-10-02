# Codex 어댑터·텔레그램·대시보드 안정화

날짜: 2026-10-02 · 상태: 사용자 승인(2026-10-02)

## 배경

단계 A–C와 `codex start` 기동 확인 리뷰에서 미뤄 둔 문제들을 묶어 고친다. 범위는 사용자가 정했다: 어댑터 쪽 묶음 + 텔레그램·대시보드 항목. 단계 C(steer·이미지)로 이미 사라진 M1(`systemError` 대화를 busy로 거절)·M10(Codex 세션 이미지 업로드)은 제외한다.

확인한 사실 (main 103c365 = npm 1.2.0):

- 어댑터 단일 실행은 `codex.pid` 확인 뒤 쓰기다(`src/codex/main.ts:23-28`). 확인과 쓰기 사이에 틈이 있어 동시 `codex start`가 어댑터 둘을 남길 수 있다. 강제 종료·재부팅으로 남은 PID를 다른 프로세스가 쓰면 어댑터는 이미 실행 중이라 보고 종료 코드 0으로 끝나고, 감독자는 0이면 다시 띄우지 않는다(`src/hub/codex-supervisor.ts:64-65`) — Codex 연동이 조용히 꺼진다
- `codex stop`은 파일의 PID에 SIGTERM을 보낸다(`src/cli.ts:401-414`). Windows에서는 즉시 강제 종료이므로 남은 파일이 무관한 프로그램을 가리키면 그 프로그램을 끈다. `codex start`(`src/codex/start-check.ts:152-186`)·`codex status`도 PID 파일로 판단한다
- Windows Node 22.17.0에서 같은 이름의 named pipe에 두 번째 `net.Server.listen`은 `EADDRINUSE`로 실패한다(Codex 실측, 2026-10-02). 맥·리눅스 소켓 파일은 프로세스가 죽어도 남는다
- `connectProxy`는 proxy가 살아 있는 한 WebSocket `open`을 끝없이 기다린다(`src/codex/transport.ts:91-109`). `initialize` 요청 자체는 30초 제한이 있다(`src/codex/rpc.ts:23`)
- Codex 창(터미널)에서 시작한 턴은 `active` 방송으로 구독을 시도하는데(`src/codex/adapter.ts:440-443`), 구독이 실패하면 debug 로그만 남는다(`adapter.ts:336-338`). 응답은 사라지고 경고는 없다. 대시보드에서 보낸 턴은 같은 경우 "Reply not relayed"로 알린다(`adapter.ts:446`, `534-537`)
- `resolveCommand`는 확장자가 있는 명시 경로를 셸 없이 실행한다(`transport.ts:21`). `.cmd`·`.bat`이면 Node가 `EINVAL`로 거절하고 어댑터는 끝없이 재시도한다
- 감독자는 자식에게 Hub의 환경 변수를 그대로 물려준다(`codex-supervisor.ts:52-56`). 셸에 `CLAUDE_ALARM_HUB_*`가 있으면 Hub가 띄운 어댑터가 그 Hub로 붙는다(`src/codex/hub-target.ts:11-19`). Hub 자신은 `config.json`의 host·port를 쓴다(`src/hub/server.ts:85-89`, `src/cli.ts:146`)
- 승인 요청 처리(`adapter.ts:568-`) 중 예외가 나면 `RpcClient.guarded`(`src/codex/rpc.ts:63-70`)가 경고 로그만 남긴다. 사용자에게 알림이 없다. 데몬은 같은 요청을 Codex 창에도 보내므로, 어댑터가 답하지 않는 것 자체는 사용자가 Codex에서 답할 수 있게 하는 정상 경로다(표시할 수 없는 요청은 이미 이렇게 처리: `adapter.ts:580-586`)
- 텔레그램 세션 선택은 채팅마다 하나만 기억한다(`src/hub/telegram.ts:72`, `250-265`). 선택 창이 둘 열린 뒤 첫 창의 버튼을 누르면 두 번째 메시지가 간다. 버튼 데이터는 `sess:<번호>:<chatId>`
- 텔레그램에서 모르는 승인 토큰을 누르면 `Expired` 토스트만 뜨고 버튼은 남는다(`telegram.ts:443-448`)
- 텔레그램 알림(`sendNotification`, `telegram.ts:83-84`)은 메시지 길이에 제한이 없다. Telegram `sendMessage`는 엔터티 해석 뒤 4096자를 넘으면 거절하고, 지금은 경고 로그만 남는다(`telegram.ts:115-118`). 승인 요청은 미리보기 3000자·설명 500자로 이미 묶여 있다. 세션 응답 알림은 3000자로 자른다(`server.ts:503`)
- 텔레그램 사진은 크기를 확인하지 않고, 받기에 실패하면 로그만 남는다(`telegram.ts:280-314`). 사진 객체에는 `file_size`가 있을 수 있다(`telegram.ts:19-25`)
- 대시보드 이미지 업로드는 원격 세션·연결 끊긴 세션·지원하지 않는 형식·10MB 초과일 때 아무 표시 없이 버려진다(`server.ts:767-791`). 대시보드는 10MB만 미리 확인한다(`src/dashboard/index.html:1801-1803`)

## 결정 (사용자, 2026-10-02)

- 범위: 어댑터 묶음 + 텔레그램·대시보드
- 잠금 방식: Codex에 물어 정함(`codex run`, 읽기 전용, 스레드 `01a0fd08-b51a-7a52-b927-e4895f68b7aa`). Codex 추천 = named pipe·소켓을 잠금과 제어 채널로(A). PID 파일 + 신원 확인(B)은 신원 확인과 남은 파일 정리에 경쟁이 남고, 고정 포트(C)는 격리 HOME 테스트와 부딪힌다
- Codex 제안 중 바꾼 것: stop 인증은 별도 비밀값 대신 설정 폴더의 기존 Hub 토큰(`config.hub.token`). 맥·리눅스 정리 잠금이 남으면 사람이 복구하는 대신 10초 넘은 것을 버려진 것으로 보고 치운다(정리는 수 밀리초)
- `codex stop`의 의미: 지금 잠금을 쥔 어댑터만 멈춘다. Hub가 띄운 어댑터가 기다리고 있었다면 이어받는다. Codex를 끄려면 지금처럼 `codex disable` 후 Hub 재시작
- 승인 요청 처리 예외: 데몬에 오류로 답하지 않는다(Codex 창에서 답할 기회를 막을 수 있음). 표시할 수 없는 요청과 같은 알림만 띄운다

## 설계

### 1. 잠금과 제어 채널 — `src/codex/instance-lock.ts` (새 파일)

**끝점 이름** `controlEndpoint(configDir, platform = process.platform): string`

- Windows: `\\.\pipe\claude-alarm-codex-<hex16>`. `hex16`은 `fs.realpathSync.native(configDir)`(실패하면 `path.resolve(configDir)`)를 소문자로 바꾼 문자열의 SHA-256 앞 16자. 격리 HOME 테스트는 설정 폴더가 달라서 실제 어댑터와 이름이 겹치지 않는다
- 그 밖: `path.join(configDir, 'codex.sock')`. UTF-8 길이가 103바이트를 넘으면 잠금을 얻지 못한 것으로 처리한다(아래 `unknown`, 오류 `control socket path is too long: <경로>`)

**프로토콜** — 요청 JSON 한 줄, 응답 JSON 한 줄, 그 뒤 서버가 연결을 닫는다. 서버는 2초 안에 줄바꿈이 오지 않거나 4096바이트를 넘으면 연결을 끊는다.

| 요청 | 응답 |
|---|---|
| `{"type":"status"}` | `{"type":"status","protocol":1,"pid":<pid>}` |
| `{"type":"stop","token":"<토큰>"}` 토큰 일치 | `{"type":"stopping","pid":<pid>}` 를 보낸 뒤 종료 절차 |
| 토큰 불일치 | `{"type":"error","error":"unauthorized"}` |
| 그 밖 | `{"type":"error","error":"unknown request"}` |

토큰은 어댑터가 시작할 때 `loadConfig().hub.token`으로 읽은 값이다. 어댑터가 Hub 접속에 `CLAUDE_ALARM_HUB_TOKEN`을 쓰더라도 제어 토큰은 설정 파일 값이다.

**클라이언트** `queryOwner(endpoint, timeoutMs = 1000): Promise<OwnerState>`

```ts
export type OwnerState =
  | { state: 'running'; pid: number }
  | { state: 'absent' }                  // ENOENT, ECONNREFUSED
  | { state: 'unknown'; error: string }; // 시간 초과, 권한 거부, 잘못된 응답, protocol ≠ 1
```

`requestStop(endpoint, token, timeoutMs = 1000): Promise<'stopping' | 'unauthorized' | OwnerState>` — 연결이 안 되면 `queryOwner`와 같은 상태를 돌려준다.

**잠금 얻기** `acquireLock(endpoint, owner: { pid: number; token: string; onStop: () => void }): Promise<Acquired>`

```ts
export type Acquired =
  | { kind: 'owner'; close: () => Promise<void> }
  | { kind: 'held'; pid: number }
  | { kind: 'unknown'; error: string };
```

1. `listen(endpoint)` 성공 → `owner`
2. `EADDRINUSE` → `queryOwner`: `running` → `held`, `unknown` → `unknown`, `absent` →
   - Windows: 주인이 막 끝난 경우라 `listen`을 한 번 더 시도, 또 실패하면 `unknown`
   - 그 밖(남은 소켓 파일): 정리 잠금 `<endpoint>.lock`을 `mkdir`로 만든다. 이미 있으면 수정 시각이 10초보다 오래됐을 때만 지우고 한 번 더 만든다, 아니면 `unknown`(`another Codex adapter is starting`). 잠금 안에서 `queryOwner`를 다시 하고 `absent`일 때만 소켓 파일을 지우고 `listen` → `owner`. 마지막에 정리 잠금을 지운다
3. 그 밖의 `listen` 오류 → `unknown`(오류 문구)

`stop` 요청은 응답 쓰기가 끝난 뒤(소켓 `end` 콜백) `onStop`을 부른다. 끝점은 어댑터 정리가 끝난 뒤 `close()`로 닫는다 — 정리 중에 다른 어댑터가 잠금을 얻지 못하게 한다.

### 2. 어댑터 시작 — `src/codex/main.ts`

`codex.pid`를 읽거나 쓰지 않는다. `loadConfig()` 뒤 `acquireLock`.

- `owner` → 지금처럼 어댑터 시작. 종료 절차(SIGINT·SIGTERM·stdin EOF·`stop` 요청): `adapter.stop()` → 끝점 `close()` → `process.exit(0)`
- Hub가 띄운 경우(`--watch-stdin`)에 `held`·`unknown`이면 끝내지 않고 기다린다. 처음 한 번 로그: `held`는 `Another Codex adapter is running (PID: N); this one takes over when it stops`, `unknown`은 `Codex adapter control endpoint is unavailable (<오류>); retrying`. 2초에서 시작해 두 배씩 30초까지 늘리며 다시 `acquireLock`, `owner`가 되면 어댑터 시작. 기다리는 동안 stdin EOF가 오면 `process.exit(0)`. 잠금을 얻기 전에는 `CodexAdapter`를 만들지 않는다
- 그 밖(`codex start`가 띄운 경우): `held` → IPC `{ type: 'codex-already-running', pid }`(채널이 있을 때), 로그 `Codex adapter already running (PID: N)`, 종료 코드 0. `unknown` → IPC `{ type: 'codex-lock-failed', error }`, 로그 `Codex adapter cannot start: <오류>`, 종료 코드 1
- 감독자의 "종료 코드 0이면 다시 띄우지 않음"은 그대로다. 기다리는 어댑터는 살아 있으므로 감독자가 다시 띄울 일이 없다

### 3. CLI — `codex start` / `stop` / `status`

**`codex start`** (`start-check.ts`): `StartDeps`의 `readPid`·`isRunning`·`removePidFile`을 `queryOwner: () => Promise<OwnerState>`로 바꾼다.

- 띄우기 전 `queryOwner`가 `running`이면 지금과 같은 "이미 실행 중" 출력(`Codex adapter is already running (PID: N)` + Hub 줄)
- 기다리는 보고에 두 가지를 더한다: `codex-already-running` → "이미 실행 중" 출력, 종료 코드 0. `codex-lock-failed` → 표준 오류 `Codex adapter cannot start: <오류>`, 종료 코드 1
- 보고 없이 끝나면 `queryOwner`를 다시 해 `running`이면 "이미 실행 중", 아니면 지금의 `Codex adapter exited during startup (…)`. PID 파일 정리는 없앤다
- 보고 뒤 종료가 보고보다 우선한다는 기존 규칙(`test/codex-start-check.test.ts:264-277`)은 유지

**`codex stop`**:

| 상황 | 출력 | 종료 코드 |
|---|---|---|
| `absent` | `Codex adapter is not running` (+ 아래 옛 PID 안내) | 0 |
| `unknown` | 표준 오류 `Codex adapter control endpoint is unavailable: <오류>` | 1 |
| `unauthorized` | 표준 오류 `Codex adapter refused to stop: the token in <CONFIG_PATH> does not match the one it started with` | 1 |
| `stopping` 후 5초 안에 `absent`(100ms 간격 확인) | `Codex adapter stopped (PID: N)` | 0 |
| 5초 안에 안 사라짐 | 표준 오류 `Stop requested, but the Codex adapter (PID: N) is still running. Check with: claude-alarm codex status` | 1 |

Hub 어댑터가 기다리고 있었다면 멈춘 직후 그것이 이어받는다. `codex stop`은 이를 따로 알리지 않는다.

**`codex status`**: `Codex adapter: running (PID: N)` / `Codex adapter: not running` (+ 옛 PID 안내) / `Codex adapter: unknown (<오류>)`, 다음 줄은 지금처럼 `Start with hub: …`.

**옛 PID 안내** (`absent`일 때만): `codex.pid`가 있고 그 PID가 살아 있으면 `Note: <CODEX_PID_FILE> names a running process (PID: N). claude-alarm 1.2.0 and earlier wrote this file; if that process is an old Codex adapter, restart the hub or end it yourself.` 살아 있지 않으면 파일을 조용히 지운다. 어떤 경우에도 그 프로세스를 끄지 않는다.

### 4. 감독자 환경 변수 — `src/hub/codex-supervisor.ts`

자식 환경 = Hub 환경 복사본에서 `CLAUDE_ALARM_HUB_TOKEN`을 지우고 `CLAUDE_ALARM_HUB_HOST`·`CLAUDE_ALARM_HUB_PORT`를 Hub 자신의 host(`config.hub.host` 그대로, 변환은 `resolveAdapterHub`가 함)·port로 덮어쓴 것. 토큰은 환경에 싣지 않고 어댑터가 같은 `config.json`에서 읽는다. 순수 함수 `adapterEnv(base, hub: { host: string; port: number })`로 만들고 `HubServer.startCodexAdapter`가 넘긴다.

### 5. 데몬 무응답 시간 제한 (M5) — `src/codex/transport.ts`

`connectProxy(command, spawnFn, timeoutMs = 10_000)`: `open`이 `timeoutMs` 안에 오지 않으면 proxy를 끄고 `codex daemon did not answer within 10s`(초는 `timeoutMs`에서 계산)로 거절한다. 어댑터는 지금의 실패 경로를 탄다(로그, 첫 연결 보고 `connected: false`, 2초→60초 재시도).

### 6. 터미널 턴의 응답 유실 경고 (M3) — `src/codex/adapter.ts`

`syncSubscription`의 구독(`thread/resume`)이 실패했을 때 대화가 `active`이면 `t.unrelayed = true`. 그 턴이 끝나 idle이 되면 기존 "Reply not relayed" 알림이 나간다. 나중 구독이 성공하면 지금처럼 `unrelayed = false`.

### 7. `.cmd`·`.bat` 명시 경로 (M6) — `transport.ts`

`resolveCommand`: Windows에서 명시 경로의 확장자가 `.cmd`·`.bat`(대소문자 무관)이면 `{ file: command, shell: true }`. 실행은 지금의 셸 경로(`"<file>" <args>`)를 탄다.

### 8. 승인 요청 처리 예외 — `adapter.ts`

`onServerRequest`에서 대화를 찾은 뒤의 처리를 try/catch로 감싼다. 예외가 나면 경고 로그, 이미 넣은 승인 항목은 지우고, 표시할 수 없는 요청과 같은 알림(`Codex is waiting` / `Codex asked for input that claude-alarm cannot relay. Handle it in Codex.`)을 보낸다. 데몬에는 답하지 않는다.

### 9. 텔레그램 — `src/hub/telegram.ts`

**세션 선택 (M9)**: 선택 창마다 ID를 붙인다.

- `pendingMessages`(채팅당 하나)를 `selections: Map<선택ID, { text?, photoFileId?, caption?, sessionIds }>`로 바꾼다. 선택 ID는 짧은 무작위 문자열(8자), 최대 20개(넘으면 가장 오래된 것부터 버림)
- 버튼 데이터 `sel:<선택ID>:<번호>`(64바이트 안). 누르면 그 선택의 메시지만 보낸다. 보낸 선택은 지운다. 세션이 사라졌으면 지금처럼 `Session not found`, 선택은 남긴다
- `/s_N`은 가장 최근 선택에 적용한다(지금과 같은 의미)
- 업그레이드 전에 보낸 `sess:` 버튼은 아래 만료 처리

**만료 버튼**: 모르는 승인 토큰(`pc:`), 없는 선택(`sel:`), 옛 `sess:` 버튼을 누르면 `Expired` 토스트와 함께 `editMessageReplyMarkup`으로 그 메시지의 버튼을 지운다(본문은 그대로).

**긴 알림**: `sendNotification`은 보이는 글자 수(태그를 빼고 `&lt; &gt; &amp; &quot; &#39;`를 한 글자로 센 길이)가 4000자를 넘으면 메시지 원문을 줄여 4000자 안에 들게 하고 끝에 `…(truncated)`를 붙인다(4096에서 여유를 둠). 승인 요청은 이미 묶여 있어 그대로 둔다.

**사진**: 10MB(`10 * 1024 * 1024`)를 넘거나 받지 못하면 채팅에 `Photo not delivered: <이유>`를 보낸다. 이유는 `it is larger than 10 MB`, `Telegram did not return the file`, `the download failed`. 크기는 `file_size`가 있으면 받기 전에(선택 창을 띄우기 전에도), 없으면 받은 뒤 확인한다.

### 10. 대시보드 업로드 거절 — `server.ts`, `index.html`, `src/shared/types.ts`

Hub는 업로드를 버릴 때 보낸 대시보드에만 `{ type: 'upload_rejected', sessionId, reason }`를 보낸다. 대시보드는 그 세션이 선택돼 있으면 입력란 아래 오류 줄(멘션 오류와 같은 자리)에 `Image not delivered: <reason>`을 띄우고, 알림 목록에도 같은 내용을 warning으로 넣는다.

| 경우 | reason |
|---|---|
| 원격 세션 | `this session is on another PC; images can only go to sessions on the hub's PC` |
| 세션 연결 끊김 | `the session is not connected` |
| 형식 | `only PNG, JPEG, GIF and WebP images are supported` |
| 10MB 초과 | `the image is larger than 10 MB` |

## 하지 않는 것

- Hub가 어댑터 출력을 넘길 때 자기 출력 스트림 오류: Hub는 전경 창이나 로그 파일로만 출력해 실제로 깨지는 경로를 찾지 못했다
- 복원된 승인 요청이 여럿일 때 깜빡임, 승인 대기 확인과 steer 사이 틈(M2), "Queued" 알림의 경로, 연결 끊긴 세션으로 가는 텔레그램 사진·글
- 4초 `until`을 쓰는 첫 연결 테스트의 불안정(사용자 결정: 그대로)
- 다른 버전 어댑터가 섞여 도는 경우의 잠금 보장: 1.2.0 이하 어댑터는 새 잠금을 모른다. Hub 재시작으로 사라지며 안내만 한다

## 테스트

- `instance-lock`: Windows에서 실제 named pipe(테스트마다 임시 설정 폴더) — 첫 `owner`, 둘째 `held`(PID 일치), 동시 두 `acquireLock` 중 하나만 `owner`, 주인 `close()` 뒤 다시 `owner`, `status`·`stop`·토큰 불일치·잘못된 요청·4096바이트 초과·2초 무응답. 끝점 이름(경로 대소문자, 103바이트 초과). 맥·리눅스 경로(남은 소켓·정리 잠금·10초 기준)는 파일 시스템·소켓 함수를 바꿔 끼운 단위 테스트
- `main.ts`: 격리 HOME에서 어댑터 프로세스 둘을 동시에 띄워 하나만 남는지, `--watch-stdin` 어댑터가 기다렸다 주인이 멈추면 이어받는지. 설정의 `codex.command`는 없는 경로로 두어 실제 Codex 데몬에 닿지 않게 한다
- `start-check`·CLI: `queryOwner`를 바꿔 끼운 기존 방식 테스트에 새 보고 두 가지, 보고 없이 끝난 경우의 재확인, stop·status 표의 각 줄, 옛 PID 안내
- 감독자 `adapterEnv`, `connectProxy` 시간 제한(응답 없는 가짜 proxy), M3(구독 실패 뒤 idle에서 경고), M6, 승인 처리 예외
- 텔레그램: 가짜 `fetch`로 선택 두 개의 버튼이 각자 메시지를 보내는지, 만료 버튼의 `editMessageReplyMarkup`, 4000자 경계, 사진 크기·실패 메시지. 대시보드: Hub가 각 거절에 `upload_rejected`를 보내는지
- 실제 텔레그램으로는 아무것도 보내지 않는다

## 확인 못 하는 것

- 맥·리눅스에서 실제 소켓으로 도는 잠금(여기엔 Windows뿐)
- 다른 Windows 계정에서 파이프에 접근할 수 있는지(Node 기본 보안 설정). stop은 토큰으로 막는다
- 실제 텔레그램 화면(버튼 지움, 잘린 알림, 사진 거절 메시지)과 대시보드 오류 줄 모양 — 사용자 화면에서 확인
- 실제 Codex 데몬이 무응답일 때의 동작(가짜 proxy로만 확인)
