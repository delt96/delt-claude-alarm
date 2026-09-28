# 허브 인증 강화 설계

날짜: 2026-09-28
대상: `src/hub/server.ts`, `src/hub/telegram.ts`, `src/dashboard/index.html`, `src/cli.ts`, `README.md`

## 배경 / 문제

허브는 원격 접속을 지원하면서 로컬 편의를 위해 **루프백 요청의 토큰 검사를 면제**한다 (`isLocalRequest` → `server.ts:92`, `:180`). 이 면제는 다음을 허용한다.

- **브라우저 드라이브바이**: 사용자가 연 임의 웹페이지의 요청도 출발지가 `127.0.0.1`이다. 브라우저는 WebSocket에 CORS를 적용하지 않고 허브는 `Origin`을 보지 않으므로, 어느 사이트든 `ws://127.0.0.1:7900/ws/dashboard`로 모든 세션 답변을 읽고, 지시를 주입하고, 권한 요청을 승인할 수 있다. `readBody`가 Content-Type을 보지 않아 `text/plain` POST(프리플라이트 없음)로 `/api/send`, `/api/webhooks`, `/api/telegram` 부작용도 가능하다.
- **터널/리버스 프록시**: 같은 머신의 ngrok·cloudflared·nginx로 허브를 노출하면 모든 요청이 루프백으로 보여 토큰이 무력화된다.
- 헤더 기반의 좁은 면제(Origin/Host/X-Forwarded-*)는 비브라우저 클라이언트가 헤더를 위조할 수 있어 프록시 뒤에서 뚫린다 → **면제 자체를 없앤다.**

추가 발견:
- 채널 소켓이 임의 `sessionId`로 `register`(라우팅 가로채기)·`reply`·`notify`·`status`·`permission_request`를 보낼 수 있다 (`peer_name`만 검사됨).
- WebSocket `maxPayload` 기본 100MiB, 이미지 크기 검사는 base64 디코딩 후.
- 대시보드 설정 화면 fetch는 `?token=`을 붙이지만 HTTP API는 Bearer만 확인 → 원격 설정 화면이 401 (기존 버그).
- CLI `hub status`/중복 실행 확인(`cli.ts:157`, `:277`)은 토큰 없이 `/api/status` 호출.
- 텔레그램 `callback_query`는 채팅 id를 확인하지 않는다 (일반 메시지는 `telegram.ts:174`에서 확인).

## 목표

로컬·원격 모두 **항상 토큰 기반 인증**을 요구하되, 사용자 체감 변화는 최소화한다.

비목표: 허브 자동 시작(별도 작업), `@mention` minor 항목, 다중 사용자/권한 분리.

## 설계

### 1. 인증 규칙

인증 불필요 경로는 두 개뿐:
- `GET /` — 대시보드 HTML (단, `?token=` 로그인 링크 처리는 아래)
- `POST /api/login`

그 외 모든 HTTP 경로와 두 WebSocket 경로는 아래 중 하나를 만족해야 한다.

| 수단 | 형식 | 사용처 |
|---|---|---|
| Bearer | `Authorization: Bearer <token>` | CLI |
| 쿼리 | `?token=<token>` — **WebSocket 업그레이드에만** 허용 | 채널 서버 (기존 방식, 구버전 호환) |
| 쿠키 | `ca_session=<HMAC>` | 대시보드 |

- 비교는 `crypto.timingSafeEqual` (길이 다르면 false).
- 허브에 토큰이 설정되지 않은 경우(`token` 없음)는 기존처럼 인증 없이 동작 — 단 `hub start`/데몬 경로는 `getOrCreateToken()`으로 항상 토큰을 보장한다.
- `isLocalRequest`는 인증에서 제거하고, 세션 locality(`isLocal`: 이미지 업로드, `@mention` 대상) 판정에만 남긴다.

### 2. 대시보드 쿠키

- 값: `HMAC-SHA256(key=hub token, msg="claude-alarm-dashboard")`의 hex. 서버 상태 없음 → 허브 재시작 후에도 유지, 토큰 변경 시 자동 무효.
- 속성: `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30일). 요청 헤더 `X-Forwarded-Proto: https`이면 `; Secure` 추가.
- `POST /api/login` `{ "token": "..." }` → 맞으면 `204` + `Set-Cookie`, 틀리면 `401`.
- `GET /?token=<token>` → 맞으면 `302 Location: /` + `Set-Cookie`, 틀리면 대시보드 HTML을 그대로 제공(쿠키 없음 → 로그인 폼이 뜸).

### 3. 브라우저 방어 (인증과 별개의 추가 층)

- **Origin 검사**: 요청에 `Origin`이 있고 그 host(`new URL(origin).host`)가 요청 `Host` 헤더와 다르면 거부 — HTTP는 `403`, WebSocket 업그레이드는 소켓 파기. `Origin`이 없는 요청(Node 클라이언트, 같은 출처 GET)은 이 검사를 건너뛴다.
- **POST Content-Type**: `POST` 요청의 `Content-Type`이 `application/json`으로 시작하지 않으면 `415`. `/api/login` 포함.
- **CORS 헤더 삭제**: `Access-Control-Allow-*` 설정과 `OPTIONS` 204 처리를 제거한다 (대시보드는 동일 출처).

처리 순서 (HTTP): Origin 검사 → POST Content-Type 검사 → 무인증 경로 분기 → 인증 → 라우팅.
처리 순서 (업그레이드): Origin 검사 → 인증 → 경로 분기.

### 4. 소켓 소유권

- 허브는 `WeakMap<WebSocket, string>`(socket → sessionId)을 유지한다.
- `register`:
  - 이 소켓이 이미 다른 id를 소유 중이면 거부.
  - 같은 id를 **OPEN 상태의 다른 소켓**이 소유 중이면 거부 (`logger.warn`).
  - 그 외(신규, 같은 소켓 재등록, 기존 소켓이 OPEN 아님)는 허용하고 소유 기록.
- `status` / `notify` / `reply` / `permission_request` / `peer_name`: `owner(ws) !== msg.sessionId`이면 무시. 기존 `peer_name`의 개별 검사는 이 공통 검사로 대체.

### 5. 크기 제한

- `new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })` — 채널·대시보드 모두.

### 6. 텔레그램 콜백

- `handleCallbackQuery`: `String(query.message?.chat.id) !== String(this.config.chatId)`이면 무시 (`sess:`·`perm:` 모두).

### 7. 대시보드

- 시작 시 `GET /api/status` → `401`이면 토큰 폼, 아니면 `connect()`.
- 토큰 폼 제출 → `POST /api/login` → `204`면 폼 닫고 `connect()`, 아니면 오류 표시.
- `sessionStorage` 토큰 저장, `state.token`, WebSocket/`fetch`의 `tokenQuery` 전부 제거.
- WebSocket이 `onopen` 전에 닫히면 `/api/status`로 인증 상태를 다시 확인해 `401`이면 폼 표시, 아니면 기존 재연결.
- 폼 안내 문구: "Run `claude-alarm token`, or open the login link printed by `claude-alarm hub start`."

### 8. CLI

- `/api/status` 호출(중복 실행 확인, `hub status`, `init`)에 `Authorization: Bearer <config.hub.token>` 추가.
- `hub start`(포그라운드·데몬) 출력: `Dashboard: http://<host>:<port>/?token=<token>` (로그인 링크). 기존 `Token:` 줄 유지.

### 9. README

- "Authentication" 소절: 모든 연결에 토큰 필요, 로그인 링크/토큰 폼, `claude-alarm token`.
- "Remote Access" 재작성: ① Tailscale 권장 ② Cloudflare Tunnel / nginx+HTTPS ③ `0.0.0.0` 직접 노출은 평문 — 신뢰 네트워크에서만.
- 업그레이드 노트: `CLAUDE_ALARM_HUB_TOKEN`으로 다른 토큰을 쓰던 로컬 세션은 허브 토큰과 일치시켜야 함.

## 호환성

| 조합 | 결과 |
|---|---|
| 새 허브 + 구 채널 서버(로컬) | 동작 — 구 채널도 config 토큰을 `?token=`으로 보냄 |
| 구 허브 + 새 채널 서버 | 동작 — 변경 없음 |
| 로컬 채널이 env로 다른 토큰 사용 | **끊김** — 허브 로그에 거부 사유, README 업그레이드 노트 |
| 기존 북마크 `/?token=` | 동작 — 로그인 링크로 처리 후 URL 정리 |
| 외부 스크립트가 토큰 없이 로컬 API 호출 | **401** — README에 API 예시 없음, 릴리스 노트에 명시 |

## 테스트

`test/hub-auth.test.ts` — 실제 `HubServer`를 테스트 포트에 띄우고 `ws`/`fetch`로 검증:

1. 토큰 없는 `/ws/dashboard`, `/ws/channel` 업그레이드 거부 (루프백에서)
2. 토큰 없는 `GET /api/sessions` 401, `POST /api/send` 401
3. `?token=` 채널 연결 성공, Bearer `GET /api/sessions` 200
4. `?token=`을 HTTP API에 붙이면 401 (WS 전용)
5. `POST /api/login` 올바른 토큰 → 204 + `Set-Cookie`(HttpOnly, SameSite=Strict); 그 쿠키로 `/ws/dashboard` 연결·`GET /api/webhooks` 200
6. 틀린 토큰 로그인 401, 위조 쿠키로 `GET /api/sessions` 401
7. `GET /?token=<ok>` → 302 + Set-Cookie; `GET /?token=<bad>` → 200 HTML, Set-Cookie 없음
8. `X-Forwarded-Proto: https` 로그인 → Set-Cookie에 `Secure`
9. 유효 쿠키 + `Origin: http://evil.com` → WS 거부, POST 403
10. 유효 Bearer + `Content-Type: text/plain` POST → 415
11. 다른 소켓의 같은 id `register` 거부(라우팅 유지), 남의 sessionId `reply` 무시
12. 16MB 초과 프레임 → 연결 종료

`test/telegram-callback.test.ts` — 다른 채팅의 `perm:` 콜백이 `onPermissionVerdict`를 호출하지 않음, 설정 채팅은 호출함.

기존 `test/hub-peer-name.test.ts`는 소유권 검사 통합 후에도 통과해야 한다.

수동: 임시 허브 + Chrome — 첫 접속 토큰 폼 → 로그인 → 새로고침 유지, 로그인 링크 → URL 정리, 설정 화면(웹훅/텔레그램) 로드.
