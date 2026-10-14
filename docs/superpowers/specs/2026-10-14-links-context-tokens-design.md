# 링크 후처리와 세션 토큰 표시

날짜: 2026-10-14 · 상태: 사용자 승인(대화 설계), 사용자 스펙 검토 전

## 배경

- 세션이 `reply`로 보낸 `[제목](http://192.168.0.8:37290/?note=%EC%9D%B4…)`가 대시보드에 원문 그대로 보인다. 퍼센트 인코딩된 긴 주소가 두 줄을 차지한다(사용자 스크린샷, 2026-10-14)
  - 대시보드 `renderMarkdown`(`src/dashboard/index.html:2014`)과 텔레그램 `mdToHtml`(`src/hub/telegram.ts`) 모두 링크 규칙이 없다
- 대시보드에서 세션의 토큰 사용량(컨텍스트 크기)을 볼 수 없다. `src/`에 사용량 관련 코드가 없다

## 결정 (사용자, 2026-10-14)

- 링크 후처리: **대시보드 + 텔레그램**
- 토큰 표시: **대시보드만**(세션 카드). 텔레그램은 그대로
- 토큰은 채널 서버가 세션의 대화 기록을 읽어 Hub로 보낸다(Hub가 직접 읽기·상태 표시줄 훅 방식은 쓰지 않음)

## 확인한 사실 (main `fec3dfa`, Claude Code 2.1.296)

- 채널 서버 환경에 `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`이 있다(`src/channel/peer-name.ts:35-38`)
- `~/.claude/sessions/<pid>.json`(비공개 형식) 기록에 `sessionId`, `cwd`, `messagingSocketPath`가 있다. 이번 세션 기록에서 확인
- 대화 기록 `~/.claude/projects/C--workspace-claude-alarm/<sessionId>.jsonl`의 assistant 줄 `message.usage`에 `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`가 있다. 이번 세션 마지막 응답의 합은 132,854였다
- 같은 계산을 `@delt/claude-jev-advisor`의 `contextSize`(`claude-jev-advisor/src/context/transcript.ts:44-55`)가 쓴다: 뒤에서부터 보며 `compact_boundary`면 0, 하위 에이전트(`isSidechain`)·`<synthetic>` 응답은 건너뜀
- 피어 이름이 같은 흐름을 이미 쓴다: 채널이 30초마다 확인(`src/channel/server.ts:240-248`) → `peer_name` → Hub `setPeerName` → `session_updated`(`src/hub/server.ts:491-498`)
- Hub 기능 협상: Hub는 연결마다 `hub_info { features: HUB_FEATURES }`를 보낸다(`src/shared/constants.ts:19`, 지금 `['questions']`). 채널은 `hubClient.supports(feature)`로 확인한다

## 1. 링크 후처리

### 규칙 (대시보드·텔레그램 공통)

1. `[제목](주소)`: 주소가 `http://` 또는 `https://`로 시작하면 제목만 보이는 링크로 바꾼다
2. 그냥 적힌 `http(s)://…` 주소: 링크로 바꾸고, 보이는 글자는 `decodeURI`로 푼 값. 풀다 오류가 나면 원문
   - 주소 끝의 `.`, `,`, `)`, `]` 같은 문장 부호는 주소에 넣지 않는다(괄호는 주소 안에 여는 괄호가 있을 때만 포함)
3. 다른 스킴(`javascript:`, `data:` 등)의 `[제목](주소)`는 바꾸지 않고 글자 그대로 둔다
4. 코드 블록(```` ``` ````)과 인라인 코드(`` ` ``) 안은 바꾸지 않는다
5. 제목 안의 `**`·`*` 꾸밈은 지금 규칙대로 적용된다

### 대시보드

- `renderMarkdown`이 코드를 자리 표시자로 먼저 빼 두고(텔레그램 `mdToHtml`과 같은 방식), 마지막에 되돌린다. 링크 규칙도 이 자리 표시자 방식으로 굵게·기울임 규칙보다 먼저 처리해, 주소 안의 `*`·`_`가 꾸밈으로 바뀌지 않게 한다
- 출력: `<a href="…" target="_blank" rel="noopener noreferrer">제목</a>`. `href`와 제목은 HTML 이스케이프
- 링크 스타일 한 줄(색, 밑줄) 추가

### 텔레그램

- `mdToHtml`에서 같은 규칙으로 `<a href="…">제목</a>`(Telegram HTML이 지원). `href` 안의 `"`·`&`·`<`·`>`는 이스케이프
- 그냥 적힌 주소는 Telegram이 이미 자동으로 링크로 만들지만, 보이는 글자를 풀어 주기 위해 같은 규칙을 적용한다
- 메시지 길이 맞춤(`fit`)은 HTML 길이 기준이라 `href`가 길이에 들어간다. 지금 동작 그대로 둔다

### 위치

- 변환 규칙은 순수 함수로 뺀다
  - 텔레그램: `src/hub/telegram.ts`의 `mdToHtml` 안에서 쓰는 함수를 `src/shared/links.ts`로(시험 가능)
  - 대시보드는 빌드 없는 단일 HTML이라 같은 규칙을 `index.html` 안에 둔다. 시험은 기존 대시보드 시험 방식(`test/dashboard-*.test.ts`)을 따른다

## 2. 세션 토큰 표시

### 채널 서버: 계산 (`src/channel/context-tokens.ts` 새 파일)

1. `<configDir>/sessions/*.json`에서 `messagingSocketPath`가 `CLAUDE_CODE_MESSAGING_SOCKET`과 같은 기록을 찾는다. 없으면 `sessionId`가 `CLAUDE_CODE_SESSION_ID`와 같은 기록. 기록의 `sessionId`·`cwd`를 쓴다(`/clear`로 `sessionId`가 바뀌어도 따라간다)
   - `configDir`은 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`(`peer-name.ts`와 같음). 기록 읽기는 `peer-name.ts`와 함께 쓰도록 정리한다
   - 기록이 없으면 `CLAUDE_CODE_SESSION_ID`와 `process.cwd()`를 쓴다
2. 대화 기록 경로: `<configDir>/projects/<cwd의 영숫자가 아닌 문자를 모두 '-'로>/<sessionId>.jsonl`. 없으면 `<configDir>/projects/*/<sessionId>.jsonl`을 찾는다
3. 파일 끝 1MB를 읽어 줄 단위로 파싱(첫 줄은 잘렸을 수 있어 버린다), `contextSize`와 같은 규칙으로 계산
   - 끝 1MB에 assistant 응답이 없으면 값 없음(`null`)
4. 어느 단계든 실패하면 `null`. 예외를 밖으로 내지 않는다

### 채널 서버: 전송

- `ChannelMessage`에 `{ type: 'context_tokens'; sessionId: string; tokens: number | null }` 추가
- 피어 이름과 같은 시점(시작 2초 뒤, 그 뒤 30초마다)에 계산한다
- Hub가 `context_tokens` 기능을 알릴 때(`hubClient.supports('context_tokens')`)만 보낸다. 옛 Hub에는 보내지 않는다
- 마지막으로 보낸 값과 같으면 보내지 않는다. Hub에 새로 연결되면(`hub_info`를 받으면) 마지막 값을 지워 다음 확인 때 다시 보낸다

### Hub

- `HUB_FEATURES`에 `'context_tokens'` 추가
- `SessionInfo`에 `contextTokens?: number` 추가. `SessionManager.setContextTokens(sessionId, tokens)`: 0 이상의 유한한 정수만 저장, 그 밖(`null` 포함)은 지운다
- `case 'context_tokens'`: 저장 뒤 `session_updated`를 대시보드에 보낸다. 다른 세션 id로 온 메시지는 `sessionId`가 있는 모든 메시지에 걸리는 기존 소유권 검사(`src/hub/server.ts:462`)가 막는다

### 대시보드

- 세션 카드의 폴더·시간 줄 끝에 ` · 132k`. 1,000 미만은 그대로(`850`), 1,000 이상은 `k`(반올림, `132k`), 1,000,000 이상은 `1.2M`
- `contextTokens`가 없거나 0이면 표시하지 않는다(Codex 세션, 읽기 실패, compact 직후)
- `title`에 정확한 값(`Context: 132,854 tokens`)

### 비공개 형식 의존

- 세션 기록과 대화 기록 모두 Claude Code가 공개하지 않은 형식이다. 바뀌면 값이 사라질 뿐 오류는 나지 않는다
- 새 파일 머리에 이 의존을 주석으로 남기고, 메모리 `project_peer_registry.md`에 대화 기록 의존을 더한다

## 시험

- 링크(공통 함수): 제목 링크, 그냥 주소와 끝 문장 부호, 인코딩된 한글 표시, 풀 수 없는 인코딩, `javascript:` 그대로, 코드 안 주소 그대로, 주소 안 `*`·`_`가 꾸밈이 되지 않음, `"`·`&` 이스케이프
- 텔레그램: `mdToHtml` 결과에 `<a href>`가 들어가고 기존 굵게·코드 결과는 그대로
- 대시보드: `renderMarkdown` 같은 사례(기존 대시보드 시험 방식)
- 토큰 계산: 임시 configDir에 가짜 세션 기록·대화 기록. 소켓 매칭·`sessionId` 대체·cwd 경로·`projects/*` 대체 탐색·`compact_boundary` 0·하위 에이전트와 `<synthetic>` 건너뜀·파일 없음 `null`·깨진 줄 무시
- Hub: `context_tokens` → `session_updated`에 `contextTokens`, `null`이면 지움, 음수·문자열 거절, `hub_info`에 `context_tokens`
- 채널 전송: 기능 없는 Hub에는 보내지 않음, 같은 값 다시 보내지 않음, 재연결 뒤 다시 보냄
- 실측: HOME 격리 Hub(메모리 `feedback_isolate_hub_runs.md`)에 실제 세션 하나를 붙여 대시보드 카드에 숫자가 뜨는지, 링크가 눌리는지 확인

## 범위 밖

- 텔레그램 토큰 표시, 최대치(자동 compact 기준) 표시와 색 경고
- Codex 세션 토큰
- 마크다운 렌더러 교체(라이브러리 도입)
