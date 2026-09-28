# 허브 페이지 `@이름` → Claude Code SendMessage 연결 설계

날짜: 2026-09-28
대상: `src/channel/`, `src/shared/types.ts`, `src/hub/`, `src/dashboard/index.html`

## 배경 / 문제

- Claude Code는 세션 간 메시지(`SendMessage` / `ListAgents`)를 기본 제공한다 (Windows 지원: 2.1.239).
- 실제로 써 보면 **상대 세션을 찾고 지정하기가 어렵다.** `ListAgents` 이름은 `kg_ebill_front-3a`처럼 폴더명 + 임의 접미사로 자동 생성되어, 사람이 기억하거나 말로 지정하기 힘들다.
- 허브 페이지(대시보드)는 이미 사람이 붙인 이름(더블클릭 rename, `localStorage`)과 폴더명으로 세션을 구분하고 있다.

## 목표

허브 페이지 입력창에서 `@사용자가 지정한 이름`으로 다른 세션을 가리키면, **선택된 세션의 Claude가 내용을 정리해 기본 `SendMessage`로 정확한 대상에게 전달**하게 한다.

비목표:
- 허브를 통한 별도 세션 간 전달 경로를 만들지 않는다 (전달은 Claude Code 기본 기능).
- 세션 간 오간 메시지를 허브 페이지에 표시하지 않는다.
- 사용자 지정 이름의 영속화·허브 동기화는 하지 않는다 (기존 휘발성 정책 유지).
- Telegram 쪽 `@` 지원은 하지 않는다.

## Spike로 확인된 사실 (2.1.283)

- `~/.claude/sessions/<Claude pid>.json`에 세션마다 `ListAgents` 이름이 기록된다.
  ```json
  {"pid":10040,"sessionId":"bc2b125c-…","cwd":"C:\\workspace\\claude-alarm",
   "messagingSocketPath":"\\\\.\\pipe\\LOCAL\\cc-msg-aecea7ad…",
   "name":"claude-alarm-e4","nameSource":"derived","status":"busy", …}
  ```
- Claude가 띄운 stdio MCP 서버는 `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`을 **자기 값으로 새로 받는다** (`claude -p` 세션에서 확인).
- `CLAUDE_PID`는 상위 셸에서 상속된 값이 남을 수 있어 신뢰 불가. `process.ppid`는 npx/cmd가 끼어 Claude pid가 아니다.
- 미확인: interactive 세션이 띄운 MCP 서버의 환경변수 → 구현 1단계에서 확인.
- `sessions/*.json`은 **비공개 내부 파일**이다. 형식이 바뀔 수 있으므로 실패 시 기능만 꺼지게 한다.

## 설계

### 1. 채널 서버: 자기 `SendMessage` 이름 찾기

새 파일 `src/channel/peer-name.ts`:

```ts
interface PeerLookupEnv { messagingSocket?: string; sessionId?: string }
// 순수 함수: 파싱된 세션 레코드 목록에서 자기 이름을 찾는다
export function findPeerName(records: unknown[], env: PeerLookupEnv): string | undefined
// I/O: <configDir>/sessions/*.json 을 읽어 findPeerName 호출
export function readPeerName(env?: NodeJS.ProcessEnv): string | undefined
```

- 설정 폴더: `CLAUDE_CONFIG_DIR` → 없으면 `os.homedir()/.claude`.
- 매칭 우선순위: `messagingSocketPath === CLAUDE_CODE_MESSAGING_SOCKET` (프로세스 단위로 고정) → `sessionId === CLAUDE_CODE_SESSION_ID`.
- `name`이 비어 있지 않은 문자열일 때만 반환.
- 환경변수 없음 / 폴더 없음 / JSON 파싱 실패 / 일치 없음 → `undefined`. 예외를 던지지 않는다 (개별 파일 파싱 실패는 건너뜀).
- `server.ts`: 시작 시 한 번 읽어 등록에 포함하고, **30초 주기**로 다시 읽어 값이 바뀌면 허브에 알린다. `fs.watch`는 Windows 불안정으로 쓰지 않는다.

### 2. 공유 타입 / 허브

- `SessionInfo`에 `peerName?: string` 추가.
- 새 채널 메시지: `{ type: 'peer_name'; sessionId: string; peerName?: string }`.
- 허브는 `peer_name` 수신 시 세션의 `peerName`을 갱신하고 기존 `session_updated`로 대시보드에 방송한다. 해석 로직은 두지 않는다.
- `hub-client`의 재연결 시 재등록 메시지에 최신 `peerName`이 포함되어야 한다.

### 3. 허브 페이지: `@` 자동완성

- 트리거: 커서 앞 토큰이 줄 시작 또는 공백 뒤의 `@`로 시작할 때. (`a@b.com`은 무시)
- 후보: 현재 선택된 세션을 제외하고 `peerName`이 있는 세션. 표시: `사용자 지정 이름 · 폴더명`.
- 입력 중 텍스트로 필터링(대소문자 무시, 부분 일치 — 후보 표시용일 뿐 해석은 완전 일치).
- 조작: ↑/↓ 이동, Enter/Tab 선택, Esc 닫기. 팝업이 열려 있는 동안 Enter는 전송이 아니라 선택.
- 삽입: 공백 없는 이름 → `@프론트 `, 공백 포함 → `@[ebill 백엔드] `.

### 4. 허브 페이지: 전송 시 해석

- 추출 규칙: `(^|\s)@\[([^\]]+)\]` 또는 `(^|\s)@(\S+)`.
- 정규화: trim, NFC, 소문자.
- 해석: 선택 세션 제외, `peerName` 있는 세션 중
  1. 사용자 지정 이름 완전 일치
  2. 폴더명(`displayName`) 완전 일치
  → 정확히 1개일 때만 성공.
- 하나라도 실패(없음/모호/`peerName` 없음)하면 **전송하지 않고** 입력창 아래에 `알 수 없는 세션: @프론트` 형태로 표시한다.
- 성공 시 원문 뒤에 라우팅 줄을 붙여 기존 `message_to_session`으로 선택 세션에 보낸다:
  ```
  @프론트 API 바뀌었다고 알려줘

  [claude-alarm] @프론트 = SendMessage to "kg_ebill_front-3a"
  ```
  멘션이 여러 개면 라우팅 줄도 여러 개. 같은 대상 중복은 한 줄로.
- `@` 토큰이 없으면 기존 동작 그대로.

### 5. rename 중복 방지

- 대시보드 rename 저장 시, 다른 살아있는 세션의 사용자 지정 이름 또는 폴더명과 정규화 기준으로 같으면 저장하지 않고 입력칸에 오류 표시 후 편집 상태를 유지한다.

### 6. 채널 instructions

한 줄 추가 (현재 1,103자, 제한 2,048자):

> If a dashboard message contains lines like `[claude-alarm] @X = SendMessage to "Y"`, do what the message asks and deliver the result with the SendMessage tool to exactly "Y". Do not guess other recipients.

## 오류 처리 요약

| 상황 | 동작 |
|---|---|
| sessions 파일 읽기 실패 / 형식 변경 | `peerName` 없음 → 해당 세션은 `@` 후보에서 빠짐 |
| 모르는 / 모호한 `@이름` | 전송 차단, 입력창 아래 안내 |
| 30초 사이 `/rename`으로 이름 변경 | `SendMessage` 실패 → Claude가 사용자에게 보고 (허용하는 한계) |
| 대상 세션이 채널 없이 실행 | 허브에 없으므로 후보에 없음 |

## 테스트

- 단위: `findPeerName` — socket 일치, sessionId 폴백, socket 우선, 불일치, 빈 name, 잘못된 레코드 혼입, env 없음. `node:test` + `tsx`(devDependency 추가), `npm test`.
- 수동 E2E (채널 세션 2개):
  1. 두 채널 서버에서 환경변수 수신 확인 → `peerName`이 허브 페이지에 도착.
  2. `@` 자동완성 표시/필터/선택/공백 이름 대괄호.
  3. 전송 → 라우팅 줄 포함 확인 → 대상 세션이 SendMessage로 수신.
  4. 모르는 이름 전송 차단, 이메일 텍스트 무시.
  5. rename 중복 거부.
