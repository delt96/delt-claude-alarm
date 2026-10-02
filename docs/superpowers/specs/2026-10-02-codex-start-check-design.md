# `codex start` — 띄운 어댑터가 Codex·Hub에 닿는지 확인

날짜: 2026-10-02 · 상태: 사용자 승인(2026-10-02)

## 배경

`claude-alarm codex start`(`src/cli.ts:366-381`)는 어댑터(`dist/codex/main.js`)를 분리 실행으로 띄우자마자 `Codex adapter started (PID: …)`를 출력한다. 프로세스가 살아남았는지, Codex 데몬에 붙었는지, Hub에 닿는지는 보지 않는다. `hub start -d`에 같은 문제가 있었고 e71014b에서 고쳤다(`src/hub/readiness.ts`). 그 작업의 최종 리뷰가 이 명령을 범위 밖으로 남겼다.

`codex start`는 Codex가 Hub와 다른 PC에 있을 때 쓰는 명령이다(README 80·195행). 그 PC에서 실제로 막히는 곳은 프로세스보다 Hub 주소·토큰과 Codex 데몬이다.

확인한 사실:

- 데몬이 없는 소켓을 가리키면 `codex app-server proxy --sock <없는 소켓>`은 약 0.1초 만에 종료 코드 1로 끝나고(`failed to connect to socket … os error 10061`) 데몬을 띄우지 않는다(2026-10-02 실측, 기본 소켓 경로는 미확인). 어댑터는 `Codex daemon connection failed: <오류>`를 남기고 2초→60초 간격으로 재시도한다. 오류 문구는 proxy 종료(`codex proxy exited (code N)`)와 소켓 끊김 중 먼저 온 쪽이며, Windows에서는 `socket hang up`이 먼저 오기도 한다(2026-10-02 테스트)(`src/codex/adapter.ts:83-136`)
- 어댑터는 Codex 대화마다 Hub에 연결한다(`adapter.ts:186-216`). 열린 대화가 없으면 Hub에 접속하지 않으므로 Hub 주소·토큰이 틀려도 드러나지 않는다
- Hub `/api/status`는 토큰을 검사한다. 틀리면 401(`src/hub/server.ts:213-228`). 정상 응답 본문은 `{ running: true, pid, port, sessions, uptime }`
- `RpcClient` 요청은 30초 시간 제한이 있다(`src/codex/rpc.ts:23`)
- `loadConfig`는 설정 파일에 토큰이 없으면 새로 만들어 저장한다(`src/shared/config.ts:41-44`)
- `init`에서 원격 Hub를 고르면 주소·포트·토큰은 그 프로젝트의 `.mcp.json` env에만 들어간다(`src/cli.ts:283-300`). `codex start`가 읽는 `~/.claude-alarm/config.json`에는 들어가지 않는다
- Windows에서 `detached: true, stdio: ['ignore', fd, fd, 'ipc']`로 띄운 자식의 `process.send`가 342ms 뒤 도착했고, 부모가 `disconnect()`·`unref()` 후 끝나도 자식은 계속 실행됐다. 끊긴 뒤 `process.connected`는 `false`(2026-10-02 실측)
- `src/codex/main.ts:31`은 Hub host를 `env ?? (0.0.0.0이면 127.0.0.1, 아니면 그대로)`로 정해 `''`·`::`·IPv6 주소에서 잘못된 URL이 된다. `src/shared/hub-url.ts`의 `hubUrlHost`는 이미 이 경우를 처리한다

## 결정 (사용자, 2026-10-02)

- 확인 범위: 프로세스, Codex 데몬 첫 연결, Hub 접속 세 가지 모두
- 어댑터 → CLI 전달: IPC 채널(상태 파일·로그 읽기 대신)
- 설계를 Codex에게 검토받음(`codex run`, 판정 approve_with_changes). 반영 내용은 아래 각 항목에 들어 있다. Codex가 제안한 "CLI가 정한 Hub 설정(토큰 포함)을 환경 변수로 어댑터에 넘기기"는 채택하지 않았다 — 설정을 띄우기 전에 읽는 것(3-1)으로 경쟁이 사라지고, 토큰을 프로세스 환경에 싣지 않는다

## 설계

### 1. Hub 주소 — `src/codex/hub-target.ts` (새 파일)

```ts
export interface AdapterHub {
  host: string;            // URL에 바로 쓰는 형태(IPv6는 대괄호)
  port: number;
  token?: string;
  fromEnv: { host: boolean; port: boolean; token: boolean };
}
export function resolveAdapterHub(config: AppConfig, env: NodeJS.ProcessEnv = process.env): AdapterHub
```

- host: `hubUrlHost(env.CLAUDE_ALARM_HUB_HOST ?? config.hub.host)` — `''`·`0.0.0.0` → `127.0.0.1`, `::` → `[::1]`, IPv6 → `[주소]`, 대괄호가 이미 있으면 그대로
- port: `CLAUDE_ALARM_HUB_PORT`가 있으면 `parseInt(…, 10)`, 없으면 `config.hub.port`
- token: `env.CLAUDE_ALARM_HUB_TOKEN ?? config.hub.token`
- `fromEnv`: 각 값이 환경 변수에서 왔는지(안내 문구용)

`src/codex/main.ts`는 31–33행 대신 이 함수를 쓴다. 그래서 Hub가 띄우는 어댑터도 `''`·`::`·IPv6 host에서 HubClient와 `Codex not found` 알림이 맞는 주소로 간다(2026-10-02 `hub start -d` 작업에서 남긴 과제를 함께 해결 — 의도한 동작 변경). `HubClient` 생성자는 바꾸지 않는다.

### 2. 어댑터 — `src/codex/adapter.ts`, `src/codex/main.ts`

```ts
export type FirstConnect =
  | { connected: true; userAgent?: string }
  | { connected: false; error: string; notFound: boolean };
// CodexAdapterOptions
onFirstConnect?: (outcome: FirstConnect) => void;
```

- 인스턴스마다 **최대 한 번**, 첫 연결 시도의 결과로 부른다
  - 성공: `initialize` 응답과 `initialized` 알림 직후, `discover()` 전 → `{ connected: true, userAgent: init.userAgent }`
  - 실패: `connect()`의 `catch`에서 아직 알리지 않았으면 → `{ connected: false, error: err.message, notFound: code === 'ENOENT' }`
  - 성공을 알린 뒤 `discover()`가 실패해도 다시 알리지 않는다
- "알림" 표시는 콜백을 부르기 **전에** 한다. 콜백이 던진 예외는 잡아서 debug 로그만 남긴다 — 연결을 끊거나 재시도 예약을 막지 않는다
- `stop()` 뒤에는 부르지 않는다

`main.ts`:

- `const config = loadConfig()`와 `resolveAdapterHub(config)`로 Hub 주소를 정한다
- IPC가 있을 때만 결과를 보낸다:
  ```ts
  onFirstConnect: (outcome) => {
    if (!process.send || !process.connected) return;
    process.send({ type: 'codex-first-connect', ...outcome }, (err) => { if (err) logger.debug(…); });
  }
  ```
  완료 콜백이 있으면 확인과 전송 사이에 채널이 닫혀도 오류가 콜백으로 온다. Hub가 띄우는 어댑터(`--watch-stdin`, IPC 없음)는 아무것도 보내지 않는다
- IPC가 끊겨도 어댑터는 종료하지 않는다(종료 처리기를 걸지 않는다)

### 3. `codex start` — `src/cli.ts`, 도우미는 `src/codex/start-check.ts` (새 파일)

#### 3-1. 순서

1. `loadConfig()` — 띄우기 **전에** 읽어 새 PC에서 토큰 생성·저장을 끝낸다(부모·자식이 동시에 다른 토큰을 만들지 않게). `hub = resolveAdapterHub(config)`, `command = config.codex?.command ?? 'codex'`
2. 이미 실행 중(`codex.pid`의 PID가 살아 있음):
   - `Codex adapter is already running (PID: X)`
   - `  Codex daemon: not checked (the adapter was already running)`
   - Hub 확인 줄(아래 3). 종료 코드 0
3. 띄우기: `spawn(process.execPath, [<main.js>], { detached: true, stdio: ['ignore', logFd, logFd, 'ipc'], windowsHide: true, env: { ...process.env } })`
   - `'exit'`·`'error'`를 띄운 직후부터 출력 직전까지 계속 기록한다
   - `child.pid`가 없거나 `'error'`가 오면 stderr `Codex adapter failed to start: <message>`, 종료 코드 1
4. 동시에 기다린다:
   - `waitForAdapterReport(child, 10_000)` — 먼저 오는 것: `codex-first-connect` 메시지(다른 메시지는 무시) / 종료(`exit` 또는 `error`) / 10초
   - `checkHub(hub, 3000)`
5. 둘 다 끝나면 `if (child.connected) child.disconnect(); child.unref();`
6. **그 사이 어느 때든 자식이 종료했으면 종료가 우선한다**(보고를 받았어도):
   - `codex.pid`가 자식 PID를 담고 있을 때만 지운다(파일은 자식이 쓴다 — 다른 어댑터의 파일일 수 있다)
   - 파일이 살아 있는 다른 PID를 가리키면(동시에 실행된 다른 `codex start`) 2번의 "이미 실행 중" 세 줄을 출력하고 종료 코드 0
   - 아니면 stderr `Codex adapter exited during startup (<code N | signal S>). See <CODEX_LOG_FILE>`, 종료 코드 1
7. 살아 있으면 stdout으로 출력하고 종료 코드 0:
   ```
   Codex adapter started (PID: 1234). Logs: <CODEX_LOG_FILE>
     Codex daemon: <데몬 줄>
     Hub: <Hub 줄>
   ```
   데몬 줄이나 Hub 줄이 경고면 마지막에 한 줄 더: `  After fixing this, restart the adapter: claude-alarm codex stop, then claude-alarm codex start`

#### 3-2. 문구 (영어, 정확히 이대로)

`<url>` = `http://<hub.host>:<hub.port>`.

데몬 줄:

| 결과 | 문구 |
|---|---|
| 성공 | `Codex daemon: connected (<userAgent 또는 unknown version>)` |
| `notFound` | `Codex daemon: "<command>" not found. Install Codex or set "codex.command" in ~/.claude-alarm/config.json, and run the restart from a new terminal.` |
| 그 밖의 실패 | `Codex daemon: not connected (<error>). Is Codex running? The adapter keeps retrying.` |
| 10초 경과 | `Codex daemon: no answer within 10s. The adapter keeps trying. See <CODEX_LOG_FILE>` |

Hub 줄 — `checkHub`는 요청 하나(`GET <url>/api/status`, 토큰이 있으면 `Authorization: Bearer <token>`, 3000ms 제한):

| 결과 | 판정 | 문구 |
|---|---|---|
| `ok` | 200이고 본문 JSON의 `running === true` | `Hub: reachable at <url>` |
| `unauthorized` | 401 | `Hub: <url> rejected the token (401). Check <token 출처>.` |
| `not-hub` | 그 밖의 응답(200이지만 본문이 다름, JSON 아님 포함) | `Hub: <url> answered <status> but is not a claude-alarm hub. Check <주소 출처>.` |
| `unreachable` | 연결 실패·시간 초과 | `Hub: not reachable at <url> (<reason>). Check <주소 출처> and that the hub is running.` |

- `<reason>`: 오류의 `cause.code`(예: `ECONNREFUSED`), 없으면 오류 `name`(시간 초과는 `TimeoutError`)
- `<token 출처>`: `fromEnv.token`이면 `CLAUDE_ALARM_HUB_TOKEN`, 아니면 `hub.token in ~/.claude-alarm/config.json`
- `<주소 출처>`: host와 port 각각 `fromEnv`면 `CLAUDE_ALARM_HUB_HOST`/`CLAUDE_ALARM_HUB_PORT`, 아니면 `hub.host`/`hub.port`를 ` and `로 잇고, 설정 파일 값이 하나라도 있으면 끝에 ` in ~/.claude-alarm/config.json`. 예: `hub.host and hub.port in ~/.claude-alarm/config.json`, `CLAUDE_ALARM_HUB_HOST and hub.port in ~/.claude-alarm/config.json`, `CLAUDE_ALARM_HUB_HOST and CLAUDE_ALARM_HUB_PORT`

#### 3-3. 도우미 (`src/codex/start-check.ts`)

출력 문구를 만드는 부분과 기다리는 부분을 CLI에서 떼어 테스트한다.

```ts
export type AdapterReport =
  | { kind: 'report'; outcome: FirstConnect }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; error?: Error }
  | { kind: 'timeout' };
export function waitForAdapterReport(child: ChildProcess, timeoutMs: number): Promise<AdapterReport>;

export type HubCheck =
  | { kind: 'ok' }
  | { kind: 'unauthorized' }
  | { kind: 'not-hub'; status: number }
  | { kind: 'unreachable'; reason: string };
export function checkHub(hub: AdapterHub, timeoutMs?: number): Promise<HubCheck>;

// 'exited' is handled by the CLI (3-1 step 6), never turned into a daemon line.
export function daemonLine(report: Exclude<AdapterReport, { kind: 'exited' }>, command: string, logFile: string): { text: string; warning: boolean };
export function hubLine(check: HubCheck, hub: AdapterHub): { text: string; warning: boolean };
```

`waitForAdapterReport`는 시간 제한 타이머를 정리하고 리스너를 떼고 끝난다. 결과의 `exited`와 별개로 CLI는 3-1의 3번에서 건 리스너로 종료를 계속 본다.

### 4. README

- 80행 표: `start`가 Codex와 Hub에 닿는지 알려 준다는 것
- 195행: 다른 PC의 `codex start`는 그 PC의 `~/.claude-alarm/config.json`(또는 `CLAUDE_ALARM_HUB_HOST`/`_PORT`/`_TOKEN`)에서 Hub 주소·토큰을 읽는다. `init`에서 답한 원격 Hub 설정은 그 프로젝트의 `.mcp.json`에만 들어가 여기에는 적용되지 않는다

## 범위 밖

- `codex status`에 연결 상태 표시
- `connectProxy`의 시간 제한 없음(proxy가 멈추는 경우) — 단계 A 리뷰 minor 묶음
- `HubClient`·채널 서버의 Hub 주소 처리
- Hub가 띄우는 어댑터의 그 밖의 동작(1의 host 정규화만 바뀐다)

## 테스트

- **Hub 주소** (`test/codex-hub-target.test.ts`): `0.0.0.0`·`''` → `127.0.0.1`, `::` → `[::1]`, `fe80::1` → `[fe80::1]`, 이름은 그대로, 환경 변수 host(`::1` → `[::1]`)·port·token이 설정보다 우선, `fromEnv` 값
- **첫 연결 보고** (`test/codex-adapter.test.ts`, 기존 `FakeDaemon`·`spawnFn` 방식): 성공 → `{ connected: true, userAgent }` 한 번 / `ENOENT` 재시도 3번 이상 → `{ connected: false, notFound: true }` 한 번 / proxy 바로 종료 → `notFound: false` / 성공 때 콜백이 던져도 연결이 유지되고 대화가 Hub에 등록됨 / 실패 때 콜백이 던져도 재시도가 이어짐
- **main.ts IPC** (`test/codex-main-ipc.test.ts`): `node --import tsx src/codex/main.ts`를 IPC와 격리 HOME으로 띄우고, 설정의 `codex.command`를 없는 파일 경로로 둔다 → `{ type: 'codex-first-connect', connected: false, notFound: true }`를 받는다. 끝나면 그 PID만 종료한다. 실제 Codex·데몬은 쓰지 않는다
- **도우미** (`test/codex-start-check.test.ts`): `waitForAdapterReport`를 가짜 자식(EventEmitter)으로 — 보고·다른 메시지 무시·종료·`error`·시간 초과. `checkHub`를 로컬 http 서버로 — 200+`running`·200 다른 본문·401·닫힌 포트·응답 지연(짧은 제한). `daemonLine`·`hubLine` 문구(환경 변수 출처 포함)
- **실측** (`dist`, 격리 HOME, Hub 포트는 7900이 아닌 값, 실제 데몬 사용 전 claude-alarm `notify`로 미리 알림):
  1. 격리 Hub 실행 + 실제 데몬 → `connected` · `reachable`, 종료 코드 0. `codex stop`
  2. Hub 꺼짐 → `not reachable … (ECONNREFUSED)` + 재시작 안내 줄
  3. 토큰 틀림 → `rejected the token (401)`
  4. `codex.command`가 없는 파일 → `not found`
  5. `codex start` 두 번을 거의 동시에 실행 → 어댑터는 하나만 남고, 다른 쪽은 `already running` 세 줄과 종료 코드 0(3-1의 2번 또는 6번 경로). 어느 쪽도 종료된 어댑터에 `started`를 출력하지 않는다
  6. 띄운 어댑터 node 프로세스의 창 핸들(`MainWindowHandle`)이 0
