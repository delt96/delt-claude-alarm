# 안정화 2: 끊긴 세션 전달, M2, 복원 승인, `.cmd` 손자 프로세스

날짜: 2026-10-05 · 상태: 사용자 승인(설계 1/2·2/2, 2026-10-05)

## 배경

안정화(npm 1.3.0)와 단계 B·C에서 미뤄 둔 문제를 묶는다. codex-sdd의 교차 검증 실험(Obsidian `Projects/claude_alarm/docs/tasks/2026-10-01-ai-중립-협업-개발-실험-계획.md` "교차 검증 실험")의 첫 대상이다.

확인한 사실 (main f015793 = npm 1.3.0):

- 세션 목록과 채널 소켓은 함께 지워진다(`src/hub/server.ts:409-426`, `250-264`). Codex 대화도 어댑터가 채널 소켓으로 등록하므로 같다(`src/codex/adapter.ts:491-501`)
- 대시보드에서 보낸 글은 채널 소켓이 없거나 닫혔으면 아무 표시 없이 버려진다(`server.ts:703-707`). 대시보드는 보내자마자 "답 기다리는 중"으로 표시한다(`src/dashboard/index.html:1882-1928`). 이미지 업로드는 같은 경우 `upload_rejected`로 이유를 알린다(`server.ts:767-779`, `index.html:1288-1297`). `/api/send`는 404를 돌려준다(`server.ts:354-358`)
- 텔레그램에서 보낸 글·사진도 같은 경우 버려진다(`server.ts:839-854`의 `onMessageToSession`·`onImageToSession`은 반환값이 없다). 텔레그램 쪽은 전달 성공을 알 수 없다(`src/hub/telegram.ts:314-318`). 사진은 콜백이 있기만 하면 성공으로 본다(`telegram.ts:356-361`). 그래서:
  - 사라진 세션의 옛 알림에 답장하면(`telegram.ts:239-248`) 아무 표시 없이 사라진다
  - `/s_N`은 글이면 실패해도 "Sent to …"를 보낸다(`telegram.ts:260-266`)
  - 세션 선택 버튼은 글이면 실패해도 "Sent to …" 토스트와 메시지 수정을 한다(`telegram.ts:586-601`)
  - 세션이 하나뿐인 경우(`telegram.ts:283-289`)는 표시가 없다
- M2: 어댑터의 `deliver`는 승인 대기를 맨 앞에서 한 번만 확인한다(`adapter.ts:516`). 그 뒤 이미지 읽기(`build`), 구독(`want`), 턴 조회(`runningTurn`)를 기다린 다음 steer한다(`adapter.ts:520-541`). 그 사이 승인이 시작되면 메시지가 steer되고, Codex는 승인이 해결된 뒤에 그것을 읽는다(app-server 0.160.0 실측). 사용자에게는 메시지가 승인의 답처럼 보인다
- "Queued" 알림은 어댑터의 `notify`(`adapter.ts:542`, `641-643`)로 Hub에 가고, Hub는 `notify`를 데스크톱·텔레그램·웹훅(`notifier.notifyWithSession`)과 모든 대시보드로 보낸다(`server.ts:483-495`). 메시지가 어디서 왔는지(`source`: `dashboard`·`telegram`·`api`, `src/shared/types.ts:6`)는 어댑터가 받는다(`adapter.ts:493-495`)
- 대시보드가 다시 연결되면 Hub가 기다리는 선택형 승인 목록(`permission_pending`)을 보내고(`server.ts:693-697`), 대시보드는 모르는 요청마다 `permission_request` 처리를 다시 돌린다(`index.html:1503-1509`). 그 처리는 요청마다 알림 행을 더하고 제목을 깜빡인다(`index.html:1487-1490`)
- `flashTitle`(`index.html:2215-2231`)은 부를 때마다 `document.title`을 원래 제목으로 저장하고 focus 처리기를 하나씩 더한다. 이미 깜빡이는 중(0.5초 지난 뒤)에 다시 부르면 `** … **`를 원래 제목으로 저장하고, 깜빡임이 끝난 뒤 그 제목이 남을 수 있다
- npm으로 설치한 Codex(`codex.cmd`)는 셸로 띄운다(`src/codex/transport.ts:57-61`). 연결을 닫을 때 `child.kill()`은 셸만 끄고(`transport.ts:89-92`), 셸 아래의 proxy는 남는다. 핸드셰이크 시간 초과와 정상 종료 모두 같다. 이 PC의 Codex는 `codex.exe`라 해당하지 않는다

## 결정 (사용자, 2026-10-05)

- 끊긴 세션: **연결 여부만 확인**한다. 받음 확인(ack) 프로토콜은 만들지 않는다. 반쯤 끊겼는데 아직 열려 보이는 연결(하트비트 전)은 못 잡는다
- "Queued" 알림: **보낸 곳에만**. 대시보드에서 보냈으면 대시보드에만, 텔레그램이면 텔레그램에만, API면 로그에만. 데스크톱 알림·웹훅은 없음
- 실행: codex-sdd 교차 검증 실험 모드

## 설계

### 1. Hub가 전달 결과를 돌려준다

- 새 메시지 `{ type: 'message_rejected'; sessionId: string; reason: string }`(Hub → 대시보드). 대시보드가 보낸 `message_to_session`의 대상 채널 소켓이 없거나 열려 있지 않으면 Hub는 보낸 대시보드에만 이것을 보낸다. 이유 문구는 `the session is not connected`(이미지 업로드와 같음). Hub 로그에 경고 한 줄
- 텔레그램 콜백의 형식을 바꾼다: `onMessageToSession?: (sessionId, content) => boolean`, `onImageToSession?: (sessionId, imagePath, mimeType, caption?) => boolean`. Hub는 채널 소켓이 열려 있어 보냈으면 `true`, 아니면 `false`와 경고 로그

### 2. 텔레그램이 전달 결과를 쓴다

- `deliverToSession`은 콜백의 결과를 돌려준다(콜백이 없으면 `false`). 실패하면 `Not delivered: the session is no longer connected`를 보낸다
- `deliverPhotoToSessionByFileId`는 콜백이 `false`면 받아 둔 파일을 바로 지우고 `Photo not delivered: the session is no longer connected`(기존 `photoNotDelivered`)로 알린 뒤 `false`를 돌려준다
- `/s_N`과 선택 버튼은 글도 사진처럼 실패하면 "Sent to"를 보내지 않는다. 선택 버튼은 실패하면 토스트 `Not delivered`와 버튼 제거(사진 실패와 같은 처리)
- 답장·세션 하나 경로는 성공 때 지금처럼 표시가 없다(실패 때만 알림)

### 3. 대시보드가 `message_rejected`를 표시한다

- `upload_rejected`와 같은 방식: "답 기다리는 중" 해제, 선택된 세션이면 입력창 아래 오류 줄 `Message not delivered: <reason>`, 알림 목록에 한 줄(제목 `Message not delivered`, 경고)
- 이미 그려 둔 내 메시지는 지우지 않는다

### 4. M2: steer 직전에 다시 확인

- `deliver`는 `runningTurn` 뒤, `turn/steer`·`turn/start`를 보내기 직전에 `hubStatus(t.thread.status) === 'waiting_input'`을 다시 확인한다. 대기 중이면 맨 앞 확인과 같은 `Not delivered` 알림을 보내고 아무것도 보내지 않는다. 이때 `pendingTurn`·`unrelayed`·구독은 실패 경로와 같이 되돌린다
- 남는 틈: 확인과 RPC 사이, RPC와 데몬 처리 사이. 상태 방송이 늦으면 막지 못한다

### 5. "Queued"는 보낸 곳에만

- `notify` 메시지에 선택 필드 `to?: MessageSource`를 더한다(채널 → Hub). 없으면 지금과 같다
- Hub: `to === 'dashboard'`면 대시보드에만(`notification`), `'telegram'`이면 텔레그램 봇의 `sendNotification`에만(봇이 없으면 아무 데도), `'api'`면 로그에만. 데스크톱·웹훅은 `to`가 있으면 쓰지 않는다
- 어댑터: `deliver`가 메시지의 `source`를 받아 "Queued" 알림에만 `to: source`를 붙인다(`source`가 없으면 `to` 없이 지금처럼). 다른 알림(`Not delivered` 등)은 바꾸지 않는다
- 예전 Hub는 `to`를 무시하고 지금처럼 보낸다

### 6. 복원 승인과 제목 깜빡임

- `permission_pending`으로 되살린 요청은 승인 막대에 모두 넣되, 요청마다 알림 행·깜빡임을 만들지 않는다. 되살린 요청이 하나 이상이면 알림 행 하나(`N approval request(s) waiting`, 경고)와 깜빡임 한 번
- 실시간 `permission_request`는 지금처럼 요청마다 알림 행·깜빡임
- `flashTitle`: 깜빡이지 않을 때의 제목만 원래 제목으로 저장한다. 다시 불리면 메시지만 바꾸고 focus 처리기·30초 타이머는 하나만 둔다. 멈추면 원래 제목으로 돌아간다

### 7. proxy 닫기

- `close()`는 먼저 proxy의 stdin을 닫고(정상 종료 기회), 프로세스 트리를 끈다
- 트리 끄기: Windows에서는 `taskkill /PID <띄운 PID> /T /F`(`windowsHide: true`, 우리가 띄운 PID와 그 아래만), 그 밖에는 `child.kill()`. `connectProxy`는 이 함수를 주입받아 테스트한다
- 이미 끝난 프로세스에 대한 `taskkill` 실패는 무시한다(디버그 로그)
- 구현 중 바뀐 점(리뷰 반영):
  - 셸이 먼저 끝나 proxy가 남는 것을 리뷰가 재현해, 셸이 살아 있는 동안 자손(PID·생성 시각)을 기록하고, 셸이 끝난 뒤에는 생성 시각이 그대로인 자손만 끈다
  - `/T`는 쓰지 않는다. `taskkill /T`는 ParentProcessId만 보고 트리를 만들어, 원래 부모가 끝나 PID가 재사용된 오래된 무관한 프로세스까지 끌 수 있다. 대신 프로세스 스냅샷에서 생성 시각으로 확인한 자손을 PID 하나씩 `taskkill /PID <PID> /F`로 깊은 것부터 끄고, 마지막에 셸을 끈다
  - `close()`는 끄기가 끝나면 끝나는 Promise를 돌려주고, 어댑터 종료는 기존 3초 한도 안에서 이 끄기를 기다린다. cmd.exe 밑 proxy는 종료 시 자식을 끄는 job 밖에 있어서, 기다리지 않으면 남는다

## 작업 나누기

| # | 작업 | 파일 |
|---|---|---|
| 1 | Hub 전달 결과(`message_rejected`, 텔레그램 콜백 반환값) | `src/hub/server.ts`, `src/shared/types.ts` |
| 2 | 텔레그램 실패 안내 | `src/hub/telegram.ts` |
| 3 | 대시보드 `message_rejected` 표시 | `src/dashboard/index.html` |
| 4 | M2 재확인 | `src/codex/adapter.ts` |
| 5 | Queued는 보낸 곳에만 | `src/codex/adapter.ts`, `src/hub/server.ts`, `src/shared/types.ts` |
| 6 | 복원 승인·`flashTitle` | `src/dashboard/index.html` |
| 7 | proxy 닫기 | `src/codex/transport.ts` |

## 시험

- 단위 테스트(작업마다), `npm test` 전체, `tsc`
- 작업 7: 주입한 kill 함수로 단위 테스트. Windows에서는 가짜 `codex.cmd`(아무 응답 없이 오래 사는 Node 프로세스를 띄움)로 실제 시간 초과와 정상 닫기를 돌려 손자 프로세스가 사라지는지 PID로 확인(우리가 띄운 것만)
- 마지막 실측: 격리 HOME·포트 7989–7998 Hub에서 끊긴 세션으로 대시보드 글 보내기(브라우저), 복원 승인 깜빡임(브라우저). 실제 텔레그램 봇은 쓰지 않는다. 실제 텔레그램 화면 확인은 사용자에게 부탁한다

## 하지 않는 것

- 받음 확인(ack) 프로토콜, 반쯤 끊긴 연결 감지
- `Not delivered` 등 다른 어댑터 알림의 라우팅 변경
- Hub 재시작 뒤 어댑터가 되살린 승인(새 요청 ID로 다시 오는 것)의 묶음 처리
