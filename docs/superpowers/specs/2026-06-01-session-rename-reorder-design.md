# 대시보드 세션 이름 변경 & 순서 변경 설계

날짜: 2026-06-01
대상: `src/dashboard/index.html` (단일 파일, 서버 변경 없음)

## 배경 / 제약

- 세션 ID는 채널 접속 시마다 `randomUUID()`로 새로 생성됨 (`src/channel/server.ts:16`) → 세션은 **휘발성**.
- 세션 정보는 hub 메모리(`SessionManager`의 `Map`)에만 존재. 서버 재시작/연결 해제 시 소멸.
- 대시보드는 `renderSessions()`에서 `Object.keys(state.sessions)`(등록 순서)로 카드를 렌더링하고, 이름은 `s.displayName || s.name`을 표시.
- 메시지는 이미 localStorage(`claude-alarm-messages`, 세션별 최근 5개)에 저장 중.

## 목표

사용자가 대시보드에서 세션 카드의 **이름을 바꾸고**, **순서를 재배치**할 수 있게 한다. 휘발성 의도에 맞춰 가볍게.

## 결정 사항

- **영속성 범위**: 휘발성. localStorage에 `sessionId`를 키로 저장.
  - 브라우저 새로고침: sessionId 유지(터미널 살아있음) → 이름·순서 유지.
  - 세션 재접속 / 서버 재시작: 새 sessionId → 자동 초기화.
- **이름 변경 UX**: 카드 이름 **더블클릭** → 인라인 `<input>` 편집 → Enter 저장 / Esc 취소 / blur 저장.
- **순서 변경 UX**: 카드 좌측 **드래그 핸들 아이콘(⠿)** → HTML5 drag & drop 재배치.
- **저장소**: localStorage 키 `claude-alarm-session-meta` = `{ names: { [sessionId]: string }, order: string[] }`.
- **수동 초기화 버튼 없음**: 세션 목록 갱신 시 자동 prune.

## 데이터 모델

```js
// localStorage: claude-alarm-session-meta
{
  names: { "<sessionId>": "사용자 지정 이름" },
  order: ["<sessionId>", ...]   // 명시적으로 재배치된 순서
}
```

`state.sessionMeta = { names: {}, order: [] }`로 메모리에 로드.

## 동작 정의

### 렌더링 (`renderSessions`)
1. 표시 순서: `state.sessionMeta.order`에 있는 sessionId를 그 순서대로 먼저, order에 없는(새로 들어온) 세션은 등록 순서로 뒤에 붙임.
2. 표시 이름 우선순위: `sessionMeta.names[id]` → `s.displayName` → `s.name`.
3. 카드 좌측에 드래그 핸들 아이콘 추가. 카드에 `draggable` 적용은 핸들 기준.

### 이름 변경
- 이름 영역 더블클릭 → 인라인 input으로 교체, 현재 이름 prefill, 자동 포커스/select.
- Enter 또는 blur → 트림한 값 저장. 빈 값이면 커스텀 이름 제거(기본 이름으로 복귀).
- Esc → 취소.
- 저장 후 `saveSessionMeta()` + `renderSessions()`.

### 순서 변경 (drag & drop)
- 핸들에서 dragstart → 대상 카드 식별.
- dragover/drop으로 위치 계산, `sessionMeta.order`를 현재 화면 순서 기준으로 재구성 후 드롭 위치 반영.
- drop 후 `saveSessionMeta()` + `renderSessions()`.
- 드래그 중 카드에 시각적 표시(`.dragging`, drop 위치 표시).

### 자동 prune
- `sessions_list` 수신 시: 현재 살아있는 sessionId 집합 기준으로 `sessionMeta.names`/`sessionMeta.order`에서 없는 키 제거. 죽은 세션 메시지(`state.messages`)도 함께 정리.
- `session_disconnected` 수신 시: 해당 sessionId 엔트리 제거.
- prune 후 `saveSessionMeta()` / `saveMessages()`.

### 기타 반영 지점
- `renderMessages()` 헤더 이름도 `sessionMeta.names` 우선 반영.
- 알림 패널의 세션명 표시도 동일 규칙 적용(여력 되면).

## 비목표 (YAGNI)

- 서버/타입(`SessionInfo`, `ChannelMessage`) 변경 없음.
- 다중 기기/브라우저 동기화 없음.
- 폴더(cwd) 기준 영속 이름 매핑 없음(휘발성 결정에 따름).

## 검증

- 빌드: 해당 없음(정적 HTML). 브라우저에서 수동 확인.
- 시나리오: 이름 변경 → 새로고침 유지 확인 / 순서 변경 → 새로고침 유지 / 세션 끊기 → 해당 메타 제거 / 빈 이름 → 기본 이름 복귀.
- 참조 grep: `displayName` 사용처, `renderSessions` 호출처, localStorage 키 충돌 여부 확인.
```
