# 질문은 대화로: `ask` 도구와 Codex 질문 중계

날짜: 2026-10-06 · 상태: 사용자 승인(설계 1/2·2/2, 2026-10-06), Codex 검토 전

## 배경

대시보드에서 weekly-report 세션이 `waiting input`인데 대화 영역은 "No messages yet"이었다. 선택이 필요한 질문은 알림 패널에만 있었다.

- 그 세션은 질문을 `notify`로만 보내고 `status("waiting_input")`을 걸었다. `reply`는 부르지 않았다(세션 대화 기록 214~217행)
- 대시보드는 `reply_from_session`을 대화 영역과 알림 패널에 넣고(`src/dashboard/index.html:1459-1468`), `notification`은 알림 패널에만 넣는다(`index.html:1475-1478`)
- 채널 안내문과 notify 도구 설명이 "when user attention is needed"라고 해서 질문을 notify로 보내게 만들었다

안내문은 커밋 `f34b531`에서 고쳤다(질문은 `reply`로, notify는 답이 필요 없는 일에만, `test/channel-guidance.test.ts`). 이 문서는 그다음 단계다. 선택지가 있는 질문을 버튼으로 답하게 하고, Codex가 보내는 질문도 같은 화면으로 받는다.

## 결정 (사용자, 2026-10-06)

- 알림을 대화 영역에 끼워 넣는 안은 버린다. 문제는 선택이 필요한 질문을 알림으로만 보낸 것이다
- 범위 **B**: Claude `ask`와 Codex 질문 중계를 이번에 함께 한다
- 여러 질문·직접 입력은 **A**: 질문이 하나면 버튼 한 번에 보내고, 여럿이면 질문마다 고른 뒤 보낸다. 텔레그램도 질문마다 메시지를 보내 끝까지 답할 수 있게 한다
- 실측에서 안 나온 `item/tool/requestUserInput`은 **A**: 넘기지 않고 지금 알림을 유지하며 내용을 로그에 남긴다
- 설계 1/2(사용자에게 보이는 것)·2/2(구조·작업·시험) 승인. "일반 메시지를 보내면 질문이 닫힌다"도 포함
- 스펙은 Codex 검토를 받는다(Codex 쪽 처리가 있으므로)

## 확인한 사실 (`feat/ask-question` = main `4d26e8a` + `f34b531`)

### Codex 실측 (데몬 0.160.1, CLI 0.159.3)

- 시험 대화(`C:\tmp\codex-ask-probe`)를 Plan 모드(`turn/start`의 `collaborationMode: {mode: 'plan', settings}`, initialize에 `capabilities.experimentalApi: true`)로 열고 "request_user_input으로 질문 두 개"를 시켰다. 어댑터처럼 stable로 붙은 두 번째 연결로 지켜봤다
- `item/tool/requestUserInput` 서버 요청은 오지 않았다. 대신 `item/completed`로 이런 `agentMessage`가 왔다:
  `{type: "agentMessage", id: "call_…", text: "Which color do you prefer?\n- Red\n- Blue\n\nWhat name should I use?", phase: "final_answer", delivery: "async", questions: [{title: "Which color do you prefer?", options: ["Red","Blue"]}, {title: "What name should I use?", options: null}]}`
- 그 뒤 `sleep` 항목(60초)이 세 번 오고, 답이 없자 약 200초 뒤 `turn/completed`. `turn/completed`의 `items`에도 같은 `agentMessage`(questions 포함)가 들어 있었다
- 0.160.1 스키마(`codex.exe app-server generate-ts --experimental`, 데몬 바이너리): `AsyncUserInputQuestion = {title: string, options: string[] | null}`, `AgentMessageDelivery = "async"`, `ThreadItem`에 `{type: "sleep"}`. `requestUserInput`(`ToolRequestUserInputParams {threadId, turnId, itemId, questions[{id, header, question, isOther, isSecret, options[{label, description}] | null}], isBlocking}`, 응답 `{answers: {id: {answers: string[]}}}`)도 남아 있고 EXPERIMENTAL 표시. 기능 `sleep_tool` stable true, `default_mode_request_user_input`·`send_message_to_user_async` under development false
- 새 대화는 첫 턴 전에 `thread/resume`이 `no rollout found`로 실패한다(어댑터 주석 `adapter.ts:545`와 같음)

### 지금 코드

- Codex 어댑터는 `agentMessage`를 모았다가(`adapter.ts:464-470` `collect`) **턴이 끝날 때** `finalAnswer`로 골라 `reply`로 보낸다(`adapter.ts:472-499`, `src/codex/mapping.ts:52-56`). 그래서 Codex가 질문하고 자는 동안 대시보드에는 아무것도 없고, 턴이 끝나야 버튼 없는 글로 보인다
- 어댑터가 받는 Hub 메시지: `message_to_session`·`image_to_session`·`permission_response`·`codex_close`(`adapter.ts:501-511`). 글은 대화별 줄(`enqueue`)을 거쳐 `deliver`로 간다(`adapter.ts:514-566`): 진행 중 턴이 있으면 `turn/steer`, 없으면 `turn/start`. 맨 앞과 steer 직전에 `waitingForAnswer`(`adapter.ts:575-579`: 상태가 `waiting_input`이거나 답 안 한 승인이 있음)면 거절한다. 상태는 `activeFlags`에 `waitingOnApproval`·`waitingOnUserInput`이 있으면 `waiting_input`(`mapping.ts:43-46`)
- 글에는 출처 머리표가 붙는다(`textInput` → `withSourcePrefix`, `src/codex/inputs.ts:9`, `mapping.ts:48-50`)
- `requestUserInput`·`permissions/requestApproval`·`elicitation`은 "Codex is waiting … Handle it in Codex." 알림만 보낸다(`adapter.ts:59`, `613-619`, `646-648`)
- Hub의 Codex 승인 선택지: `permission_request`에 `choices`가 있으면 `choiceRequests`에 넣고(`src/hub/server.ts:524-562`), 새 대시보드에 `permission_pending`으로 다시 보내고(`server.ts:704-708`), 답은 `forwardPermissionResponse`(`server.ts:745-760`), 세션이 지워지면 `expireChoices`(`server.ts:259`, `418`, `768-772`). 텔레그램은 64바이트 제한 때문에 토큰 버튼을 쓰고(`src/hub/telegram.ts:460-496`), 고른 뒤 메시지를 고친다(`telegram.ts:508-521`). 화면 문구는 모두 "Permission Request"
- 일반 메시지가 세션으로 가는 길: 대시보드 글(`server.ts:714-723`), 대시보드 사진(`server.ts:783~` `handleImageUpload`), 텔레그램 글·사진(`server.ts:855-876`), `/api/send`(`server.ts:345-364`)
- 텔레그램은 보낸 알림의 `message_id → sessionId`를 기억해 답장을 그 세션으로 보낸다(`telegram.ts:100-114`, `239-250`)
- 채널 서버는 Hub가 끊겨 있으면 메시지를 100개까지 대기열에 넣고 다시 붙을 때 보낸다(`src/channel/hub-client.ts:78-86`). 연결 여부를 밖에서 볼 수 있는 함수는 없다
- `notifier.notifyWithSession`은 `sessionId`가 없으면 텔레그램으로 보내지 않는다(`src/hub/notifier.ts:36-38`)
- 대시보드는 세션별 마지막 5개 메시지를 localStorage에 둔다(`index.html:1101-1131`). 제목 깜빡임은 `flashTitle`(`index.html:2241~`)

## 설계

### 1. 공용 질문 형식 — `src/shared/questions.ts` (새 파일), `src/shared/types.ts`

```ts
export interface QuestionOption { label: string; description?: string }
export interface Question {
  id: string;                       // 요청 안에서 q1, q2, …
  header?: string;                  // 짧은 머리표
  question: string;                 // 마크다운
  options: QuestionOption[] | null; // null이면 글로만 답한다
  allowOther: boolean;              // 선택지 밖 직접 입력. options가 null이면 항상 true
}
export interface QuestionRequest {
  sessionId: string;
  requestId: string;
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
| `questions_pending` | Hub → 새로 연결한 대시보드 | `{ requests: QuestionRequest[] }` |
| `question_answer` | 대시보드 → Hub | `{ sessionId, requestId, answers }` |
| `question_answer` | Hub → 세션 | 위 + `questions`(질문 원문) + `source` |
| `question_resolved` | Hub → 대시보드 | `{ sessionId, requestId, state, answers?, source? }` |
| `question_rejected` | Hub → 답을 보낸 대시보드 | `{ sessionId, requestId, reason }` |

함수(모두 순수 함수):

- `normalizeQuestionRequest(raw): QuestionRequest | null` — 모양이 틀리면 `null`. 상한: 질문 1~10개, 질문 글 1~2000자(앞뒤 공백 뺀 뒤 비어 있으면 안 됨), 머리표 40자, 선택지 1~10개, 선택지 이름 1~200자·설명 500자, 설명(context) 20000자, `requestId` 1~100자. 같은 질문 안에서 선택지 이름이 겹치면 안 된다. `options`가 `null`이면 `allowOther = true`
- `checkAnswers(questions, answers): string | null` — 틀리면 이유. 모든 질문에 답이 있고(공백 뺀 뒤 1~5000자), 모르는 질문 id가 없고, `allowOther`가 아닌 질문은 선택지 이름 중 하나여야 한다
- `answerText(questions, answers): string` — 세션에 넣을 글:

```
Answer to your question:
- Which color do you prefer? → Blue
```

질문이 둘 이상이면 첫 줄은 `Answers to your questions:`. 각 줄의 질문은 질문 글의 첫 줄을 120자까지(넘으면 `…`).

### 2. Hub — `src/hub/questions.ts` (새 파일), `src/hub/server.ts`

`QuestionBook`(열린 질문 장부, 키는 `permissionKey(sessionId, requestId)`와 같은 방식): `add`, `get`, `take`(꺼내며 지움), `forSession`, `all`.

- **받기**: 채널 소켓에서 `question`(소켓 주인 확인은 기존 그대로 `server.ts:446-448`). `normalizeQuestionRequest`가 `null`이면 경고 로그만. 받으면:
  - 장부에 넣고 모든 대시보드에 `question`
  - 텔레그램 `sendQuestion`(5절)
  - 데스크톱·웹훅: `notifier.notifyWithSession(undefined, undefined, '[세션] Question', 첫 질문 글(질문이 더 있으면 ` (+N more)`), 'warning')` — 텔레그램은 따로 보내므로 세션 id를 넘기지 않는다
  - `sessions.updateActivity`
- **대시보드 연결**: `permission_pending` 다음에 `questions_pending`
- **답**: `answerQuestion(sessionId, requestId, answers, source): 'ok' | 이유`
  - 장부에 없으면 `the question is no longer open`
  - `checkAnswers`가 이유를 주면 그 이유
  - 채널 소켓이 열려 있지 않으면 `the session is not connected`
  - 성공: 장부에서 꺼내고, 세션에 `question_answer`(+`questions`, `source`), 대시보드에 `question_resolved {state: 'answered', answers, source}`, 텔레그램 `resolveQuestion`
  - 대시보드에서 온 답이 실패하면 보낸 대시보드에만 `question_rejected`
- **일반 메시지로 닫기**: 위 "일반 메시지가 가는 길" 다섯 곳에서 **전달에 성공한 뒤** `closeQuestions(sessionId, 'closed')` — 그 세션의 열린 질문마다 `question_resolved {state: 'closed'}`와 텔레그램 `resolveQuestion`
- **만료**: `expireChoices`를 부르는 두 곳(`server.ts:259`, `418`)에서 `closeQuestions(sessionId, 'expired')`
- Hub가 다시 시작되면 장부는 비어 있다(승인 선택지와 같음)

### 3. Claude 세션 — `src/channel/server.ts`, `src/channel/hub-client.ts`

`ask` 도구:

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

- 질문 id는 `q1`부터. `requestId`는 `randomUUID()`. `normalizeQuestionRequest`로 검사하고 틀리면 `isError`와 이유를 돌려준다
- Hub에 `question`을 보내고 이어서 `status: waiting_input`
- 결과 글: `Question sent (id …). It shows in the dashboard conversation and on Telegram with buttons. Keep working on anything that does not depend on the answer; the answer arrives as a channel message starting with "Answer to your question".` Hub에 연결돼 있지 않으면(`HubClient`에 `isConnected()`를 더함) 끝에 `The hub is not connected right now, so the question is queued and shown once it reconnects. If the answer is urgent, also ask in the terminal.`
- Hub에서 `question_answer`가 오면 채널 알림 `notifications/claude/channel`: `content = answerText(questions, answers)`, `meta = { sender: source ?? 'dashboard', timestamp, questionId: requestId }`

안내문 QUESTIONS 항목을 바꾼다:

> QUESTIONS: When the user can answer by picking from a few options, use ask: it shows the question with buttons in the dashboard conversation and on Telegram, and sets waiting_input for you. Its answer arrives later as a channel message starting with "Answer to your question". For an open question, send the whole question with reply (the context, what you need, your recommendation) and call status("waiting_input"). Never put a question only in notify: a notification is not part of the session's conversation, so the user has no place there to read the context and answer.

`reply`·`notify` 도구 설명의 "질문은 reply로"는 "질문은 ask 또는 reply로"로 맞춘다.

### 4. Codex 어댑터 — `src/codex/adapter.ts`, `src/codex/mapping.ts`

- `AgentMessage`에 `id?`, `delivery?`, `questions?`를 더한다. `asyncQuestions(item): Question[] | null`(mapping.ts): `questions`가 비어 있지 않은 배열이면 `{id: q1…, question: title, options: options?.map((label) => ({label})) ?? null, allowOther: true}`, 아니면 `null`. 결과가 `normalizeQuestionRequest`를 통과하지 못하면 `null`(그 메시지는 지금처럼 턴 끝 답장으로 간다)
- **즉시 보내기**: `collect`에서 `asyncQuestions(item)`이 있으면 바로 `question`을 보낸다(`context = item.text`). 보낸 항목 id는 대화별 `relayed` 집합에 둔다
- **턴 끝**: `onTurnCompleted`에서 `turn.items` 중 질문이 붙었는데 `relayed`에 없는 항목(구독이 늦어 `item/completed`를 놓친 경우)은 그때 보낸다. 질문이 붙은 항목은 `finalAnswer`에 넣지 않는다. 남은 글이 없으면 `reply`를 보내지 않는다. 그 턴의 항목 id는 `relayed`에서 지운다
- **답 넣기**: Hub에서 `question_answer`가 오면 `enqueue(threadId, async () => textInput(answerText(questions, answers), source), source)` — 일반 글과 같은 길(steer 또는 start, `Queued` 알림 포함)
- **`requestUserInput`**: 알림은 그대로 두고, 그 전에 `logger.warn('Codex requestUserInput not relayed: ' + params JSON 앞 4000자)`
- **위험(실측으로 확인)**: Codex가 질문하고 자는 동안 상태 플래그가 `waitingOnUserInput`이면 `waitingForAnswer`가 답을 거절한다. 7절 실측에서 확인하고, 그렇다면 "열린 질문의 답이고 답 안 한 승인이 없으면 통과"로 바꾼다

### 5. 텔레그램 — `src/hub/telegram.ts`

- `sendQuestion(sessionId, label, request)`
  - 질문이 하나: 메시지 하나 = `❓ <b>Question</b> — 세션` + 설명 + 질문 + 버튼(선택지마다 한 줄, `qa:<토큰>`) + 안내 한 줄(`allowOther`면 `Or reply to this message with your own answer.`, 선택지가 없으면 `Reply to this message with your answer.`)
  - 질문이 여럿: 첫 메시지 = `❓ <b>Questions (N)</b> — 세션` + 설명, 그 뒤 질문마다 `<b>i/N</b>` + 머리표·질문 + 버튼 + 안내
  - 설명은 기존 `fitNotification`처럼 화면 글자 수 상한에 맞춰 자르고, 질문 글도 상한을 넘으면 자른다
  - 질문 메시지 id도 `messageSessionMap`에 넣어, 답으로 받을 수 없는 답장(이미 닫힌 질문 등)은 지금처럼 세션으로 간다
- 상태: 요청별 `{sessionId, requestId, questions, answers, messageIds, outcome?}`, 토큰 → `{key, qid, label}`, 질문 메시지 id → `{key, qid}`. 요청은 최대 100개(넘으면 오래된 것부터 지우고 토큰도 지움)
- 버튼: 그 질문의 답으로 적고, 메시지를 `✅ 답`으로 고치며 버튼을 없앤다. 토스트 `Selected: 답`
- 답장: 질문 메시지에 대한 글 답장이고 그 질문이 `allowOther`이며 아직 답이 없으면 답으로 적는다(사진 답장은 지금처럼 세션으로)
- 모든 질문에 답이 모이면 `onQuestionAnswer(sessionId, requestId, answers)`(Hub의 `answerQuestion`, 출처 `telegram`). 결과가 `ok`가 아니면 `Not delivered: 이유`를 보낸다
- `resolveQuestion(sessionId, requestId, state, answers?, source?)`: 아직 고치지 않은 메시지를 고친다 — answered는 `✅ 답`(다른 곳에서 답했으면 `✅ 답 (Dashboard)`), closed는 `Closed — a message was sent instead`, expired는 `⌛ Expired`. 토큰과 답장 표를 지운다. 메시지를 아직 보내는 중이면 보낸 직후에 고친다(`sendChoiceRequest`의 `outcome`과 같은 방식)

### 6. 대시보드 — `src/dashboard/index.html`

- 대화 메시지에 질문 종류를 더한다: `{from: 'session', kind: 'question', requestId, context, questions, state: 'open' | 'answered' | 'closed' | 'expired' | 'gone', answers, source, time}`. localStorage 저장은 지금 규칙(세션별 마지막 5개) 그대로
- `question`: 같은 `requestId`가 없을 때만 더한다. 알림 패널에 `Question` 줄(warning, 첫 질문 글), 제목 깜빡임, 선택 안 된 세션이면 읽지 않음 수
- `questions_pending`: 없는 질문은 더하고(알림 줄과 깜빡임은 새로 더한 게 있을 때 한 번만, 복원 승인과 같은 방식), 이 대시보드에 열린 채로 저장돼 있는데 목록에 없으면 `gone`(`No longer open`)
- `question_resolved`: 그 카드의 상태·답·출처를 바꾸고 저장
- `question_rejected`: 입력창 아래 빨간 줄 `Answer not delivered: 이유`(기존 `showNotDelivered`), 카드를 다시 누를 수 있게
- 카드: 설명(마크다운) → 질문마다 머리표·질문(마크다운)·선택지 버튼(설명은 아래 작은 글씨)·직접 입력 칸(`allowOther`)
  - 질문이 하나: 버튼을 누르면 바로 보낸다. 직접 입력은 Enter로 보낸다
  - 질문이 여럿: 질문마다 고르거나 입력한다. 버튼을 고르면 그 질문의 입력은 지우고, 입력하면 고른 버튼을 푼다. 모두 채우면 `Send`가 켜진다
  - 보낸 뒤 결과가 올 때까지 잠근다
  - 닫힌 카드: 질문마다 `→ 답`, 상태 줄 `Answered · Dashboard`/`Answered · Telegram`/`Closed — a message was sent instead`/`Expired — the session ended`/`No longer open`
- 고른 것·입력 중인 글은 `state.questionDrafts`에 두고 다시 그릴 때 살린다. 다시 그릴 때 입력 칸에 커서가 있었으면 커서를 돌려준다

### 7. 실제 확인

- 격리 HOME(`test/isolate-home.ts`와 같은 방식)으로 Hub를 띄운다. 실제 텔레그램 봇은 쓰지 않는다
- Claude 쪽: 채널 서버를 MCP 클라이언트로 띄워 `ask`를 부르고, Chrome에서 카드에 답해 채널 알림이 오는지 본다
- Codex 쪽: 격리 Hub에 붙은 어댑터가 실제 Codex 데몬을 보게 하고, 시험 스크립트로 Plan 모드 질문을 시킨다. 카드가 바로 뜨는지, 카드에서 답하면 Codex가 자는 중에 받아 이어서 답하는지, 그동안의 상태 플래그(4절 위험)를 본다
- 실제 텔레그램 화면은 배포 뒤 사용자가 확인한다

## 오류와 경계

- 세션이 보낸 질문이 형식에 안 맞으면 Hub는 버리고 경고 로그(채널 서버가 먼저 검사하므로 정상 경로에선 없음)
- 대시보드 두 개·텔레그램이 동시에 답하면 Hub에서 먼저 도착한 하나만 성공한다. 나머지는 `the question is no longer open`
- 터미널이나 Codex 창에서 답한 것은 알 수 없어 질문이 열린 채로 남는다. 나중에 답이 가면 세션이 상황을 보고 처리한다
- Codex 질문 형식은 EXPERIMENTAL이다. 형식이 바뀌어 `asyncQuestions`가 `null`을 주면 지금처럼 턴 끝 답장으로 간다

## 시험

- 단위: `normalizeQuestionRequest`·`checkAnswers`·`answerText`, `QuestionBook`, `asyncQuestions`
- Hub 통합(`hub-permission-choices.test.ts` 방식): 질문 → 대시보드 방송·데스크톱 알림 요청, 새 대시보드의 `questions_pending`, 답 → 세션의 `question_answer`(+질문 원문·출처)와 `question_resolved`, 잘못된 답·닫힌 질문·끊긴 세션의 `question_rejected`, 일반 메시지 다섯 길에서 닫기, 세션 삭제·끊김에서 만료, 형식 틀린 질문 무시
- 채널(`channel-guidance.test.ts` 방식 + 가짜 Hub): `ask` → Hub가 `question`과 `waiting_input`을 받음, 잘못된 입력은 `isError`, Hub가 없을 때 결과 글, Hub의 `question_answer` → 채널 알림 내용·meta, 안내문 QUESTIONS 문구
- Codex(가짜 데몬): 질문 붙은 `item/completed` → 즉시 `question`, 턴 끝 중복 없음, 놓친 항목은 턴 끝에 한 번, 질문만 있던 턴은 `reply` 없음, `question_answer` → `turn/steer`(진행 중)·`turn/start`(끝남)의 글, `requestUserInput` → 알림과 로그
- 텔레그램(`fetch` 가짜): 하나·여럿 메시지와 버튼, 부분 답 고침, 답장 입력, 모두 모이면 `onQuestionAnswer`, 실패 시 `Not delivered`, `resolveQuestion` 세 상태, 보내는 중 해결, 상한 정리
- 대시보드(vm): 질문 추가·중복 무시, 복원(더하기·`gone`), 결과 반영, 거절 처리, 하나/여럿 보내기 규칙, 초안 유지

## 이번에 안 하는 것

여러 개 고르기, 비밀 입력, 보낸 질문 고치기·취소, Hub 재시작 뒤 질문 보존, `requestUserInput`·`permissions/requestApproval`·`elicitation` 중계, 터미널·Codex 창에서 답한 것 알아채기
