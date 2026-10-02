# Codex를 못 찾을 때 — 표준 위치에서 찾기와 알림 한 번

날짜: 2026-10-02 · 상태: 사용자 승인(2026-10-02)

## 배경

Codex 어댑터는 `codex app-server proxy`를 띄워 공유 데몬에 붙는다. `codex`가 PATH에 없으면 실행이 `spawn codex ENOENT`로 실패하고, 어댑터는 2초→60초 간격으로 다시 시도하며 Hub 콘솔에 `Codex daemon connection failed: spawn codex ENOENT`만 남긴다. 대시보드·알림에는 아무것도 없다.

실제 사례(2026-10-01): 사용자가 Codex 설치 전에 연 PowerShell 창에서 Hub를 띄워, 그 창의 PATH에 Codex 경로가 없었다. 사용자 PATH(레지스트리)에는 들어 있었고 새 창에서는 찾았다. 이 PC의 Codex는 standalone 설치 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`(→ `~/.codex/packages/standalone/current/bin` 링크)다.

어댑터는 Codex 대화마다 Hub에 연결하므로, 데몬에 못 붙으면 Hub와의 연결 자체가 없다. 그래서 알림은 Hub의 기존 HTTP API를 쓴다.

## 목표

1. Windows에서 `codex`가 PATH에 없어도 표준 설치 위치에 있으면 찾아서 붙는다.
2. 그래도 못 찾으면 어댑터 프로세스마다 한 번 알림을 보낸다.

## 결정 (사용자, 2026-10-02)

- 범위: 찾기 + 알림 한 번. 대시보드 상태 표시줄·새 통로는 만들지 않는다
- 찾는 곳: Windows 표준 설치 위치 두 곳. 레지스트리 PATH 다시 읽기는 하지 않는다(다른 위치는 기존 `codex.command` 설정)
- 알림 조건: codex를 못 찾았을 때(`ENOENT`)만. 데몬 미실행 등 다른 실패는 지금처럼 콘솔 경고만

## 설계

### 1. codex 찾기 — `src/codex/transport.ts`

새 함수 `findCodex(command, platform = process.platform, env = process.env): string | undefined`:

1. `findOnPath(command, platform, env)` — 지금 그대로(`.exe` 먼저, 그다음 `.cmd`, PATH 순서)
2. 없고 `platform === 'win32'`이면 표준 위치를 이 순서로 확인하고, 있는 첫 파일을 돌려준다:
   1. `<LOCALAPPDATA>\Programs\OpenAI\Codex\bin\<command>.exe` (standalone 설치)
   2. `<APPDATA>\npm\<command>.cmd` (npm 전역 설치)
   - 환경 변수(`LOCALAPPDATA`, `APPDATA`)가 없으면 그 위치는 건너뛴다
3. 그래도 없으면 `undefined`

PATH가 표준 위치보다 항상 먼저다(PATH에 `.cmd`만 있고 표준 위치에 `.exe`가 있어도 PATH의 `.cmd`).

`resolveCommand`는 Windows에서 이름만 있는 명령(구분자·확장자 없음)일 때 `findOnPath` 대신 `findCodex`를 쓴다. 찾은 파일이 `.cmd`면 지금처럼 셸로 실행한다. 경로를 지정한 명령(`codex.command`에 경로)과 Windows가 아닌 플랫폼은 지금과 같다.

`claude-alarm init`의 "Codex를 쓸까요?" 판단(`src/cli.ts`의 `shouldOfferCodex(config, findOnPath('codex') !== undefined)`)도 `findCodex('codex')`를 쓴다 — 표준 위치에만 있어도 묻는다.

### 2. 못 찾으면 알림 한 번 — `src/codex/adapter.ts`

- `connect()`의 실패 처리에서 오류 코드가 `ENOENT`이고, 이 어댑터 인스턴스에서 아직 알림을 보내지 못했으면 Hub에 알린다
- 요청: `POST http://<opts.hub.host>:<opts.hub.port>/api/notify`, 헤더 `Content-Type: application/json`, 토큰이 있으면 `Authorization: Bearer <token>`, 본문 `{ title, message, level: 'warning' }`, 요청 하나당 최대 5000ms
- 요청이 시간 초과로 끝나면 보낸 것으로 친다 — Hub의 `/api/notify`는 데스크톱 알림 처리가 끝난 뒤에 응답하므로(`notifier.notify`를 기다림, `wait: true`) 알림 표시 방식에 따라 시간 제한을 넘길 수 있고, 그때도 Hub는 요청을 받은 것이다(최종 리뷰에서 지적, 이 PC 실측은 465ms라 재현되지 않음). 테스트용으로 시간은 어댑터 옵션 `noticeTimeoutMs`(기본 5000)
- 문구(영어, 정확히 이대로):
  - title: `Codex not found`
  - message: `The Codex adapter cannot find "<command>". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.` (`<command>`는 `opts.command`)
- 응답이 2xx면 "보냄"으로 기록하고 이 인스턴스에서는 다시 보내지 않는다. 연결 실패·2xx가 아닌 응답이면 기록하지 않아 다음 `ENOENT` 재시도 때 다시 보낸다. 전송 실패는 debug 로그만
- 전송 중에 또 `ENOENT`가 나면 새로 보내지 않는다(동시에 하나만)
- 알림 전송은 재시도 예약을 막거나 늦추지 않는다(기다리지 않고 보낸다)
- 기존 콘솔 경고(`Codex daemon connection failed: …`)는 그대로 둔다
- 알림이 가는 곳: Hub `notifier`의 데스크톱 알림·웹훅. 세션이 없는 알림이라 텔레그램·대시보드에는 가지 않는다(기존 `/api/notify` 동작)

어댑터 프로세스가 새로 뜨면(Hub 재시작, `codex start`) 다시 한 번 보낼 수 있다.

### 3. README

`README.md` 186–187행의 Codex 안내에 덧붙인다: Windows에서는 PATH에 없을 때 standalone·npm 표준 설치 위치도 찾는다는 것, 그래도 못 찾으면 `Codex not found` 알림이 한 번 온다는 것.

## 범위 밖

- 대시보드 Codex 상태 표시, 텔레그램 알림
- 레지스트리 PATH 다시 읽기, macOS·Linux 표준 위치
- 데몬 미실행·proxy 종료 등 `ENOENT`가 아닌 실패의 알림
- `src/codex/main.ts:31`의 Hub host 처리(IPv6·빈 host — 2026-10-02 `hub start -d` 작업에서 따로 남긴 과제). 알림 URL은 HubClient와 같은 `opts.hub.host`를 쓴다

## 테스트

- **찾기** (`test/codex-transport.test.ts`): `findCodex`·`resolveCommand`에 `platform: 'win32'`와 임시 폴더를 가리키는 `env`(`PATH`, `LOCALAPPDATA`, `APPDATA`)를 넘긴다. 실제 PATH·설치에 의존하지 않으므로 OS에 상관없이 돈다:
  - PATH에 없고 `LOCALAPPDATA` 아래 standalone `codex.exe`만 있음 → 그 경로
  - PATH에 없고 `APPDATA\npm\codex.cmd`만 있음 → 그 경로, `resolveCommand`는 `shell: true`
  - 둘 다 있음 → standalone
  - PATH에 `.cmd`, 표준 위치에 `.exe` → PATH의 `.cmd`
  - 아무 데도 없음 → `undefined`, `resolveCommand`는 지금처럼 `{ file: 'codex', shell: false }`
  - `LOCALAPPDATA`·`APPDATA`가 없는 환경 → 오류 없이 `undefined`
  - `platform: 'linux'` → 표준 위치를 보지 않음
- **알림** (`test/codex-adapter.test.ts`): Hub 자리에 요청을 기록하는 http 서버를 두고, 없는 실행 파일을 띄우는 `spawnFn`으로 재시도를 여러 번 일으킨다
  - `ENOENT` 재시도 3번 이상 → `/api/notify` 요청 정확히 1번, 본문·토큰 헤더가 위 값과 같음
  - 첫 응답 500, 둘째 200 → 요청 2번, 그 뒤로는 없음
  - `ENOENT`가 아닌 실패(proxy가 바로 종료) → 요청 0번
- **실측** (격리 HOME, Hub 포트는 7900·7990–7998이 아닌 값, 실제 데몬 사용 전 claude-alarm `notify`로 미리 알림):
  - PATH에서 Codex 경로를 뺀 환경으로 Hub를 띄우면(Codex 켬) 어댑터가 standalone codex로 실제 데몬에 붙는다(`Connected to Codex daemon` 로그)
  - `LOCALAPPDATA`도 빈 임시 폴더로 바꾸면 웹훅(로컬 기록 서버)으로 `Codex not found`가 1번 온다. 데스크톱 알림은 끈 설정으로 한다
