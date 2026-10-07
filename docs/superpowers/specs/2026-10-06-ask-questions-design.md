# 질문은 대화로: `ask` 도구와 Codex 질문 중계

날짜: 2026-10-06 · 상태: 사용자 승인(설계 1/2·2/2), Codex 검토 반영(2026-10-06), 사용자 스펙 검토 전

## 배경

대시보드에서 weekly-report 세션이 `waiting input`인데 대화 영역은 "No messages yet"이었다. 선택이 필요한 질문은 알림 패널에만 있었다.

- 그 세션은 질문을 `notify`로만 보내고 `status("waiting_input")`을 걸었다. `reply`는 부르지 않았다(세션 대화 기록 `~/.claude/projects/C--workspace-weekly-report/3f767225-…jsonl` 214~217행)
- 대시보드는 `reply_from_session`을 대화 영역과 알림 패널에 넣고(`src/dashboard/index.html:1459-1468`), `notification`은 알림 패널에만 넣는다(`index.html:1475-1478`)
- 채널 안내문과 notify 도구 설명이 "when user attention is needed"라고 해서 질문을 notify로 보내게 만들었다

안내문은 커밋 `f34b531`에서 고쳤다(질문은 `reply`로, notify는 답이 필요 없는 일에만, `test/channel-guidance.test.ts`). 이 문서는 그다음 단계다. 선택지가 있는 질문을 버튼으로 답하게 하고, Codex가 보내는 질문도 같은 화면으로 받는다.

## 결정 (사용자, 2026-10-06)

- 알림을 대화 영역에 끼워 넣는 안은 버린다. 문제는 선택이 필요한 질문을 알림으로만 보낸 것이다
- 범위 **B**: Claude `ask`와 Codex 질문 중계를 이번에 함께 한다
- 여러 질문·직접 입력은 **A**: 질문이 하나면 버튼 한 번에 보내고, 여럿이면 질문마다 고른 뒤 보낸다. 텔레그램도 질문마다 메시지를 보내 끝까지 답할 수 있게 한다
- 실측에서 안 나온 `item/tool/requestUserInput`은 **A**: 넘기지 않고 지금 알림을 유지하며 로그에 남긴다
- 설계 1/2(사용자에게 보이는 것)·2/2(구조·작업·시험) 승인. "일반 메시지를 보내면 질문이 닫힌다"도 포함
- 스펙은 Codex 검토를 받는다(Codex 쪽 처리가 있으므로). 검토와 반영은 Obsidian `Projects/claude_alarm/docs/tasks/2026-10-06-질문은-대화로-ask-도구-GPT검토.md`

## 확인한 사실 (`feat/ask-question` = main `4d26e8a` + `f34b531`)

### Codex 실측 (데몬 0.160.1, userAgent `…/0.160.1`)

시험 대화는 `C:\tmp\codex-ask-probe`. 연결 A는 initialize에 `capabilities.experimentalApi: true`를 주고 `turn/start`에 `collaborationMode: {mode: 'plan', settings}`를 줘 "request_user_input으로 질문 두 개"를 시켰다. 연결 B는 어댑터처럼 stable로 initialize하고 턴 시작 뒤 `thread/resume {excludeTurns: true}`로 구독했다.

1차(질문만 보고 답하지 않음):

- `item/tool/requestUserInput` 서버 요청은 오지 않았다. 대신 `agentMessage`가 왔다:
  `{type: "agentMessage", id: "call_…", text: "Which color do you prefer?\n- Red\n- Blue\n\nWhat name should I use?", phase: "final_answer", delivery: "async", questions: [{title: "Which color do you prefer?", options: ["Red","Blue"]}, {title: "What name should I use?", options: null}]}`
- 그 뒤 `sleep`(60초) 세 번, 약 200초 뒤 `turn/completed`. 이때 `items`(`itemsView: "summary"`)에 같은 id의 질문 메시지가 들어 있었다

2차(B가 답함):

- **B도 질문 메시지를 즉시 받았다**(`item/completed`, `delivery`·`questions` 그대로). 질문 뒤 3초에 `sleep` 시작
- 그동안 스레드 상태는 `{type: "active", activeFlags: []}` 한 번, 끝날 때 `idle` — **`waitingOnUserInput`은 서지 않았다**
- 질문 5초 뒤 B가 `turn/steer {expectedTurnId, input: [{type: "text", text: "[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe"}]}` → `{turnId}` 성공. **바로 `sleep` 항목이 끝나고** 그 글이 `userMessage`로 들어간 뒤, Codex가 "You prefer Blue, and the name to use is Probe."로 답하고 턴 끝(21초)
- 이번 `turn/completed.items`에는 마지막 답만 있고 질문 메시지는 **없었다**. 턴 끝 목록은 질문을 다시 찾는 완전한 자료가 아니다

스키마(데몬 바이너리 `codex.exe app-server generate-ts --experimental`): `AsyncUserInputQuestion = {title: string, options: string[] | null}`, `AgentMessageDelivery = "async"`, `ThreadItem`에 `sleep`(interruptible). 비동기 질문에 답하는 전용 API는 없다(Codex 검토도 같은 결론: `ClientRequest.ts`의 `thread/queue/*`·`thread/inject_items`·`turn/start.toolOutput`은 이 용도가 아니다). `requestUserInput`(서버 요청, EXPERIMENTAL)도 남아 있다. 새 대화는 첫 턴 전에 `thread/resume`이 `no rollout found`로 실패한다(`adapter.ts:545`)

### 지금 코드

- Codex 어댑터는 `agentMessage`에서 `text`·`phase`만 모았다가(`adapter.ts:464-470`) **턴이 끝날 때** `finalAnswer`로 골라 `reply`로 보낸다(`adapter.ts:472-499`, `src/codex/mapping.ts:52-56`). 모은 게 있으면 턴 끝 목록은 보지 않는다(`adapter.ts:495-497`)
- 어댑터가 받는 Hub 메시지: `message_to_session`·`image_to_session`·`permission_response`·`codex_close`(`adapter.ts:501-511`). 글은 대화별 줄(`enqueue`)을 거쳐 `deliver`로 간다(`adapter.ts:514-566`): 진행 중 턴이 있으면 `turn/steer` + `Queued` 알림, 없으면 `turn/start`. 맨 앞과 steer 직전에 `waitingForAnswer`(`adapter.ts:575-579`)면 거절하고, 실패는 `Not delivered` 알림으로만 알린다. `deliver`는 결과를 돌려주지 않는다
- 글에는 출처 머리표가 붙는다(`textInput` → `withSourcePrefix`, `src/codex/inputs.ts:9`, `mapping.ts:48-50`)
- `requestUserInput`·`permissions/requestApproval`·`elicitation`은 "Codex is waiting … Handle it in Codex." 알림만 보낸다(`adapter.ts:59`, `613-619`, `646-648`)
- Hub의 Codex 승인 선택지: `permission_request`에 `choices`가 있으면 `choiceRequests`에 넣고(`src/hub/server.ts:524-562`), 새 대시보드에 `permission_pending`(`server.ts:704-708`), 답은 `forwardPermissionResponse`(`server.ts:745-760`), 세션이 지워지면 `expireChoices`(`server.ts:259`, `418`, `768-772`). 텔레그램은 64바이트 제한 때문에 토큰 버튼을 쓴다(`src/hub/telegram.ts:460-496`, `508-521`). 화면 문구는 모두 "Permission Request"
- 채널 메시지는 소켓 주인 확인을 거친 뒤 처리된다(`server.ts:430-448`). 같은 sessionId로 다시 등록하면 옛 소켓을 끊고 새 소켓이 이어받으며, 옛 소켓의 close는 지금 소켓과 달라 세션을 지우지 않는다(`server.ts:410-426`, `441-445`). 진짜로 끊기면 세션을 지우고 `expireChoices`
- 일반 메시지가 세션으로 가는 길(Codex 검토로 더 없음 확인): 대시보드 글(`server.ts:714-723`), 대시보드 사진(`handleImageUpload`, `server.ts:783~`), 텔레그램 글·사진(`server.ts:855-876`), `/api/send`(`server.ts:345-364`)
- 텔레그램은 보낸 알림의 `message_id → sessionId`를 기억해 답장을 그 세션으로 바로 보낸다(`telegram.ts:100-114`, `239-250`)
- 채널 서버는 Hub가 끊겨 있으면 메시지를 100개까지 대기열에 넣고, 넘치면 버린다(`src/channel/hub-client.ts:78-86`). 결과를 돌려주지 않고 연결 여부를 볼 함수도 없다
- `notifier.notifyWithSession`은 `sessionId`·`sessionLabel`이 없으면 텔레그램으로 보내지 않는다(`src/hub/notifier.ts:36-38`)
- 대시보드는 세션별 마지막 5개 메시지를 localStorage에 두고(`index.html:1101-1131`), `sessions_list`에 없는 세션의 저장 메시지는 지운다(`pruneSessionData`). 30초마다 대화를 다시 그린다(`index.html:2629` 부근). 승인 복원은 `restorePendingRequests`(`index.html:2143-2155`), 제목 깜빡임은 `flashTitle`(`index.html:2241-2262`)

## 설계

### 1. 공용 질문 형식 — `src/shared/questions.ts` (새 파일), `src/shared/types.ts`

```ts
export interface QuestionOption { label: string; description?: string }
export interface Question {
  id: string;                       // 요청 안에서 유일, [A-Za-z0-9_-]{1,40}
  header?: string;                  // 짧은 머리표
  question: string;                 // 마크다운
  options: QuestionOption[] | null; // null이면 글로만 답한다
  allowOther: boolean;              // 선택지 밖 직접 입력. options가 null이면 항상 true
}
export interface QuestionRequest {
  sessionId: string;
  requestId: string;                // [A-Za-z0-9_:.-]{1,100} — 줄바꿈이 없어 permissionKey와 충돌하지 않는다
  context?: string;                 // 질문 위에 보일 설명(마크다운)
  questions: Question[];
  timestamp: number;
}
export type QuestionAnswers = Record<string, string>; // 질문 id → 답
export type QuestionState = 'answered' | 'closed' | 'expired';
```

`ChannelMessage`에 더한다:

| 메시지 | 방향 | 내용 |
|---|---|---|
| `question` | 세션 → Hub, Hub → 대시보드 | `QuestionRequest` 필드 |
| `questions_pending` | Hub → 새로 연결한 대시보드 | `{ requests: Array<QuestionRequest & { sending: boolean }> }` |
| `question_answer` | 대시보드 → Hub | `{ sessionId, requestId, answers }` |
| `question_answer` | Hub → 세션 | 위 + `questions`(질문 원문) + `source` |
| `question_delivery` | 세션 → Hub | `{ sessionId, requestId, ok: boolean, reason?: string }` |
| `question_sending` | Hub → 대시보드 | `{ sessionId, requestId, answers, source }` |
| `question_resolved` | Hub → 대시보드 | `{ sessionId, requestId, state, answers?, source? }` |
| `question_rejected` | Hub → 대시보드 | `{ sessionId, requestId, reason }` |

함수(모두 순수 함수):

- `normalizeQuestionRequest(raw): QuestionRequest | null` — 모양이 틀리면 `null`. 상한: 질문 1~10개, 질문 글 1~2000자(앞뒤 공백 뺀 뒤), 머리표 40자, 선택지 1~10개, 선택지 이름 1~200자·설명 500자, 설명(context) 20000자. 같은 질문 안 선택지 이름 중복, 질문 id 중복·형식 위반, `requestId` 형식 위반은 `null`. `timestamp`가 유한한 수가 아니면 지금 시각. `options`가 `null`이면 `allowOther = true`
- `checkAnswers(questions, answers): string | null` — 틀리면 이유. 모든 질문에 답이 있고(공백 뺀 뒤 1~5000자), 모르는 질문 id가 없고, `allowOther`가 아닌 질문은 선택지 이름 중 하나여야 한다
- `answerText(questions, answers): string` — 세션에 넣을 글. 2차 실측에서 Codex가 이 모양을 그대로 읽었다:

```
Answers to your questions:
- Which color do you prefer? → Blue
- What name should I use? → Probe
```

질문이 하나면 첫 줄은 `Answer to your question:`. 각 줄의 질문은 질문 글의 첫 줄을 120자까지(넘으면 `…`). 답은 자르지 않는다.

### 2. Hub — `src/hub/questions.ts` (새 파일), `src/hub/server.ts`

`QuestionBook`(열린 질문 장부): 항목은 `{request, sending?: {answers, source, dashboard?}}`. 열린 항목은 최대 500개(넘으면 가장 오래된 것을 `expired`로 닫는다). 최근에 닫힌 키 500개를 기억해 같은 `requestId`가 다시 와도 다시 열지 않는다. 키는 `permissionKey(sessionId, requestId)`.

- **받기**: `question`은 기존 소켓 주인 확인을 지난 뒤 `switch` 안에서 처리한다(주인 확인 앞에 두지 않는다). `normalizeQuestionRequest`가 `null`이면 경고 로그만. 이미 열려 있거나 최근에 닫힌 `requestId`면 무시. 받으면:
  - 장부에 넣고 모든 대시보드에 `question`
  - 텔레그램 `sendQuestion`(5절)
  - 데스크톱·웹훅: `notifier.notifyWithSession(undefined, undefined, '[세션] Question', 첫 질문 글(질문이 더 있으면 ` (+N more)`), 'warning')` — 텔레그램은 따로 보내므로 세션 정보를 넘기지 않는다
  - `sessions.updateActivity`
- **대시보드 연결**: `permission_pending` 다음에 `questions_pending`(보내는 중인 것은 `sending: true`)
- **답**: `answerQuestion(sessionId, requestId, answers, source, dashboard?): 'ok' | 이유`. 장부를 고르고 표시하는 사이에 `await`가 없어야 한다(먼저 온 답 하나만 이긴다)
  - 장부에 없으면 `the question is no longer open`, 보내는 중이면 `the question is already being answered`
  - `checkAnswers`가 이유를 주면 그 이유
  - 채널 소켓이 열려 있지 않으면 `the session is not connected`
  - 통과하면 항목을 **보내는 중**으로 표시하고, 세션에 `question_answer`(+`questions`, `source`), 대시보드에 `question_sending`
  - 대시보드에서 온 답이 위에서 실패하면 그 대시보드에만 `question_rejected`. 텔레그램은 반환값으로 안다
- **전달 결과**(`question_delivery`, 그 세션 소켓에서 온 것만):
  - `ok`: 장부에서 지우고 대시보드에 `question_resolved {state: 'answered', answers, source}`, 텔레그램 `resolveQuestion`
  - 실패: 다시 열고(보내는 중 표시를 지움) 모든 대시보드에 `question_rejected {reason}`, 텔레그램 `reopenQuestion(reason)`
  - 시간 제한은 두지 않는다. 세션은 모든 경로에서 결과를 보내고(3·4절), 세션이 끊기면 만료로 끝난다
- **"answered"의 뜻**: 세션이 받아들였다. Claude는 채널 알림을 Claude Code에 넘겼고, Codex는 `turn/steer`·`turn/start`가 성공했다. 모델이 읽었다는 뜻은 아니다
- **일반 메시지로 닫기**: 위 "일반 메시지가 가는 길" 다섯 곳에서 **Hub가 소켓으로 보낸 뒤** `closeQuestions(sessionId, 'closed')` — 그 세션의 열린 질문(보내는 중 제외)마다 `question_resolved {state: 'closed'}`와 텔레그램 `resolveQuestion`. 일반 메시지에는 받음 확인이 없다(안정화 2 결정). 그래서 Codex가 그 메시지를 거절해도(`Not delivered` 알림) 질문은 닫힌 채다
- **만료**: `expireChoices`를 부르는 두 곳(`server.ts:259`, `418`)에서 `closeQuestions(sessionId, 'expired')`(보내는 중 포함). 같은 sessionId로 소켓만 바뀌는 재연결에서는 질문을 유지한다(그 경로는 세션을 지우지 않는다)
- Hub가 다시 시작되면 장부는 비어 있다(승인 선택지와 같음)

### 3. Claude 세션 — `src/channel/server.ts`, `src/channel/hub-client.ts`

- `HubClient.send`가 `'sent' | 'queued' | 'dropped'`를 돌려준다(기존 호출부는 무시해도 된다)
- `ask` 도구:

```jsonc
{
  "context": "string, 선택. 질문 위에 보일 설명(마크다운)",
  "questions": [            // 1~4개
    {
      "header": "string, 선택, 40자까지",
      "question": "string",
      "options": [{ "label": "string", "description": "string, 선택" }], // 선택, 2~6개
      "allowOther": true    // 선택, 기본 true
    }
  ]
}
```

- 질문 id는 `q1`부터, `requestId`는 `randomUUID()`. `normalizeQuestionRequest`로 검사하고 틀리면 `isError`와 이유
- Hub에 `question`을 보내고 이어서 `status: waiting_input`. `question`이 `dropped`면 `isError`(`The hub is not connected and its queue is full, so the question was not sent. Ask in the terminal or with reply.`)
- 결과 글: `Question sent (id …). It shows in the dashboard conversation and on Telegram with buttons. Keep working on anything that does not depend on the answer; the answer arrives as a channel message starting with "Answer to your question" or "Answers to your questions".` `queued`면 끝에 `The hub is not connected right now, so the question is queued and shown once it reconnects. If the answer is urgent, also ask in the terminal.`
- Hub에서 `question_answer`가 오면 채널 알림 `notifications/claude/channel`: `content = answerText(questions, answers)`, `meta = { sender: source ?? 'dashboard', timestamp: String(Date.now()), questionId: requestId }`. 알림이 성공하면 `question_delivery {ok: true}`, 예외면 `{ok: false, reason}`

안내문 QUESTIONS 항목을 바꾼다:

> QUESTIONS: When the user can answer by picking from a few options, use ask: it shows the question with buttons in the dashboard conversation and on Telegram, and sets waiting_input for you. Its answer arrives later as a channel message starting with "Answer to your question" or "Answers to your questions". For an open question, send the whole question with reply (the context, what you need, your recommendation) and call status("waiting_input"). Never put a question only in notify: a notification is not part of the session's conversation, so the user has no place there to read the context and answer.

`reply`·`notify` 도구 설명의 "질문은 reply로"는 "질문은 ask 또는 reply로"로 맞춘다.

### 4. Codex 어댑터 — `src/codex/adapter.ts`, `src/codex/mapping.ts`

- `AgentMessage`에 `id`, `delivery?`, `questions?`를 더하고 `collect`가 버리지 않게 한다
- `asyncQuestions(item): {questions, context} | null`(mapping.ts): `questions`가 비어 있지 않은 배열이면 질문마다 `{id: q1…, question: title, options: options?.map((label) => ({label})) ?? null, allowOther: true}`. `context`는 `text`에서 질문 제목과 같은 줄, 선택지 목록 줄(`- X`, `* X`, `1. X`, `1) X`이고 X가 그 선택지 이름)을 뺀 나머지를 다듬은 것. 남는 게 없으면 생략(실측 글은 질문만 있어 두 번 보이지 않게). 결과가 `normalizeQuestionRequest`를 통과하지 못하면 `null`
- **대화별 기록**: `Tracked`에 `asked: Map<itemId, turnId>`. 질문의 `requestId`는 `codex-q:${itemId}`(같은 항목은 같은 id라 Hub가 중복을 거른다)
- **즉시 보내기**: `collect`에서 `asyncQuestions`가 통과하면 바로 `question`을 보내고 `asked`에 적는다. 통과하지 못하면 아무것도 안 하고, 그 메시지는 지금처럼 턴 끝 답장 후보로 남는다
- **턴 끝**: 모은 것과 턴 끝 목록을 id로 합친다(모은 것 순서 먼저, 없는 id만 뒤에). 질문이 붙었는데 `asked`에 없는 항목이 있으면(구독이 늦은 경우) 그때 보낸다. **`asked`에 있는 항목만** `finalAnswer`에서 뺀다. 남은 글이 없으면 `reply`를 보내지 않는다. 그 턴의 `asked` 항목을 지운다. 턴 끝 목록은 요약이라 질문이 없을 수 있다(2차 실측) — 이 보충은 "목록에 있으면 보낸다"까지다
- 대화가 빠지거나(`drop`) 데몬 연결이 끊기면(`onDaemonLost`) 그 대화의 `asked`도 지운다. 이미 보낸 질문은 Hub에 남아 있고, 어댑터 소켓이 끊기면 Hub가 만료시킨다
- **답 넣기**: Hub에서 `question_answer`가 오면 `enqueue`로 `deliver`에 넘긴다. 글은 `textInput(answerText(questions, answers), source)`. `deliver`에 결과 콜백을 더해, 답일 때만 모든 끝에서 `question_delivery`를 보낸다: steer·start 성공은 `ok`, `waitingForAnswer` 거절·대화 없음·데몬 없음·RPC 오류는 `ok: false`와 이유. 답일 때는 `Queued`·`Not delivered` 알림을 보내지 않는다(카드가 결과를 보여 준다)
- `waitingForAnswer`는 그대로 둔다. 2차 실측에서 질문 중 `waitingOnUserInput`이 서지 않았다. 나중에 서게 되면 답이 거절되고 카드가 이유와 함께 다시 열린다(조용히 사라지지 않는다)
- **`requestUserInput`**: 알림은 그대로 두고, 그 전에 구조만 로그로 남긴다 — `logger.warn('Codex requestUserInput not relayed: ' + JSON)`. JSON에는 질문마다 `id`, `header`, `question`(200자), 선택지 이름, `isOther`, `isSecret`, 그리고 `isBlocking`. 2000자에서 자른다

### 5. 텔레그램 — `src/hub/telegram.ts`

- `sendQuestion(sessionId, label, request)`
  - 질문이 하나: 메시지 하나 = `❓ <b>Question</b> — 세션` + 설명 + 질문 + 버튼(선택지마다 한 줄, `qa:<토큰>`) + 안내 한 줄(`allowOther`면 `Or reply to this message with your own answer.`, 선택지가 없으면 `Reply to this message with your answer.`)
  - 질문이 여럿: 첫 메시지 = `❓ <b>Questions (N)</b> — 세션` + 설명, 그 뒤 질문마다 `<b>i/N</b>` + 머리표·질문 + 버튼 + 안내
  - 보내는 메시지와 고치는 메시지 모두 기존 `visibleLength`·UTF-16 자르기로 상한을 지킨다. 화면에 다시 보이는 답은 300자까지(세션에 가는 답은 자르지 않는다). 버튼 토스트는 짧은 고정 문구(`Selected`, `Sending…`, `Expired`)
  - 질문 메시지 id도 `messageSessionMap`에 넣는다. 닫힌 질문에 대한 답장은 지금처럼 그 세션에 일반 메시지로 간다
- 상태: 요청별 `{sessionId, requestId, questions, answers, messages: {qid → {id, html, keyboard}}, contextMessageId?, state: 'open' | 'sending' | 끝 상태}`, 토큰 → `{key, qid, label}`, 질문 메시지 id → `{key, qid}`. 요청은 최대 100개(넘으면 오래된 것부터 지우고 토큰·답장 표도 지운다. 그 버튼을 누르면 `Expired`)
- **답장 순서**: `handleIncomingMessage`에서 질문 메시지에 대한 글 답장을 `messageSessionMap`보다 **먼저** 본다. 그 요청이 열려 있고 그 질문이 `allowOther`면 그 질문의 답으로 적는다(이미 답했어도 덮어쓴다). 사진 답장, 열려 있지 않은 요청, 직접 입력이 안 되는 질문은 지금 길로 간다
- 버튼: 그 질문의 답으로 적는다(다시 누르면 바꾼다). 메시지는 `Selected: 답`을 붙이고 버튼은 남긴다
- 모든 질문에 답이 모이면 `checkAnswers`로 먼저 확인하고, 요청을 `sending`으로 두고 `onQuestionAnswer(sessionId, requestId, answers)`(Hub `answerQuestion`, 출처 `telegram`). 결과가 `ok`가 아니면 `Not delivered: 이유`를 보내고 요청을 `open`으로 되돌린다(모은 답은 둔다). 메시지의 최종 모양은 Hub가 부르는 `resolveQuestion`·`reopenQuestion`이 정한다
- `resolveQuestion(sessionId, requestId, state, answers?, source?)`: 모든 질문 메시지를 결과로 덮어쓰고 버튼을 없앤다 — answered는 `✅ 답`(다른 곳에서 답했으면 `✅ 답 (Dashboard)`), closed는 `Closed — a message was sent instead`, expired는 `⌛ Expired`. 토큰과 답장 표를 지운다. 메시지를 아직 보내는 중이면 보낸 직후에 고친다(`sendChoiceRequest`의 `outcome`과 같은 방식)
- `reopenQuestion(sessionId, requestId, reason)`: 모아 둔 답을 지우고 질문 메시지를 처음 모양(버튼 포함)으로 되돌린 뒤 `Not delivered: 이유`를 보낸다

### 6. 대시보드 — `src/dashboard/index.html`

- 대화 메시지에 질문 종류를 더한다: `{from: 'session', kind: 'question', requestId, context, questions, state: 'open' | 'sending' | 'answered' | 'closed' | 'expired' | 'gone', answers, source, error, time}`. localStorage 저장은 지금 규칙(세션별 마지막 5개) 그대로
- `question`: 같은 `requestId`가 없을 때만 더한다. 그 세션의 `waitingReply`를 끈다(`reply_from_session`과 같음). 알림 패널에 `Question` 줄(warning, 첫 질문 글), 제목 깜빡임, 선택 안 된 세션이면 읽지 않음 수
- `questions_pending`: 없는 질문은 더하고(알림 줄과 깜빡임은 새로 더한 게 있을 때 한 번만, 복원 승인과 같은 방식), 있는 질문은 `sending` 값대로 잠그거나 푼다(초안은 둔다). 이 대시보드에 열린 채로 저장돼 있는데 목록에 없으면 `gone`(`No longer open`)
- `question_sending`: 카드를 잠그고 보내는 답을 보인다(다른 대시보드·텔레그램에서 보낸 경우 포함)
- `question_resolved`: 상태·답·출처를 바꾸고 저장
- `question_rejected`: 카드를 다시 열고 카드 안에 이유를 보인다. 그 세션이 선택돼 있으면 입력창 아래 빨간 줄 `Answer not delivered: 이유`(기존 `showNotDelivered`)도
- 카드: 설명(마크다운) → 질문마다 머리표·질문(마크다운)·선택지 버튼(설명은 아래 작은 글씨)·직접 입력 칸(`allowOther`)
  - 질문이 하나: 버튼을 누르면 바로 보낸다. 직접 입력은 Enter로 보낸다
  - 질문이 여럿: 질문마다 고르거나 입력한다. 버튼을 고르면 그 질문의 입력은 지우고, 입력하면 고른 버튼을 푼다. 모두 채우면 `Send`가 켜진다
  - 보내면 `sending`으로 잠근다. 결과(`question_resolved`·`question_rejected`)나 `questions_pending`이 올 때까지
  - 닫힌 카드: 질문마다 `→ 답`, 상태 줄 `Answered · Dashboard`/`Answered · Telegram`/`Closed — a message was sent instead`/`Expired — the session ended`/`No longer open`
- 고른 것·입력 중인 글은 `state.questionDrafts`에 둔다. 다시 그릴 때 값, 커서, 선택 범위를 살린다. 30초마다 다시 그리는 타이머는 카드 입력 칸에 커서가 있거나 한글 조합 중(`compositionstart`~`compositionend`)이면 건너뛴다
- Hub가 다시 시작돼 `sessions_list`가 비어 오면 `pruneSessionData`가 그 세션의 저장 메시지(질문 카드 포함)를 지운다. 이 한계는 그대로 둔다(Hub 재시작 뒤 질문은 어차피 사라진다)

### 7. 실제 확인

- 격리 HOME(`test/isolate-home.ts`와 같은 방식)으로 Hub를 띄운다. 실제 텔레그램 봇은 쓰지 않는다
- Claude 쪽: 채널 서버를 MCP 클라이언트로 띄워 `ask`를 부르고, Chrome에서 카드에 답해 채널 알림과 `Answered`가 오는지 본다
- Codex 쪽: 격리 Hub에 붙은 어댑터가 실제 Codex 데몬을 보게 하고, 시험 스크립트로 Plan 모드 질문을 시킨다. 카드가 바로 뜨는지, 카드에서 답하면 Codex가 자는 중에 받아 이어서 답하는지, 턴 끝에 질문 글이 다시 오지 않는지, 마지막 답만 `reply`로 오는지 본다
- 실제 텔레그램 화면은 배포 뒤 사용자가 확인한다

## 오류와 경계

- 세션이 보낸 질문이 형식에 안 맞으면 Hub는 버리고 경고 로그(채널 서버가 먼저 검사하므로 정상 경로에선 없음)
- 대시보드 두 개·텔레그램이 동시에 답하면 Hub에서 먼저 도착한 하나만 보내는 중이 된다. 나머지는 `the question is already being answered` 또는 `the question is no longer open`
- 터미널이나 Codex 창에서 답한 것은 알 수 없어 질문이 열린 채로 남는다. 나중에 답이 가면 세션이 상황을 보고 처리한다
- Codex 턴이 실패·중단돼도 질문은 열어 둔다. 그 뒤의 답은 새 턴으로 들어간다
- Codex 질문 형식은 EXPERIMENTAL이다. 형식이 바뀌어 `asyncQuestions`가 `null`을 주면 지금처럼 턴 끝 답장으로 간다. 질문 필드가 아예 다른 항목 종류로 옮겨 가면 이 대비는 듣지 않는다

## 시험

- 단위: `normalizeQuestionRequest`(상한, id·requestId 형식, 중복)·`checkAnswers`·`answerText`, `QuestionBook`(상한, 최근 닫힌 키, 보내는 중), `asyncQuestions`(context 다듬기 포함), `HubClient.send` 결과(99/100/101번째)
- Hub 통합(`hub-permission-choices.test.ts` 방식): 질문 → 대시보드 방송·데스크톱 알림 요청, 새 대시보드의 `questions_pending`(보내는 중 포함), 답 → 세션의 `question_answer`(+질문 원문·출처)와 대시보드 `question_sending`, `question_delivery` ok → `question_resolved`, 실패 → `question_rejected`로 다시 열림, 동시 답, 잘못된 답·닫힌 질문·끊긴 세션의 거절, 일반 메시지 다섯 길에서 닫기(보내는 중은 안 닫힘), 세션 삭제·끊김에서 만료, 같은 sessionId 소켓 교체에서는 유지, 남의 소켓이 보낸 `question`·`question_delivery` 무시, 형식 틀린 질문 무시, 같은 requestId 재전송 무시
- 채널(`channel-guidance.test.ts` 방식 + 가짜 Hub): `ask` → Hub가 `question`과 `waiting_input`을 받음, 잘못된 입력은 `isError`, Hub가 없을 때 결과 글, Hub의 `question_answer` → 채널 알림 내용·meta와 `question_delivery ok`, 안내문 QUESTIONS 문구
- Codex(가짜 데몬): 질문 붙은 `item/completed` → 즉시 `question`(requestId `codex-q:…`), 턴 끝 중복 없음, 놓친 항목은 턴 끝 목록에 있을 때 한 번, 형식이 틀린 질문은 지금처럼 답장, 질문만 있던 턴은 `reply` 없음, `question_answer` → `turn/steer`(진행 중)·`turn/start`(끝남)의 글과 `question_delivery ok`, 승인 대기 중이면 `question_delivery {ok: false}`이고 `Not delivered` 알림 없음, `requestUserInput` → 알림과 구조 로그
- 텔레그램(`fetch` 가짜): 하나·여럿 메시지와 버튼, 부분 선택(`Selected`, 다시 고르기), 답장이 일반 라우팅보다 먼저, 모두 모이면 `onQuestionAnswer`, 실패 시 `Not delivered`, `resolveQuestion` 세 상태가 모든 메시지를 덮어씀, `reopenQuestion`, 보내는 중 해결, 긴 답의 화면 자르기, 상한 정리
- 대시보드(vm): 질문 추가·중복 무시·`waitingReply` 끔, 복원(더하기·잠금 풀기·`gone`), `question_sending`, 결과 반영, 거절로 다시 열림, 하나/여럿 보내기 규칙, 초안 유지, 30초 다시 그리기 건너뛰기

## 이번에 안 하는 것

여러 개 고르기, 비밀 입력, 보낸 질문 고치기·취소, Hub 재시작 뒤 질문 보존, `requestUserInput`·`permissions/requestApproval`·`elicitation` 중계, 터미널·Codex 창에서 답한 것 알아채기, 일반 메시지의 받음 확인, steer 직전 턴이 끝나는 경합의 자동 재시도(틈이 아주 짧고, 실패하면 카드가 이유와 함께 다시 열려 다시 누르면 `turn/start`로 간다)
