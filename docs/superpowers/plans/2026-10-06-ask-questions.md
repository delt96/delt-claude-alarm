# Ask Questions With Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session can ask the user questions with a button per option, and Codex's own questions show up the same way at once. The question appears as a card in the dashboard conversation and as messages with buttons on Telegram. The answer goes back to the session, and the question counts as answered only after the session confirms it took the answer.

**Architecture:**
- **Shared format.** `src/shared/questions.ts` holds the question format, its limits, the answer check and the answer text. Every part uses it.
- **Hub.** The Hub keeps open questions in a `QuestionBook` (`src/hub/questions.ts`) and passes on `question`, `question_answer` and `question_delivery`. It tells dashboards `question_sending`, `question_resolved` or `question_rejected`. A plain message to a session closes its open questions, and a session that disconnects expires them.
- **Claude sessions.** The channel server adds an `ask` tool. It turns each answer into a channel notification and confirms it to the Hub.
- **Codex sessions.** The Codex adapter relays `agentMessage.questions` (the Codex 0.160 async question) as soon as the item completes. It sends the answer through its existing steer/start path and reports the result to the Hub instead of posting a notice.
- **Telegram.** The bot sends one message per question with token buttons, takes a typed answer from a reply, and rewrites every message with the result.
- **Dashboard.** It shows question cards in the conversation.

**Tech Stack:** TypeScript (ESM, Node 22), `ws`, `@modelcontextprotocol/sdk`, `zod`, Node built-ins (`vm`, global `fetch`), `node:test` + `tsx`, a single inline-script dashboard HTML file.

**Spec:** docs/superpowers/specs/2026-10-06-ask-questions-design.md

## Global Constraints

- Work in the worktree `C:/workspace/claude-alarm-ask` on branch `feat/ask-question`; do not switch branches. Another session works in `C:/workspace/claude-alarm` on another branch: do not touch it. No new dependencies.
- User-visible strings are exactly these (each task repeats the ones it needs):
  - Hub reasons: `the question is no longer open`, `the question is already being answered`, `the session is not connected`, `the session could not take the answer`, and the `readAnswers` errors (`question q2 has no answer`, `the answer to q1 is not one of its options`, `unknown question q3`, `the answer to q2 is longer than 5000 characters`, `answers must be an object`).
  - Desktop notice title `[<session label>] Question`, body = `questionSummary`.
  - Answer text: `Answer to your question:` / `Answers to your questions:`, then `- <first line of the question, up to 120 chars> → <answer>` per question.
  - Codex refusal: `Codex is waiting for an approval or input` and `Codex rejected the message: <error>`.
  - `ask` result: `Question sent (id <uuid>). …` and, when queued, `The hub is not connected right now, so the question is queued and shown once it reconnects. If the answer is urgent, also ask in the terminal.`
  - `ask` refusals: `Question not sent: <reason>` and `The hub is not connected and its queue is full, so the question was not sent. Ask in the terminal or with reply.`
  - Telegram: `❓ <b>Question</b> — <label>` / `❓ <b>Questions (N)</b> — <label>`, `<b>i/N</b>`, `Or reply to this message with your own answer.`, `Reply to this message with your answer.`, `☑️ <b>Selected:</b> <answer>`, `✅ <b><answer></b>` plus ` (Dashboard)` or ` (API)` when answered elsewhere, `<i>Closed — a message was sent instead</i>`, `⌛ <b>Expired</b>`, `Not delivered: <reason>`, toasts `Selected`, `Sending…`, `Not delivered`, `Expired`.
  - Dashboard: notification title `Question` (level `warning`) and restore row `N question(s) waiting` with `(s)` written literally; card meta `… · Question`; statuses `Sending…`, `Answered · Dashboard|Telegram|API`, `Closed — a message was sent instead`, `Expired — the session ended`, `No longer open`; error line `Answer not delivered: <reason>`; placeholders `Or type your own answer`, `Type your answer`, plus ` (Enter to send)` on a single question; button `Send`.
- Comments: none, except a one-line English comment for a non-obvious "why" (a counter-intuitive decision, an external constraint, a trap). No restating code, no change-history comments, no section dividers, no empty JSDoc. The code blocks below already contain the only comments allowed. Keep the anchor comments `// --- Questions ---` and `// --- Permission relay ---` in the dashboard: tests slice the file at them.
- Code blocks are exact: every "replace … with …" pair quotes the code as it is after the previous task, so find each spot by the quoted text, not by line number. New files are given in full.
- Any hub a test or a person starts uses an isolated HOME and USERPROFILE (a temp directory). Every new test file starts with `import './isolate-home.js';` (it must stay the first import). Ports taken by existing tests: 7900–7902, 7980–7982, 7989–7998. This plan adds 7983 (`test/hub-questions.test.ts`) and 7985 (`test/codex-questions.test.ts`); `test/channel-ask.test.ts` uses a random port for its stand-in hub and port 1 for "no hub"; Task 7's manual checks use 7984.
- Never kill processes by image name (`node.exe`, `codex.exe`, `cmd.exe`). Stop only what you started, by its handle or its recorded PID. Nothing may reach a real Telegram bot: Telegram tests replace `globalThis.fetch` with `t.mock.method`. The real Codex daemon is used only in Task 7.
- Commands. One file: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/<file>.test.ts` (several files may follow). All tests: `npm test` (551 tests before this plan, 621 after). Type check: `npx tsc --noEmit -p .` (`tsconfig.json` covers `src/` only).
- In new tests, do not use a bare `assert.ok(expr)` for a condition that can fail (Node can stall re-reading the transpiled file to quote it); use `assert.equal(expr, true)`, `assert.deepEqual`, or give `assert.ok` a message. The test code below already follows this.
- Dashboard tests evaluate a slice of `src/dashboard/index.html` in `node:vm`; arrays and objects made inside the sandbox belong to another realm, so the tests copy them (`{ ...obj }`) before `assert.deepEqual`.
- In this environment's Bash tool, `\\` inside a heredoc arrives as `\`. Write files with the editor (or a script file), not a heredoc, when the content has backslashes.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the inputs most likely to bite a user that the spec leaves implicit. Each line names the test that pins it; that test is part of the owning task below.

1. Codex sends the same question item again after it was answered, for example when the turn's summary arrives after the answer. The question must not reopen. Test: Task 2 "malformed and repeated questions are ignored, even after the first one closed" (the Hub remembers closed keys), together with Task 4 "the question is not sent again as a reply when the turn ends, while a later answer still is".
2. Codex stops or interrupts the turn after asking. The card must stay open, and the answer must start a new turn instead of being lost. Test: Task 4 "a question stays open when Codex stops the turn, and its answer starts a new turn".
3. On Telegram, someone replies to the heading message of a multi-question request instead of a question message. The reply must reach that session as a plain message, not a session picker. Test: Task 5 "a reply to the heading of several questions reaches the session as a plain message".
4. Option labels, headers or descriptions contain HTML. The dashboard must show them as text. Test: Task 6 "headers, labels and descriptions from a session are escaped in the card".
5. Someone is typing a Korean answer in a card when the 30-second time refresh fires. The box, its IME composition and the caret must survive. Test: Task 6 "the time refresh waits while an answer is being typed" (and the Task 7 browser check).

## Spec Facts Checked and Deviations

- **How this plan was checked.** Every task was applied to a scratch worktree (`plan/ask-question`, `C:/workspace/claude-alarm-ask-plan`).
  - After all tasks: `npm test` 621/621 and `npx tsc --noEmit -p .` clean.
  - Before Task 2's code, 13 of its 14 hub tests fail on the old `server.ts`.
  - The Task 7 checks were run there too:
    - A real channel server's `ask` → dashboard answer → channel notification passed.
    - A real Codex daemon (0.160.1) question passed. The card appeared 10 s after `turn/start`, the answer resolved 0.2 s later, Codex replied "You prefer Blue, and the name to use is Probe." 5 s after that, and there was one card and no notices.
  - The browser check passed: card rendering, multi-question Send, single-question one click, the refusal reopening, and a focused box surviving the 30 s refresh.
- **Names refined from the spec.**
  - `checkAnswers` became `readAnswers(questions, raw)`. It returns `{ ok: true, answers }` with trimmed answers, or `{ ok: false, error }`.
  - `normalizeQuestionRequest` is kept, next to `parseQuestionRequest` and `parseQuestions`, which give the reason (the `ask` tool shows it).
  - Added `isRequestId` and `questionSummary`.
- **`questions_pending` goes after `codex_adapters`.** The spec lists it after `permission_pending`, but the existing test "adapters that say hello are listed for dashboards, after the pending permissions" (`test/hub-codex.test.ts`) asserts that `codex_adapters` comes right after `permission_pending`.
- **The Hub's `initTelegram` is split into `initTelegram` and `wireTelegram(bot)`.** Tests can then wire a stand-in bot without polling Telegram.
- **Telegram heading message.** The heading of a multi-question request is remembered for reply routing. The spec does not say.
- **Turn end: questions are merged, reply text is not.** Spec section 4 says the collected items and `turn.items` are merged by id. This plan merges only for finding questions: every `turn.items` question not yet asked is sent. The reply text keeps today's rule, which takes the collected items when there are any and otherwise `turn.items`, minus the asked items. Merging the text as well would change what existing turns reply with (a summary item next to collected ones would be added). The spec's goal still holds: no question is lost or sent twice, and a turn that only asked sends no reply.
- **A focus gap that is left as it is.** After a refusal reopens a card, the focus does not return to the answer box. The draft text is kept.
- **Found while writing (out of scope).** `notifier.configure({ telegramBot: undefined })` does not clear the bot, because of `if (options.telegramBot)`. So turning Telegram off in the settings keeps notifications going through the old bot until the hub restarts (`handleTelegramSave` in `src/hub/server.ts`). The tests clear `notifier.telegramBot` directly.
- **Codex tests need their own item ids.** The Hub remembers closed question keys by design, so each Codex test uses its own item id. A test that reused `call_1` across tests would wait forever for a second card.

---

### Task 1: Shared question format

**Files:**
- Modify: `src/shared/types.ts` (question types and seven `ChannelMessage` members)
- Create: `src/shared/questions.ts`
- Test: `test/questions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, used by every later task:
  - In `src/shared/types.ts`:
    - `QuestionOption { label; description? }`
    - `Question { id; header?; question; options: QuestionOption[] | null; allowOther: boolean }`
    - `QuestionRequest { sessionId; requestId; context?; questions; timestamp }`
    - `QuestionAnswers = Record<string, string>`
    - `QuestionState = 'answered' | 'closed' | 'expired'`
    - `ChannelMessage` members:
      - `({ type: 'question' } & QuestionRequest)`
      - `questions_pending { requests: Array<QuestionRequest & { sending: boolean }> }`
      - `question_answer { sessionId; requestId; answers; questions?; source? }`
      - `question_delivery { sessionId; requestId; ok; reason? }`
      - `question_sending { sessionId; requestId; answers; source }`
      - `question_resolved { sessionId; requestId; state; answers?; source? }`
      - `question_rejected { sessionId; requestId; reason }`
  - In `src/shared/questions.ts`:
    - `QUESTION_LIMITS` (questions 10, question 2000, header 40, options 10, label 200, description 500, context 20000, answer 5000)
    - `isRequestId(v)`: `[A-Za-z0-9_:.-]{1,100}`
    - `parseQuestions(raw)` → `{ ok: true, questions } | { ok: false, error }`. Question ids are `[A-Za-z0-9_-]{1,40}` and unique; `allowOther` defaults to true and is forced on when `options` is null.
    - `parseQuestionRequest(raw)` → `{ ok: true, request } | { ok: false, error }`
    - `normalizeQuestionRequest(raw)` → `QuestionRequest | null`
    - `readAnswers(questions, raw)` → `{ ok: true, answers } | { ok: false, error }`
    - `answerText(questions, answers)` → string
    - `questionSummary(request)` → string

- [ ] **Step 1: Write the failing test**

Create `test/questions.test.ts`:

````ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerText,
  isRequestId,
  normalizeQuestionRequest,
  parseQuestionRequest,
  parseQuestions,
  questionSummary,
  readAnswers,
} from '../src/shared/questions.js';
import type { Question } from '../src/shared/types.js';

const color = { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue', description: 'the calm one' }], allowOther: false };
const name = { id: 'q2', question: 'What name should I use?', options: null, allowOther: true };
const base = { sessionId: 's1', requestId: 'r-1', questions: [color, name], timestamp: 5 };

const errorOf = (raw: unknown) => {
  const r = parseQuestionRequest(raw);
  assert.equal(r.ok, false);
  return (r as { ok: false; error: string }).error;
};

test('a well-formed request comes back trimmed, with free-text questions always open to typing', () => {
  const r = parseQuestionRequest({
    ...base,
    context: '  Two things first.  ',
    questions: [{ ...color, header: ' Color ', question: '  Which color do you prefer?  ' }, { ...name, allowOther: false }],
  });
  assert.equal(r.ok, true);
  const request = (r as { ok: true; request: any }).request;
  assert.equal(request.context, 'Two things first.');
  assert.equal(request.questions[0].header, 'Color');
  assert.equal(request.questions[0].question, 'Which color do you prefer?');
  assert.equal(request.questions[1].allowOther, true);
  assert.equal(request.timestamp, 5);
});

test('allowOther defaults to true when options are given', () => {
  const r = parseQuestions([{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }]);
  assert.equal(r.ok, true);
  assert.equal((r as { ok: true; questions: Question[] }).questions[0].allowOther, true);
});

test('a missing or broken timestamp becomes the current time', () => {
  const before = Date.now();
  const request = normalizeQuestionRequest({ ...base, timestamp: 'soon' })!;
  assert.equal(request.timestamp >= before, true);
});

test('requests outside the limits are refused with a reason', () => {
  assert.match(errorOf({ ...base, questions: [] }), /1 to 10/);
  assert.match(errorOf({ ...base, questions: Array.from({ length: 11 }, (_, i) => ({ ...name, id: `q${i}` })) }), /1 to 10/);
  assert.match(errorOf({ ...base, questions: [{ ...name, question: '   ' }] }), /question 1/);
  assert.match(errorOf({ ...base, questions: [{ ...name, question: 'x'.repeat(2001) }] }), /question 1/);
  assert.match(errorOf({ ...base, questions: [{ ...name, header: 'h'.repeat(41) }] }), /header/);
  assert.match(errorOf({ ...base, questions: [{ ...color, options: [] }] }), /1 to 10 options/);
  assert.match(errorOf({ ...base, questions: [{ ...color, options: [{ label: 'Red' }, { label: 'Red' }] }] }), /repeat/);
  assert.match(errorOf({ ...base, questions: [{ ...color, options: [{ label: 'l'.repeat(201) }] }] }), /option/);
  assert.match(errorOf({ ...base, questions: [{ ...color, options: [{ label: 'Red', description: 'd'.repeat(501) }] }] }), /option/);
  assert.match(errorOf({ ...base, context: 'c'.repeat(20001) }), /context/);
});

test('ids must be plain and unique, so they cannot collide in a newline-joined key', () => {
  assert.match(errorOf({ ...base, requestId: 'a\nb' }), /requestId/);
  assert.match(errorOf({ ...base, requestId: 'r'.repeat(101) }), /requestId/);
  assert.match(errorOf({ ...base, questions: [{ ...name, id: 'q 1' }] }), /id/);
  assert.match(errorOf({ ...base, questions: [name, { ...color, id: 'q2' }] }), /repeat/);
  assert.match(errorOf({ ...base, sessionId: '' }), /sessionId/);
  assert.equal(isRequestId('codex-q:call_W4Xy.1'), true);
  assert.equal(isRequestId('codex-q:call W4'), false);
});

test('normalizeQuestionRequest returns null instead of a reason', () => {
  assert.equal(normalizeQuestionRequest({ ...base, questions: 'nope' }), null);
  assert.equal(normalizeQuestionRequest(null), null);
});

test('answers must cover every question, stay within options when typing is off, and come back trimmed', () => {
  const qs = normalizeQuestionRequest(base)!.questions;
  assert.deepEqual(readAnswers(qs, { q1: ' Blue ', q2: ' Probe ' }), { ok: true, answers: { q1: 'Blue', q2: 'Probe' } });
  assert.deepEqual(readAnswers(qs, { q1: 'Blue' }), { ok: false, error: 'question q2 has no answer' });
  assert.deepEqual(readAnswers(qs, { q1: 'Blue', q2: '  ' }), { ok: false, error: 'question q2 has no answer' });
  assert.deepEqual(readAnswers(qs, { q1: 'Green', q2: 'Probe' }), { ok: false, error: 'the answer to q1 is not one of its options' });
  assert.deepEqual(readAnswers(qs, { q1: 'Blue', q2: 'Probe', q3: 'x' }), { ok: false, error: 'unknown question q3' });
  assert.deepEqual(readAnswers(qs, { q1: 'Blue', q2: 'p'.repeat(5001) }), { ok: false, error: 'the answer to q2 is longer than 5000 characters' });
  assert.deepEqual(readAnswers(qs, ['Blue']), { ok: false, error: 'answers must be an object' });
});

test('the answer text lists each question by its first line and the answer in full', () => {
  const qs = normalizeQuestionRequest(base)!.questions;
  assert.equal(
    answerText(qs, { q1: 'Blue', q2: 'Probe' }),
    'Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe',
  );
  const long = [{ id: 'q1', question: `${'w'.repeat(130)}\nsecond line`, options: null, allowOther: true }];
  assert.equal(answerText(long, { q1: 'line one\nline two' }), `Answer to your question:\n- ${'w'.repeat(119)}… → line one\nline two`);
});

test('the summary names the first question and counts the rest', () => {
  assert.equal(questionSummary(normalizeQuestionRequest(base)!), 'Which color do you prefer? (+1 more)');
  assert.equal(questionSummary(normalizeQuestionRequest({ ...base, questions: [name] })!), 'What name should I use?');
});
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/questions.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/questions.js'`.

- [ ] **Step 3: Add the types**

In `src/shared/types.ts`:

Edit 1 of 2 — replace:

````ts
  closable?: boolean;
}

/** Messages sent between channel server and hub */
export type ChannelMessage =
  | { type: 'register'; session: SessionInfo }
````

with:

````ts
  closable?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[] | null;
  allowOther: boolean;
}

export interface QuestionRequest {
  sessionId: string;
  requestId: string;
  context?: string;
  questions: Question[];
  timestamp: number;
}

export type QuestionAnswers = Record<string, string>;

export type QuestionState = 'answered' | 'closed' | 'expired';

/** Messages sent between channel server and hub */
export type ChannelMessage =
  | { type: 'register'; session: SessionInfo }
````

Edit 2 of 2 — replace:

````ts
  | { type: 'permission_pending'; requests: PendingChoiceRequest[] }
  | { type: 'codex_adapters'; adapters: CodexAdapterInfo[] }
  | { type: 'codex_close'; sessionId: string }
  | { type: 'error'; message: string };

export interface CodexAdapterInfo {
````

with:

````ts
  | { type: 'permission_pending'; requests: PendingChoiceRequest[] }
  | { type: 'codex_adapters'; adapters: CodexAdapterInfo[] }
  | { type: 'codex_close'; sessionId: string }
  | ({ type: 'question' } & QuestionRequest)
  | { type: 'questions_pending'; requests: Array<QuestionRequest & { sending: boolean }> }
  | { type: 'question_answer'; sessionId: string; requestId: string; answers: QuestionAnswers; questions?: Question[]; source?: MessageSource }
  | { type: 'question_delivery'; sessionId: string; requestId: string; ok: boolean; reason?: string }
  | { type: 'question_sending'; sessionId: string; requestId: string; answers: QuestionAnswers; source: MessageSource }
  | { type: 'question_resolved'; sessionId: string; requestId: string; state: QuestionState; answers?: QuestionAnswers; source?: MessageSource }
  | { type: 'question_rejected'; sessionId: string; requestId: string; reason: string }
  | { type: 'error'; message: string };

export interface CodexAdapterInfo {
````

- [ ] **Step 4: Write the module**

Create `src/shared/questions.ts`:

````ts
import type { Question, QuestionAnswers, QuestionOption, QuestionRequest } from './types.js';

export const QUESTION_LIMITS = {
  questions: 10,
  question: 2000,
  header: 40,
  options: 10,
  label: 200,
  description: 500,
  context: 20000,
  answer: 5000,
} as const;

// permissionKey joins ids with a newline, so an id must never contain one.
const REQUEST_ID = /^[A-Za-z0-9_:.-]{1,100}$/;
const QUESTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

type Parsed<T> = { ok: true } & T | { ok: false; error: string };

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function trimmed(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && t.length <= max ? t : null;
}

const absent = (value: unknown) => value === undefined || value === null || value === '';

function parseOption(raw: any): QuestionOption | null {
  const label = trimmed(raw?.label, QUESTION_LIMITS.label);
  if (!label) return null;
  if (absent(raw.description)) return { label };
  const description = trimmed(raw.description, QUESTION_LIMITS.description);
  return description ? { label, description } : null;
}

function parseQuestion(raw: any, n: number): Parsed<{ question: Question }> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `question ${n} must be an object` };
  if (typeof raw.id !== 'string' || !QUESTION_ID.test(raw.id)) return { ok: false, error: `question ${n} has an invalid id` };
  const text = trimmed(raw.question, QUESTION_LIMITS.question);
  if (!text) return { ok: false, error: `question ${n} needs text of 1 to ${QUESTION_LIMITS.question} characters` };
  let header: string | undefined;
  if (!absent(raw.header)) {
    const h = trimmed(raw.header, QUESTION_LIMITS.header);
    if (!h) return { ok: false, error: `question ${n} has a header longer than ${QUESTION_LIMITS.header} characters` };
    header = h;
  }
  let options: QuestionOption[] | null = null;
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > QUESTION_LIMITS.options) {
      return { ok: false, error: `question ${n} needs 1 to ${QUESTION_LIMITS.options} options` };
    }
    const parsed = raw.options.map(parseOption);
    if (parsed.some((o: QuestionOption | null) => !o)) return { ok: false, error: `question ${n} has an option without a valid label or description` };
    options = parsed as QuestionOption[];
    if (new Set(options.map((o) => o.label)).size !== options.length) return { ok: false, error: `question ${n} must not repeat an option` };
  }
  const allowOther = options === null || raw.allowOther !== false;
  return { ok: true, question: { id: raw.id, ...(header ? { header } : {}), question: text, options, allowOther } };
}

export function parseQuestions(raw: unknown): Parsed<{ questions: Question[] }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUESTION_LIMITS.questions) {
    return { ok: false, error: `questions must list 1 to ${QUESTION_LIMITS.questions} questions` };
  }
  const questions: Question[] = [];
  for (const [i, item] of raw.entries()) {
    const r = parseQuestion(item, i + 1);
    if (!r.ok) return r;
    questions.push(r.question);
  }
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return { ok: false, error: 'questions must not repeat an id' };
  return { ok: true, questions };
}

export function parseQuestionRequest(raw: unknown): Parsed<{ request: QuestionRequest }> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'the request must be an object' };
  const r = raw as Record<string, any>;
  if (typeof r.sessionId !== 'string' || !r.sessionId) return { ok: false, error: 'sessionId is missing' };
  if (!isRequestId(r.requestId)) return { ok: false, error: 'requestId must be 1 to 100 letters, digits or _ : . -' };
  const parsed = parseQuestions(r.questions);
  if (!parsed.ok) return parsed;
  let context: string | undefined;
  if (!absent(r.context)) {
    if (typeof r.context !== 'string' || r.context.length > QUESTION_LIMITS.context) {
      return { ok: false, error: `context must be text of at most ${QUESTION_LIMITS.context} characters` };
    }
    context = r.context.trim() || undefined;
  }
  const timestamp = typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) ? r.timestamp : Date.now();
  return { ok: true, request: { sessionId: r.sessionId, requestId: r.requestId, ...(context ? { context } : {}), questions: parsed.questions, timestamp } };
}

export function normalizeQuestionRequest(raw: unknown): QuestionRequest | null {
  const r = parseQuestionRequest(raw);
  return r.ok ? r.request : null;
}

export function readAnswers(questions: Question[], raw: unknown): Parsed<{ answers: QuestionAnswers }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'answers must be an object' };
  const given = raw as Record<string, unknown>;
  const ids = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(given)) if (!ids.has(key)) return { ok: false, error: `unknown question ${key}` };
  const answers: QuestionAnswers = {};
  for (const q of questions) {
    const value = given[q.id];
    const answer = typeof value === 'string' ? value.trim() : '';
    if (!answer) return { ok: false, error: `question ${q.id} has no answer` };
    if (answer.length > QUESTION_LIMITS.answer) return { ok: false, error: `the answer to ${q.id} is longer than ${QUESTION_LIMITS.answer} characters` };
    if (!q.allowOther && !q.options?.some((o) => o.label === answer)) return { ok: false, error: `the answer to ${q.id} is not one of its options` };
    answers[q.id] = answer;
  }
  return { ok: true, answers };
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function answerText(questions: Question[], answers: QuestionAnswers): string {
  const head = questions.length === 1 ? 'Answer to your question:' : 'Answers to your questions:';
  return [head, ...questions.map((q) => `- ${firstLine(q.question)} → ${answers[q.id] ?? ''}`)].join('\n');
}

export function questionSummary(request: QuestionRequest): string {
  const first = firstLine(request.questions[0]?.question ?? '');
  const more = request.questions.length - 1;
  return more > 0 ? `${first} (+${more} more)` : first;
}
````

- [ ] **Step 5: Run the test and the type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/questions.test.ts` → 9 pass.
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/questions.ts test/questions.test.ts
git commit -m "feat(shared): a question format with limits, an answer check and the answer text a session receives" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Hub keeps, routes and closes questions

**Files:**
- Create: `src/hub/questions.ts`
- Modify: `src/hub/server.ts`
- Test: `test/hub-questions.test.ts` (port 7983)

**Interfaces:**
- Consumes (Task 1): `normalizeQuestionRequest`, `questionSummary`, `readAnswers`, and the `ChannelMessage` members.
- Produces:
  - **`QuestionBook`** (`src/hub/questions.ts`):
    - `add(request)` → the requests pushed out by the limit, or `null` if the request is already open or was closed recently
    - `get(sessionId, requestId)`
    - `take(sessionId, requestId)`, which removes and remembers
    - `forSession(sessionId)`, `all()`
    - Defaults: 500 open and 500 remembered closed keys. `OpenQuestion { request; sending?: { answers; source } }`.
  - **In `HubServer`, private but used by later tasks:**
    - `answerQuestion(sessionId, requestId, raw, source)` → `'ok'` or a reason. Task 5 calls it for Telegram.
    - `finishQuestionDelivery`, `closeQuestions(sessionId, 'closed' | 'expired')`, `announceQuestion(sessionId, requestId, state, answers?, source?)`. Task 5 adds a Telegram call in `announceQuestion` and `finishQuestionDelivery`.
    - `wireTelegram(bot)`, split out of `initTelegram`.
  - **Behaviour:**
    - `question` (after the socket-owner check) → added to the book → broadcast `question` to dashboards → `notifier.notifyWithSession(undefined, undefined, '[label] Question', questionSummary, 'warning')`.
    - A dashboard `question_answer` → `answerQuestion(…, 'dashboard')`. If that fails, only that dashboard gets `question_rejected`. If it succeeds, the session gets `question_answer` with `questions` and `source`, and all dashboards get `question_sending`.
    - `question_delivery` from the owning socket: `ok` → `question_resolved {state: 'answered', answers, source}`. Not ok → reopened, and all dashboards get `question_rejected` with the reason or `the session could not take the answer`.
    - Successful plain deliveries close the session's open questions that are not being sent (`state: 'closed'`). The five paths are: dashboard text, dashboard image, Telegram text, Telegram photo, `/api/send`.
    - Session removal (socket close or `DELETE /api/sessions/:id`) expires all of the session's questions.
    - `questions_pending` goes to each new dashboard after `codex_adapters`.

- [ ] **Step 1: Write the failing tests**

Create `test/hub-questions.test.ts` (Task 5 appends one more test to it):

````ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { QuestionBook } from '../src/hub/questions.js';

const PORT = 7983;
const TOKEN = 'question-test';
let hub: HubServer;
const desktop: unknown[][] = [];

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  (hub as any).notifier.notifyWithSession = async (...args: unknown[]) => { desktop.push(args); };
  await hub.start();
});
after(async () => { await hub.stop(); });

const settle = () => new Promise((r) => setTimeout(r, 150));

function open(path: string): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

async function channel(id: string) {
  const ch = await open('/ws/channel');
  ch.ws.send(JSON.stringify({ type: 'register', session: { id, name: id, status: 'idle', connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, channelEnabled: true } }));
  await settle();
  return ch;
}

const questions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: false },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];

const ask = (ws: WebSocket, sessionId: string, requestId: string, extra: object = {}) =>
  ws.send(JSON.stringify({ type: 'question', sessionId, requestId, questions, timestamp: 1, ...extra }));

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg));
const of = (inbox: any[], type: string) => inbox.filter((m) => m.type === type);

test('a question reaches every dashboard and the desktop, and a new dashboard gets it as pending', async () => {
  desktop.length = 0;
  const ch = await channel('s1');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's1', 'r1', { context: 'Two things first.' });
  await settle();
  const [q] = of(dash.inbox, 'question');
  assert.equal(q.requestId, 'r1');
  assert.equal(q.context, 'Two things first.');
  assert.deepEqual(q.questions, questions);
  assert.deepEqual(desktop, [[undefined, undefined, '[s1] Question', 'Which color do you prefer? (+1 more)', 'warning']]);
  const late = await open('/ws/dashboard');
  await settle();
  const [pending] = of(late.inbox, 'questions_pending');
  assert.deepEqual(pending.requests.map((r: any) => [r.requestId, r.sending]), [['r1', false]]);
  late.ws.close();
  dash.ws.close();
  ch.ws.close();
});

test('an answer goes to the session with the questions and its source, and is answered only once the session takes it', async () => {
  const ch = await channel('s2');
  const dash = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  ask(ch.ws, 's2', 'r2');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: ' Blue ', q2: 'Probe' } });
  await settle();
  assert.deepEqual(of(ch.inbox, 'question_answer'), [{
    type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Blue', q2: 'Probe' }, questions, source: 'dashboard',
  }]);
  assert.deepEqual(of(other.inbox, 'question_sending'), [{ type: 'question_sending', sessionId: 's2', requestId: 'r2', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' }]);
  assert.deepEqual(of(other.inbox, 'question_resolved'), []);
  send(other.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Red', q2: 'X' } });
  await settle();
  assert.deepEqual(of(other.inbox, 'question_rejected'), [{ type: 'question_rejected', sessionId: 's2', requestId: 'r2', reason: 'the question is already being answered' }]);
  const late = await open('/ws/dashboard');
  await settle();
  assert.equal(of(late.inbox, 'questions_pending')[0].requests.find((r: any) => r.requestId === 'r2').sending, true);
  send(ch.ws, { type: 'question_delivery', sessionId: 's2', requestId: 'r2', ok: true });
  await settle();
  assert.deepEqual(of(other.inbox, 'question_resolved'), [{ type: 'question_resolved', sessionId: 's2', requestId: 'r2', state: 'answered', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' }]);
  send(other.ws, { type: 'question_answer', sessionId: 's2', requestId: 'r2', answers: { q1: 'Red', q2: 'X' } });
  await settle();
  assert.equal(of(other.inbox, 'question_rejected')[1].reason, 'the question is no longer open');
  assert.equal(of(ch.inbox, 'question_answer').length, 1);
  for (const c of [late, other, dash, ch]) c.ws.close();
});

test('a session that cannot take the answer reopens the question for everyone', async () => {
  const ch = await channel('s3');
  const dash = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  ask(ch.ws, 's3', 'r3');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's3', requestId: 'r3', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(ch.ws, { type: 'question_delivery', sessionId: 's3', requestId: 'r3', ok: false, reason: 'Codex is waiting for an approval or input' });
  await settle();
  for (const d of [dash, other]) {
    assert.deepEqual(of(d.inbox, 'question_rejected'), [{ type: 'question_rejected', sessionId: 's3', requestId: 'r3', reason: 'Codex is waiting for an approval or input' }]);
  }
  send(other.ws, { type: 'question_answer', sessionId: 's3', requestId: 'r3', answers: { q1: 'Blue', q2: 'B' } });
  await settle();
  assert.equal(of(ch.inbox, 'question_answer').length, 2);
  assert.equal(of(ch.inbox, 'question_answer')[1].answers.q1, 'Blue');
  for (const c of [other, dash, ch]) c.ws.close();
});

test('an incomplete or out-of-list answer is refused with the reason and nothing reaches the session', async () => {
  const ch = await channel('s4');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's4', 'r4');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's4', requestId: 'r4', answers: { q1: 'Blue' } });
  send(dash.ws, { type: 'question_answer', sessionId: 's4', requestId: 'r4', answers: { q1: 'Green', q2: 'A' } });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_rejected').map((m) => m.reason), ['question q2 has no answer', 'the answer to q1 is not one of its options']);
  assert.deepEqual(of(ch.inbox, 'question_answer'), []);
  dash.ws.close();
  ch.ws.close();
});

test('a plain dashboard message closes the open questions but not one being answered', async () => {
  const ch = await channel('s5');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's5', 'open-one');
  ask(ch.ws, 's5', 'sending-one');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's5', requestId: 'sending-one', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(dash.ws, { type: 'message_to_session', sessionId: 's5', content: 'never mind, use green' });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved'), [{ type: 'question_resolved', sessionId: 's5', requestId: 'open-one', state: 'closed' }]);
  dash.ws.close();
  ch.ws.close();
});

test('/api/send also closes the open questions', async () => {
  const ch = await channel('s6');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's6', 'r6');
  await settle();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's6', content: 'hi' }),
  });
  assert.equal(res.status, 200);
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r6', 'closed']]);
  dash.ws.close();
  ch.ws.close();
});

test('a dashboard image also closes the open questions', async () => {
  const ch = await channel('s7');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's7', 'r7');
  await settle();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  send(dash.ws, { type: 'image_upload', sessionId: 's7', imageData: png, mimeType: 'image/png', originalName: 'a.png' });
  await settle();
  assert.equal(of(ch.inbox, 'image_to_session').length, 1);
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r7', 'closed']]);
  dash.ws.close();
  ch.ws.close();
});

test('Telegram text and photos close the open questions once delivered', async () => {
  const ch = await channel('s8');
  const dash = await open('/ws/dashboard');
  const bot: any = {};
  (hub as any).wireTelegram(bot);
  try {
    ask(ch.ws, 's8', 'r8a');
    await settle();
    assert.equal(bot.onMessageToSession('s8', 'from my phone'), true);
    ask(ch.ws, 's8', 'r8b');
    await settle();
    assert.equal(bot.onImageToSession('s8', 'C:/x.png', 'image/png', 'look'), true);
    await settle();
    assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r8a', 'closed'], ['r8b', 'closed']]);
  } finally {
    (hub as any).notifier.telegramBot = undefined;
    dash.ws.close();
    ch.ws.close();
  }
});

test('a session that disconnects expires its questions, including one being answered', async () => {
  const ch = await channel('s9');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's9', 'open-one');
  ask(ch.ws, 's9', 'sending-one');
  await settle();
  send(dash.ws, { type: 'question_answer', sessionId: 's9', requestId: 'sending-one', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  ch.ws.close();
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]).sort(), [['open-one', 'expired'], ['sending-one', 'expired']]);
  dash.ws.close();
});

test('removing a session through the API expires its questions', async () => {
  const ch = await channel('s10');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's10', 'r10');
  await settle();
  await fetch(`http://127.0.0.1:${PORT}/api/sessions/s10`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved').map((m) => [m.requestId, m.state]), [['r10', 'expired']]);
  dash.ws.close();
});

test('the same session reconnecting on a new socket keeps its questions', async () => {
  const first = await channel('s11');
  ask(first.ws, 's11', 'r11');
  await settle();
  const second = await channel('s11');
  await settle();
  const dash = await open('/ws/dashboard');
  await settle();
  assert.equal(of(dash.inbox, 'questions_pending')[0].requests.some((r: any) => r.requestId === 'r11'), true);
  assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
  send(dash.ws, { type: 'question_answer', sessionId: 's11', requestId: 'r11', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  assert.equal(of(second.inbox, 'question_answer').length, 1);
  dash.ws.close();
  second.ws.close();
});

test("another session's socket cannot ask or confirm for this session", async () => {
  const mine = await channel('s12');
  const intruder = await channel('s12-other');
  const dash = await open('/ws/dashboard');
  ask(intruder.ws, 's12', 'forged');
  ask(mine.ws, 's12', 'r12');
  await settle();
  assert.deepEqual(of(dash.inbox, 'question').map((m) => m.requestId), ['r12']);
  send(dash.ws, { type: 'question_answer', sessionId: 's12', requestId: 'r12', answers: { q1: 'Red', q2: 'A' } });
  await settle();
  send(intruder.ws, { type: 'question_delivery', sessionId: 's12', requestId: 'r12', ok: true });
  await settle();
  assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
  for (const c of [dash, intruder, mine]) c.ws.close();
});

test('malformed and repeated questions are ignored, even after the first one closed', async () => {
  const ch = await channel('s13');
  const dash = await open('/ws/dashboard');
  ask(ch.ws, 's13', 'bad id');
  ask(ch.ws, 's13', 'r13', { questions: [] });
  ask(ch.ws, 's13', 'r13');
  ask(ch.ws, 's13', 'r13');
  await settle();
  send(dash.ws, { type: 'message_to_session', sessionId: 's13', content: 'closing it' });
  await settle();
  ask(ch.ws, 's13', 'r13');
  await settle();
  assert.equal(of(dash.inbox, 'question').length, 1);
  dash.ws.close();
  ch.ws.close();
});

test('the question book keeps at most its limit open and remembers what it closed', () => {
  const book = new QuestionBook(2, 2);
  const req = (id: string) => ({ sessionId: 's', requestId: id, questions: [], timestamp: 0 });
  assert.deepEqual(book.add(req('a')), []);
  assert.deepEqual(book.add(req('b')), []);
  assert.deepEqual(book.add(req('c'))!.map((r) => r.requestId), ['a']);
  assert.equal(book.add(req('a')), null);
  assert.equal(book.add(req('b')), null);
  assert.equal(book.take('s', 'b')!.request.requestId, 'b');
  assert.equal(book.add(req('b')), null);
  book.take('s', 'c');
  assert.deepEqual(book.add(req('a')), []);
  assert.deepEqual(book.all().map((q) => q.request.requestId), ['a']);
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/hub-questions.test.ts`
Expected: FAIL — `Cannot find module '../src/hub/questions.js'`.

- [ ] **Step 3: Write the question book**

Create `src/hub/questions.ts`:

````ts
import { permissionKey } from '../shared/permission-key.js';
import type { MessageSource, QuestionAnswers, QuestionRequest } from '../shared/types.js';

export interface OpenQuestion {
  request: QuestionRequest;
  sending?: { answers: QuestionAnswers; source: MessageSource };
}

export class QuestionBook {
  private open = new Map<string, OpenQuestion>();
  // A Codex question is re-sent when its turn ends; remembering closed keys keeps an answered one from reopening.
  private closed = new Set<string>();

  constructor(private maxOpen = 500, private maxClosed = 500) {}

  /** Adds an open question. Returns the questions pushed out by the limit, or null if the request is already known. */
  add(request: QuestionRequest): QuestionRequest[] | null {
    const key = permissionKey(request.sessionId, request.requestId);
    if (this.open.has(key) || this.closed.has(key)) return null;
    this.open.set(key, { request });
    const evicted: QuestionRequest[] = [];
    while (this.open.size > this.maxOpen) {
      const [oldestKey, oldest] = this.open.entries().next().value as [string, OpenQuestion];
      this.open.delete(oldestKey);
      this.remember(oldestKey);
      evicted.push(oldest.request);
    }
    return evicted;
  }

  get(sessionId: string, requestId: string): OpenQuestion | undefined {
    return this.open.get(permissionKey(sessionId, requestId));
  }

  take(sessionId: string, requestId: string): OpenQuestion | undefined {
    const key = permissionKey(sessionId, requestId);
    const q = this.open.get(key);
    if (!q) return undefined;
    this.open.delete(key);
    this.remember(key);
    return q;
  }

  forSession(sessionId: string): OpenQuestion[] {
    return [...this.open.values()].filter((q) => q.request.sessionId === sessionId);
  }

  all(): OpenQuestion[] {
    return [...this.open.values()];
  }

  private remember(key: string): void {
    this.closed.add(key);
    while (this.closed.size > this.maxClosed) this.closed.delete(this.closed.values().next().value as string);
  }
}
````

- [ ] **Step 4: Wire it into the Hub**

In `src/hub/server.ts`:

Edit 1 of 14 — replace:

````ts
import { loadConfig, saveConfig } from '../shared/config.js';
import { sessionLabel } from '../shared/session-label.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import type { ChannelMessage, AppConfig, SessionInfo, WebhookConfig, TelegramConfig, PermissionChoice, PendingChoiceRequest, CodexAdapterInfo, CodexCall, CodexLinkMessage } from '../shared/types.js';
import { permissionKey } from '../shared/permission-key.js';
import { isEntryScript } from '../shared/entry.js';
import { hubUrlHost } from '../shared/hub-url.js';
import {
````

with:

````ts
import { loadConfig, saveConfig } from '../shared/config.js';
import { sessionLabel } from '../shared/session-label.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import type { ChannelMessage, AppConfig, SessionInfo, WebhookConfig, TelegramConfig, PermissionChoice, PendingChoiceRequest, CodexAdapterInfo, CodexCall, CodexLinkMessage, MessageSource, QuestionAnswers, QuestionState } from '../shared/types.js';
import { permissionKey } from '../shared/permission-key.js';
import { normalizeQuestionRequest, questionSummary, readAnswers } from '../shared/questions.js';
import { QuestionBook } from './questions.js';
import { isEntryScript } from '../shared/entry.js';
import { hubUrlHost } from '../shared/hub-url.js';
import {
````

Edit 2 of 14 — replace:

````ts
  private socketOwners = new WeakMap<WebSocket, string>();
  // Codex approvals carry their own choices; a response is forwarded only in the mode of the request it answers.
  private choiceRequests = new Map<string, { request: PendingChoiceRequest; choiceIds: Set<string> }>();

  private host: string;
  private port: number;
````

with:

````ts
  private socketOwners = new WeakMap<WebSocket, string>();
  // Codex approvals carry their own choices; a response is forwarded only in the mode of the request it answers.
  private choiceRequests = new Map<string, { request: PendingChoiceRequest; choiceIds: Set<string> }>();
  private questions = new QuestionBook();

  private host: string;
  private port: number;
````

Edit 3 of 14 — replace:

````ts
      this.localChannels.delete(sessionId);
      this.channelAlive.delete(sessionId);
      this.expireChoices(sessionId);
      if (session) {
        this.broadcastToDashboards({ type: 'session_disconnected', sessionId });
        this.jsonResponse(res, 200, { ok: true });
````

with:

````ts
      this.localChannels.delete(sessionId);
      this.channelAlive.delete(sessionId);
      this.expireChoices(sessionId);
      this.closeQuestions(sessionId, 'expired');
      if (session) {
        this.broadcastToDashboards({ type: 'session_disconnected', sessionId });
        this.jsonResponse(res, 200, { ok: true });
````

Edit 4 of 14 — replace:

````ts

    const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'api' };
    ws.send(JSON.stringify(msg));
    this.jsonResponse(res, 200, { ok: true });
  }
````

with:

````ts

    const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'api' };
    ws.send(JSON.stringify(msg));
    this.closeQuestions(sessionId, 'closed');
    this.jsonResponse(res, 200, { ok: true });
  }
````

Edit 5 of 14 — replace:

````ts
          this.localChannels.delete(sessionId);
          this.channelAlive.delete(sessionId);
          this.expireChoices(sessionId);
          logger.info(`Channel disconnected: ${sessionId}`);
          this.broadcastToDashboards({
            type: 'session_disconnected',
````

with:

````ts
          this.localChannels.delete(sessionId);
          this.channelAlive.delete(sessionId);
          this.expireChoices(sessionId);
          this.closeQuestions(sessionId, 'expired');
          logger.info(`Channel disconnected: ${sessionId}`);
          this.broadcastToDashboards({
            type: 'session_disconnected',
````

Edit 6 of 14 — replace:

````ts
        this.resolveChoice(msg.sessionId, msg.requestId, msg.state === 'expired' ? 'expired' : 'resolved');
        break;
      }
    }
  }
````

with:

````ts
        this.resolveChoice(msg.sessionId, msg.requestId, msg.state === 'expired' ? 'expired' : 'resolved');
        break;
      }

      case 'question': {
        const request = normalizeQuestionRequest(msg);
        if (!request) {
          logger.warn(`Invalid question from ${msg.sessionId}`);
          break;
        }
        const evicted = this.questions.add(request);
        if (!evicted) break;
        for (const old of evicted) this.announceQuestion(old.sessionId, old.requestId, 'expired');
        this.sessions.updateActivity(request.sessionId);
        this.broadcastToDashboards({ type: 'question', ...request });
        const label = this.getSessionLabel(this.sessions.get(request.sessionId));
        void this.notifier.notifyWithSession(undefined, undefined, `[${label}] Question`, questionSummary(request), 'warning');
        break;
      }

      case 'question_delivery': {
        this.finishQuestionDelivery(msg.sessionId, msg.requestId, msg.ok === true, typeof msg.reason === 'string' ? msg.reason : undefined);
        break;
      }
    }
  }
````

Edit 7 of 14 — replace:

````ts
    };
    ws.send(JSON.stringify(pendingMsg));
    ws.send(JSON.stringify({ type: 'codex_adapters', adapters: this.codexAdapterList() } satisfies ChannelMessage));

    ws.on('message', (data) => {
      try {
````

with:

````ts
    };
    ws.send(JSON.stringify(pendingMsg));
    ws.send(JSON.stringify({ type: 'codex_adapters', adapters: this.codexAdapterList() } satisfies ChannelMessage));
    const questionsMsg: ChannelMessage = {
      type: 'questions_pending',
      requests: this.questions.all().map((q) => ({ ...q.request, sending: q.sending !== undefined })),
    };
    ws.send(JSON.stringify(questionsMsg));

    ws.on('message', (data) => {
      try {
````

Edit 8 of 14 — replace:

````ts
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
          } else {
            const reason = 'the session is not connected';
            logger.warn(`Message rejected for ${msg.sessionId}: ${reason}`);
````

with:

````ts
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
            this.closeQuestions(msg.sessionId, 'closed');
          } else {
            const reason = 'the session is not connected';
            logger.warn(`Message rejected for ${msg.sessionId}: ${reason}`);
````

Edit 9 of 14 — replace:

````ts
          }
        } else if (msg.type === 'image_upload') {
          this.handleImageUpload(ws, msg);
        } else if (msg.type === 'permission_response') {
          if (this.forwardPermissionResponse(msg)) {
            const verdict = msg.choiceId !== undefined ? `choice ${msg.choiceId}` : msg.behavior;
````

with:

````ts
          }
        } else if (msg.type === 'image_upload') {
          this.handleImageUpload(ws, msg);
        } else if (msg.type === 'question_answer') {
          const outcome = this.answerQuestion(msg.sessionId, msg.requestId, msg.answers, 'dashboard');
          if (outcome !== 'ok' && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'question_rejected', sessionId: msg.sessionId, requestId: msg.requestId, reason: outcome } satisfies ChannelMessage));
          }
        } else if (msg.type === 'permission_response') {
          if (this.forwardPermissionResponse(msg)) {
            const verdict = msg.choiceId !== undefined ? `choice ${msg.choiceId}` : msg.behavior;
````

Edit 10 of 14 — replace:

````ts
    }
  }

  private broadcastToDashboards(msg: ChannelMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
````

with:

````ts
    }
  }

  // "Answered" waits for the session to take the answer (a Claude channel notification, a Codex steer or turn), not for the model to read it.
  private answerQuestion(sessionId: string, requestId: string, raw: unknown, source: MessageSource): string {
    const open = this.questions.get(sessionId, requestId);
    if (!open) return 'the question is no longer open';
    if (open.sending) return 'the question is already being answered';
    const read = readAnswers(open.request.questions, raw);
    if (!read.ok) return read.error;
    const channelWs = this.channelSockets.get(sessionId);
    if (channelWs?.readyState !== WebSocket.OPEN) return 'the session is not connected';
    open.sending = { answers: read.answers, source };
    const out: ChannelMessage = { type: 'question_answer', sessionId, requestId, answers: read.answers, questions: open.request.questions, source };
    channelWs.send(JSON.stringify(out));
    this.broadcastToDashboards({ type: 'question_sending', sessionId, requestId, answers: read.answers, source });
    return 'ok';
  }

  private finishQuestionDelivery(sessionId: string, requestId: string, ok: boolean, reason?: string): void {
    const open = this.questions.get(sessionId, requestId);
    if (!open?.sending) return;
    const { answers, source } = open.sending;
    if (ok) {
      this.questions.take(sessionId, requestId);
      this.announceQuestion(sessionId, requestId, 'answered', answers, source);
      return;
    }
    open.sending = undefined;
    this.broadcastToDashboards({ type: 'question_rejected', sessionId, requestId, reason: reason || 'the session could not take the answer' });
  }

  // A plain message closes the questions it overtakes; one already being answered waits for its own outcome.
  private closeQuestions(sessionId: string, state: 'closed' | 'expired'): void {
    for (const q of this.questions.forSession(sessionId)) {
      if (state === 'closed' && q.sending) continue;
      this.questions.take(sessionId, q.request.requestId);
      this.announceQuestion(sessionId, q.request.requestId, state);
    }
  }

  private announceQuestion(sessionId: string, requestId: string, state: QuestionState, answers?: QuestionAnswers, source?: MessageSource): void {
    this.broadcastToDashboards({ type: 'question_resolved', sessionId, requestId, state, ...(answers ? { answers } : {}), ...(source ? { source } : {}) });
  }

  private broadcastToDashboards(msg: ChannelMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
````

Edit 11 of 14 — replace:

````ts
      source: 'dashboard',
    };
    channelWs.send(JSON.stringify(forwardMsg));
    logger.info(`Image saved and forwarded: ${filename} (${buffer.length} bytes)`);

    // Cleanup after 5 minutes
````

with:

````ts
      source: 'dashboard',
    };
    channelWs.send(JSON.stringify(forwardMsg));
    this.closeQuestions(sessionId, 'closed');
    logger.info(`Image saved and forwarded: ${filename} (${buffer.length} bytes)`);

    // Cleanup after 5 minutes
````

Edit 12 of 14 — replace:

````ts

  private initTelegram(config: TelegramConfig): void {
    this.telegramBot = new TelegramBot(config);
    this.telegramBot.getSessions = () => this.sessions.getAll();
    this.telegramBot.onMessageToSession = (sessionId, content): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram message not delivered to ${sessionId}: the session is not connected`);
````

with:

````ts

  private initTelegram(config: TelegramConfig): void {
    this.telegramBot = new TelegramBot(config);
    this.wireTelegram(this.telegramBot);
    this.telegramBot.startPolling();
    logger.info('Telegram bot initialized');
  }

  private wireTelegram(bot: TelegramBot): void {
    bot.getSessions = () => this.sessions.getAll();
    bot.onMessageToSession = (sessionId, content): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram message not delivered to ${sessionId}: the session is not connected`);
````

Edit 13 of 14 — replace:

````ts
      }
      const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      logger.info(`Telegram message forwarded to session: ${sessionId}`);
      return true;
    };
    this.telegramBot.onImageToSession = (sessionId, imagePath, mimeType, caption): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram photo not delivered to ${sessionId}: the session is not connected`);
````

with:

````ts
      }
      const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      this.closeQuestions(sessionId, 'closed');
      logger.info(`Telegram message forwarded to session: ${sessionId}`);
      return true;
    };
    bot.onImageToSession = (sessionId, imagePath, mimeType, caption): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram photo not delivered to ${sessionId}: the session is not connected`);
````

Edit 14 of 14 — replace:

````ts
      }
      const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      logger.info(`Telegram photo forwarded to session: ${sessionId}`);
      return true;
    };
    this.telegramBot.onPermissionVerdict = (sessionId, requestId, behavior) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, behavior })) {
        logger.info(`Telegram permission verdict [${requestId}]: ${behavior} -> session ${sessionId}`);
      }
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    this.telegramBot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
      }
    };
    this.notifier.configure({ telegramBot: this.telegramBot });
    this.telegramBot.startPolling();
    logger.info('Telegram bot initialized');
  }

  private async handleTelegramSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
````

with:

````ts
      }
      const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      this.closeQuestions(sessionId, 'closed');
      logger.info(`Telegram photo forwarded to session: ${sessionId}`);
      return true;
    };
    bot.onPermissionVerdict = (sessionId, requestId, behavior) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, behavior })) {
        logger.info(`Telegram permission verdict [${requestId}]: ${behavior} -> session ${sessionId}`);
      }
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    bot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
      }
    };
    this.notifier.configure({ telegramBot: bot });
  }

  private async handleTelegramSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
````

- [ ] **Step 5: Run the tests, the existing hub and Telegram tests, and the type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/hub-questions.test.ts` → 14 pass.
Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/hub-*.test.ts test/telegram-*.test.ts` → all pass (`hub-codex.test.ts` checks the order of the messages a new dashboard gets).
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/hub/questions.ts src/hub/server.ts test/hub-questions.test.ts
git commit -m "feat(hub): questions stay open until the session takes the answer, close on a plain message and expire with the session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `ask` tool for Claude sessions

**Files:**
- Create: `src/channel/ask.ts`
- Modify: `src/channel/hub-client.ts` (`send` returns its result), `src/channel/server.ts` (instructions, tool descriptions, `ask`, answers)
- Test: `test/channel-ask.test.ts` (new), `test/channel-guidance.test.ts` (adjusted), `test/hub-client.test.ts` (one test added)

**Interfaces:**
- Consumes (Task 1): `parseQuestionRequest`, `answerText`. From Task 2: the Hub's handling of `question`, `question_answer` and `question_delivery`.
- Produces:
  - `HubClient.send(msg)` → `'sent' | 'queued' | 'dropped'`. It drops once 100 messages are queued. Existing callers ignore the result.
  - `src/channel/ask.ts`: `ASK_LIMITS` (4 questions, 2–6 options), `ASK_TOOL` (the tool definition), `askRequest(args, sessionId, requestId, now?)` → `{ ok: true, request } | { ok: false, error }` with question ids `q1…`, `askResultText(requestId, 'sent' | 'queued')`, `ASK_DROPPED`.
  - The `ask` tool sends `question`, then `status: waiting_input`. On a `question_answer` for this session, the channel server sends the channel notification `{ content: answerText(...), meta: { sender: source ?? 'dashboard', timestamp, questionId } }` and then `question_delivery` (`ok: true`, or `ok: false` with the error).
  - The instructions' QUESTIONS paragraph and the `notify` and `reply` descriptions now point to `ask`.

- [ ] **Step 1: Write the failing tests**

Create `test/channel-ask.test.ts`:

````ts
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { until } from './helpers/fake-codex-daemon.js';

// A stand-in hub: records what the channel server sends and can answer back.
let wss: WebSocketServer;
let hubSocket: WebSocket | undefined;
const fromChannel: any[] = [];
let client: Client;
const channelNotes: any[] = [];

async function spawnChannel(port: number): Promise<Client> {
  const c = new Client({ name: 'channel-ask-test', version: '0.0.0' });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join('src', 'channel', 'server.ts')],
    env: { ...process.env, CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: String(port) } as Record<string, string>,
    stderr: 'ignore',
  }));
  return c;
}

before(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (ws) => {
    hubSocket = ws;
    ws.on('message', (d) => fromChannel.push(JSON.parse(String(d))));
  });
  const port = (wss.address() as { port: number }).port;
  client = await spawnChannel(port);
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({}).passthrough() }),
    (n) => { channelNotes.push(n.params); },
  );
  await until(() => fromChannel.find((m) => m.type === 'register'), 15000);
});

after(async () => {
  await client.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('');

test('ask sends the question to the hub, marks the session as waiting, and says the answer comes later', async () => {
  const before = fromChannel.length;
  const result: any = await client.callTool({
    name: 'ask',
    arguments: {
      context: 'Two ways to do it.',
      questions: [
        { header: 'Scope', question: 'Who needs the alert?', options: [{ label: 'Approvers', description: 'Badge only' }, { label: 'Both' }] },
        { question: 'Anything else?' },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  const [question, status] = await until(() => {
    const sent = fromChannel.slice(before);
    return sent.length >= 2 && sent;
  });
  assert.equal(question.type, 'question');
  assert.match(question.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(question.context, 'Two ways to do it.');
  assert.deepEqual(question.questions, [
    { id: 'q1', header: 'Scope', question: 'Who needs the alert?', options: [{ label: 'Approvers', description: 'Badge only' }, { label: 'Both' }], allowOther: true },
    { id: 'q2', question: 'Anything else?', options: null, allowOther: true },
  ]);
  assert.deepEqual({ type: status.type, status: status.status }, { type: 'status', status: 'waiting_input' });
  assert.equal(status.sessionId, question.sessionId);
  assert.match(textOf(result), new RegExp(`^Question sent \\(id ${question.requestId}\\)\\.`));
  assert.match(textOf(result), /arrives as a channel message starting with "Answer to your question"/);
  assert.doesNotMatch(textOf(result), /not connected/);
});

test('a malformed ask is refused with the reason and nothing reaches the hub', async () => {
  const before = fromChannel.length;
  const tooMany: any = await client.callTool({ name: 'ask', arguments: { questions: [1, 2, 3, 4, 5].map((n) => ({ question: `Q${n}` })) } });
  const oneOption: any = await client.callTool({ name: 'ask', arguments: { questions: [{ question: 'Pick', options: [{ label: 'Only' }] }] } });
  const blank: any = await client.callTool({ name: 'ask', arguments: { questions: [{ question: '   ' }] } });
  assert.equal(tooMany.isError, true);
  assert.match(textOf(tooMany), /^Question not sent: questions must list 1 to 4 questions/);
  assert.match(textOf(oneOption), /question 1 needs 2 to 6 options/);
  assert.match(textOf(blank), /question 1 needs text/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fromChannel.length, before);
});

test('an answer from the hub reaches the session as a channel message and is confirmed back', async () => {
  const sessionId = fromChannel.find((m) => m.type === 'register').session.id;
  const questions = [
    { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: false },
    { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
  ];
  hubSocket!.send(JSON.stringify({ type: 'question_answer', sessionId, requestId: 'r-1', answers: { q1: 'Blue', q2: 'Probe' }, questions, source: 'telegram' }));
  const note = await until(() => channelNotes.find((n) => n.meta?.questionId === 'r-1'));
  assert.equal(note.content, 'Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe');
  assert.equal(note.meta.sender, 'telegram');
  const ack = await until(() => fromChannel.find((m) => m.type === 'question_delivery' && m.requestId === 'r-1'));
  assert.deepEqual(ack, { type: 'question_delivery', sessionId, requestId: 'r-1', ok: true });
});

test('an answer for another session is ignored', async () => {
  hubSocket!.send(JSON.stringify({ type: 'question_answer', sessionId: 'someone-else', requestId: 'r-2', answers: { q1: 'x' }, questions: [{ id: 'q1', question: 'Q', options: null, allowOther: true }] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(channelNotes.some((n) => n.meta?.questionId === 'r-2'), false);
  assert.equal(fromChannel.some((m) => m.type === 'question_delivery' && m.requestId === 'r-2'), false);
});

test('with no hub the question is queued and the result says so', async () => {
  const offline = await spawnChannel(1);
  try {
    const result: any = await offline.callTool({ name: 'ask', arguments: { questions: [{ question: 'Still there?' }] } });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /The hub is not connected right now, so the question is queued/);
  } finally {
    await offline.close();
  }
});
````

In `test/channel-guidance.test.ts`:

Edit 1 of 2 — replace:

````ts
  return tool.description ?? '';
}

test('the session guidance sends a question through reply and then waits for input', () => {
  const instructions = client.getInstructions() ?? '';
  const questions = instructions.match(/QUESTIONS:([^]*?)(?:\n\n|$)/)?.[1] ?? '';
  assert.match(questions, /\breply\b/);
  assert.match(questions, /waiting_input/);
  assert.match(questions, /never put a question only in notify/i);
});
````

with:

````ts
  return tool.description ?? '';
}

test('the session guidance sends a pick-from-options question through ask and an open one through reply', () => {
  const instructions = client.getInstructions() ?? '';
  const questions = instructions.match(/QUESTIONS:([^]*?)(?:\n\n|$)/)?.[1] ?? '';
  assert.match(questions, /picking from a few options, use ask/);
  assert.match(questions, /"Answer to your question"/);
  assert.match(questions, /open question, send the whole question with reply/);
  assert.match(questions, /waiting_input/);
  assert.match(questions, /never put a question only in notify/i);
});
````

Edit 2 of 2 — replace:

````ts
  assert.match(notifications, /need no answer/);
});

test('the notify tool points questions to reply', async () => {
  const description = await toolDescription('notify');
  assert.doesNotMatch(description, /need user attention/);
  assert.match(description, /ask the user something, use reply/i);
});

test('the reply tool says questions belong in it', async () => {
  assert.match(await toolDescription('reply'), /question/i);
});
````

with:

````ts
  assert.match(notifications, /need no answer/);
});

test('the notify tool points questions to ask or reply', async () => {
  const description = await toolDescription('notify');
  assert.doesNotMatch(description, /need user attention/);
  assert.match(description, /ask the user something, use ask or reply/i);
});

test('the reply tool takes open questions and points option questions to ask', async () => {
  const description = await toolDescription('reply');
  assert.match(description, /open questions/);
  assert.match(description, /use ask when they can pick from options/);
});

test('the ask tool is listed with its question shape', async () => {
  const { tools } = await client.listTools();
  const ask = tools.find((t) => t.name === 'ask');
  assert.ok(ask, 'the ask tool is listed');
  assert.deepEqual((ask.inputSchema as any).required, ['questions']);
  assert.equal((ask.inputSchema as any).properties.questions.maxItems, 4);
  assert.match(ask.description ?? '', /returns at once/);
});
````

In `test/hub-client.test.ts`, append:

Edit 1 of 1 — replace:

````ts
    assert.equal((client as any).connected, true);
  } finally {
    client.disconnect();
  }
});
````

with:

````ts
    assert.equal((client as any).connected, true);
  } finally {
    client.disconnect();
  }
});

test('send reports whether a message went out, was queued, or was dropped because the queue is full', () => {
  const client = new HubClient('x9', 'x9', '127.0.0.1', PORT, TOKEN);
  const msg = { type: 'status', sessionId: 'x9', status: 'idle' } as const;
  for (let i = 0; i < 100; i++) assert.equal(client.send(msg), 'queued');
  assert.equal(client.send(msg), 'dropped');
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/channel-ask.test.ts test/channel-guidance.test.ts test/hub-client.test.ts`
Expected: FAIL — `ask` is an unknown tool, the guidance and description tests do not find `ask`, and `send` returns `undefined`.

- [ ] **Step 3: Write the tool module**

Create `src/channel/ask.ts`:

````ts
import { parseQuestionRequest } from '../shared/questions.js';
import type { QuestionRequest } from '../shared/types.js';

export const ASK_LIMITS = { questions: 4, minOptions: 2, maxOptions: 6 } as const;

export const ASK_TOOL = {
  name: 'ask',
  description:
    'Ask the user a question they can answer by picking from a few options. It shows in the dashboard conversation and on Telegram with a button per option (and a box for their own answer unless allowOther is false), and sets your status to waiting_input. It returns at once; keep working on anything that does not depend on the answer. The answer arrives later as a channel message starting with "Answer to your question" or "Answers to your questions". For an open question with no options, use reply instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      context: { type: 'string', description: 'Markdown shown above the questions: what you found and why you ask.' },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: ASK_LIMITS.questions,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Short label for the question, up to 40 characters.' },
            question: { type: 'string', description: 'The question in full (markdown).' },
            options: {
              type: 'array',
              minItems: ASK_LIMITS.minOptions,
              maxItems: ASK_LIMITS.maxOptions,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Button text, which is also the answer you get back.' },
                  description: { type: 'string', description: 'One line under the button explaining the option.' },
                },
                required: ['label'],
              },
            },
            allowOther: { type: 'boolean', description: 'Let the user type an answer of their own (default true).' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

type AskResult = { ok: true; request: QuestionRequest } | { ok: false; error: string };

export function askRequest(args: unknown, sessionId: string, requestId: string, now = Date.now()): AskResult {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const list = a.questions;
  if (!Array.isArray(list) || list.length < 1 || list.length > ASK_LIMITS.questions) {
    return { ok: false, error: `questions must list 1 to ${ASK_LIMITS.questions} questions` };
  }
  for (const [i, q] of list.entries()) {
    if (!q || typeof q !== 'object') return { ok: false, error: `question ${i + 1} must be an object` };
    const options = (q as { options?: unknown }).options;
    if (options !== undefined && options !== null && (!Array.isArray(options) || options.length < ASK_LIMITS.minOptions || options.length > ASK_LIMITS.maxOptions)) {
      return { ok: false, error: `question ${i + 1} needs ${ASK_LIMITS.minOptions} to ${ASK_LIMITS.maxOptions} options, or none for a free-text answer` };
    }
  }
  return parseQuestionRequest({
    sessionId,
    requestId,
    timestamp: now,
    context: a.context,
    questions: list.map((q, i) => ({ ...(q as object), id: `q${i + 1}` })),
  });
}

export function askResultText(requestId: string, delivery: 'sent' | 'queued'): string {
  const sent = `Question sent (id ${requestId}). It shows in the dashboard conversation and on Telegram with buttons. Keep working on anything that does not depend on the answer; the answer arrives as a channel message starting with "Answer to your question" or "Answers to your questions".`;
  return delivery === 'queued'
    ? `${sent} The hub is not connected right now, so the question is queued and shown once it reconnects. If the answer is urgent, also ask in the terminal.`
    : sent;
}

export const ASK_DROPPED = 'The hub is not connected and its queue is full, so the question was not sent. Ask in the terminal or with reply.';
````

- [ ] **Step 4: Report the send result**

In `src/channel/hub-client.ts`:

Edit 1 of 1 — replace:

````ts
    }
  }

  send(msg: ChannelMessage): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      if (this.queue.length < 100) {
        this.queue.push(msg);
      }
      logger.debug('Hub not connected, message queued');
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
````

with:

````ts
    }
  }

  send(msg: ChannelMessage): 'sent' | 'queued' | 'dropped' {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return 'sent';
    }
    if (this.queue.length >= 100) {
      logger.debug('Hub not connected and the queue is full, message dropped');
      return 'dropped';
    }
    this.queue.push(msg);
    logger.debug('Hub not connected, message queued');
    return 'queued';
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
````

- [ ] **Step 5: Add the tool and the answer handling to the channel server**

In `src/channel/server.ts`:

Edit 1 of 7 — replace:

````ts
import { loadConfig } from '../shared/config.js';
import { HubClient } from './hub-client.js';
import { readPeerName } from './peer-name.js';
import type { SessionStatus, NotifyLevel } from '../shared/types.js';

const sessionId = randomUUID();
````

with:

````ts
import { loadConfig } from '../shared/config.js';
import { HubClient } from './hub-client.js';
import { readPeerName } from './peer-name.js';
import { ASK_DROPPED, ASK_TOOL, askRequest, askResultText } from './ask.js';
import { answerText } from '../shared/questions.js';
import type { SessionStatus, NotifyLevel } from '../shared/types.js';

const sessionId = randomUUID();
````

Edit 2 of 7 — replace:

````ts

STATUS: Call status("working") before starting a long task, status("waiting_input") when blocked on user input, status("idle") when finished responding.

QUESTIONS: When you need the user's decision or answer, send the whole question with reply: the context, the options and your recommendation. Then call status("waiting_input"). Never put a question only in notify: a notification is not part of the session's conversation, so the user has no place there to read the context and answer. reply already reaches the dashboard conversation and, where enabled, the desktop and Telegram.

NOTIFICATIONS:
- Use notify only for key events that need no answer: task completion and errors. Not for intermediate steps, simple acknowledgments or questions.
````

with:

````ts

STATUS: Call status("working") before starting a long task, status("waiting_input") when blocked on user input, status("idle") when finished responding.

QUESTIONS: When the user can answer by picking from a few options, use ask: it shows the question with buttons in the dashboard conversation and on Telegram, and sets waiting_input for you. Its answer arrives later as a channel message starting with "Answer to your question" or "Answers to your questions". For an open question, send the whole question with reply (the context, what you need, your recommendation) and call status("waiting_input"). Never put a question only in notify: a notification is not part of the session's conversation, so the user has no place there to read the context and answer.

NOTIFICATIONS:
- Use notify only for key events that need no answer: task completion and errors. Not for intermediate steps, simple acknowledgments or questions.
````

Edit 3 of 7 — replace:

````ts
    {
      name: 'notify',
      description:
        'Send a desktop notification to the user for an event that needs no answer, such as a finished task or an error. It appears as a system toast/popup and in the dashboard\'s notification list, not in the session\'s conversation. To ask the user something, use reply instead.',
      inputSchema: {
        type: 'object' as const,
        properties: {
````

with:

````ts
    {
      name: 'notify',
      description:
        'Send a desktop notification to the user for an event that needs no answer, such as a finished task or an error. It appears as a system toast/popup and in the dashboard\'s notification list, not in the session\'s conversation. To ask the user something, use ask or reply instead.',
      inputSchema: {
        type: 'object' as const,
        properties: {
````

Edit 4 of 7 — replace:

````ts
    {
      name: 'reply',
      description:
        'Send a message to the web dashboard. Use this to communicate status updates, results, questions that need the user\'s answer, or any information the user should see in the monitoring dashboard. It appears in the session\'s conversation and, where enabled, is also forwarded as a desktop and Telegram notification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
````

with:

````ts
    {
      name: 'reply',
      description:
        'Send a message to the web dashboard. Use this to communicate status updates, results, open questions that need the user\'s answer (use ask when they can pick from options), or any information the user should see in the monitoring dashboard. It appears in the session\'s conversation and, where enabled, is also forwarded as a desktop and Telegram notification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
````

Edit 5 of 7 — replace:

````ts
        required: ['content'],
      },
    },
    {
      name: 'status',
      description:
````

with:

````ts
        required: ['content'],
      },
    },
    ASK_TOOL,
    {
      name: 'status',
      description:
````

Edit 6 of 7 — replace:

````ts
      };
    }

    case 'status': {
      const status = args?.status as SessionStatus;
      logger.info(`Status update: ${status}`);
````

with:

````ts
      };
    }

    case 'ask': {
      const requestId = randomUUID();
      const built = askRequest(args, sessionId, requestId);
      if (!built.ok) {
        return { content: [{ type: 'text', text: `Question not sent: ${built.error}` }], isError: true };
      }
      const delivery = hubClient.send({ type: 'question', ...built.request });
      if (delivery === 'dropped') {
        return { content: [{ type: 'text', text: ASK_DROPPED }], isError: true };
      }
      hubClient.send({ type: 'status', sessionId, status: 'waiting_input' });
      logger.info(`Ask [${requestId}]: ${built.request.questions.length} question(s)`);
      return { content: [{ type: 'text', text: askResultText(requestId, delivery) }] };
    }

    case 'status': {
      const status = args?.status as SessionStatus;
      logger.info(`Status update: ${status}`);
````

Edit 7 of 7 — replace:

````ts
          meta: { sender: 'dashboard', timestamp: String(Date.now()), imagePath: msg.imagePath, mimeType: msg.mimeType },
        },
      });
    } else if (msg.type === 'permission_response' && msg.sessionId === sessionId) {
      logger.info(`Permission verdict [${msg.requestId}]: ${msg.behavior}`);
      await server.notification({
````

with:

````ts
          meta: { sender: 'dashboard', timestamp: String(Date.now()), imagePath: msg.imagePath, mimeType: msg.mimeType },
        },
      });
    } else if (msg.type === 'question_answer' && msg.sessionId === sessionId) {
      logger.info(`Answer for question ${msg.requestId}`);
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: answerText(msg.questions ?? [], msg.answers),
            meta: { sender: msg.source ?? 'dashboard', timestamp: String(Date.now()), questionId: msg.requestId },
          },
        });
        hubClient.send({ type: 'question_delivery', sessionId, requestId: msg.requestId, ok: true });
      } catch (err) {
        hubClient.send({ type: 'question_delivery', sessionId, requestId: msg.requestId, ok: false, reason: (err as Error).message });
      }
    } else if (msg.type === 'permission_response' && msg.sessionId === sessionId) {
      logger.info(`Permission verdict [${msg.requestId}]: ${msg.behavior}`);
      await server.notification({
````

- [ ] **Step 6: Run the tests and the type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/channel-ask.test.ts test/channel-guidance.test.ts test/hub-client.test.ts` → 15 pass (5 + 5 + 5).
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 7: Commit**

```bash
git add src/channel/ask.ts src/channel/hub-client.ts src/channel/server.ts test/channel-ask.test.ts test/channel-guidance.test.ts test/hub-client.test.ts
git commit -m "feat(channel): an ask tool sends questions with options and hands the answer to the session as a channel message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Codex questions reach the dashboard at once

**Files:**
- Modify: `src/codex/mapping.ts` (`AgentMessage` fields, `asyncQuestions`, `userInputShape`), `src/codex/adapter.ts` (`asked`, `askIfQuestion`, turn completion, `question_answer`, reporting deliveries, `requestUserInput` log)
- Test: `test/codex-questions.test.ts` (port 7985)

**Interfaces:**
- Consumes (Task 1): `parseQuestions`, `QUESTION_LIMITS`, `answerText`, `isRequestId`. From Task 2: the Hub's question routing (the tests run a real Hub).
- Produces:
  - `asyncQuestions(item: AgentMessage)` → `{ questions, context? } | null`.
    - Questions are `q1…`, `allowOther: true`, and options come from the strings.
    - `context` is the text minus the lines that equal a question title or list an option (`- X`, `* X`, `1. X`, `1) X`), clipped to 20000 characters.
    - It returns `null` when the questions do not parse.
  - `userInputShape(params)` → JSON with question ids, headers, 200-character question text, option labels, `isOther`, `isSecret` and `isBlocking`, cut at 2000 characters.
  - Adapter behaviour:
    - A completed `agentMessage` whose questions parse is sent at once as `question` with `requestId: codex-q:<itemId>`.
    - At turn end, questions found only in `turn.items` are sent once. Asked items are left out of `finalAnswer`, and a turn with nothing else sends no reply.
    - A `question_answer` is delivered like a dashboard message (steer if a turn runs, otherwise start), with no `Queued` or `Not delivered` notice. The result goes back as `question_delivery`.

- [ ] **Step 1: Write the failing tests**

Create `test/codex-questions.test.ts`:

````ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { CodexAdapter } from '../src/codex/adapter.js';
import { asyncQuestions, userInputShape } from '../src/codex/mapping.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

const PORT = 7985;
const TOKEN = 'codex-question-test';
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
let hub: HubServer;
let daemon: FakeDaemon | undefined;
let adapter: CodexAdapter | undefined;

before(async () => {
  hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
  (hub as any).notifier.notifyWithSession = async () => {};
  await hub.start();
});
after(async () => { await hub.stop(); });
afterEach(async () => {
  await adapter?.stop();
  adapter = undefined;
  await daemon?.stop();
  daemon = undefined;
  await until(async () => !(await sessions()).some((s) => s.id.startsWith('codex:')));
});

const active = { type: 'active', activeFlags: [] };

function thread(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: `Thread ${id}`, preview: '', cwd: 'C:\\w\\proj', status: { type: 'idle' }, parentThreadId: null, ephemeral: false, ...extra };
}

async function sessions(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return ((await res.json()) as any).sessions;
}

const session = (id: string) => until(async () => (await sessions()).find((s) => s.id === id));

async function startAdapter(threads: any[], setup?: (d: FakeDaemon) => void): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  await d.start();
  d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
  d.handle('thread/read', (p) => ({ thread: threads.find((x) => x.id === p.threadId) }));
  d.handle('thread/resume', () => ({}));
  d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
  d.handle('turn/start', () => ({ turn: { id: 'turn-new', status: 'inProgress', items: [] } }));
  d.handle('thread/turns/list', () => ({ data: [], nextCursor: null }));
  d.handle('turn/steer', (p) => ({ turnId: p.expectedTurnId }));
  setup?.(d);
  adapter = new CodexAdapter({ command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200 });
  adapter.start();
  return d;
}

function openDashboard(): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
    const inbox: any[] = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

// The agentMessage Codex 0.160.1 sent in the 2026-10-06 probe.
const asking = (id = 'call_1', text = 'Which color do you prefer?\n- Red\n- Blue\n\nWhat name should I use?') => ({
  type: 'agentMessage',
  id,
  text,
  phase: 'final_answer',
  memoryCitation: null,
  delivery: 'async',
  questions: [{ title: 'Which color do you prefer?', options: ['Red', 'Blue'] }, { title: 'What name should I use?', options: null }],
});

const expectedQuestions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: true },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];

const of = (inbox: any[], type: string, sessionId = 'codex:t1') => inbox.filter((m) => m.type === type && m.sessionId === sessionId);

test('the card leaves out the lines that only repeat the questions and keeps the rest as context', () => {
  assert.deepEqual(asyncQuestions(asking()), { questions: expectedQuestions });
  const withIntro = asyncQuestions(asking('x', 'Two quick things before I plan.\n\nWhich color do you prefer?\n1. Red\n2) Blue\n\nWhat name should I use?'));
  assert.equal(withIntro?.context, 'Two quick things before I plan.');
  assert.equal(asyncQuestions({ text: 'plain', phase: 'final_answer' }), null);
  assert.equal(asyncQuestions({ ...asking(), questions: [{ title: '', options: null }] } as any), null);
  assert.equal(asyncQuestions({ ...asking(), questions: [{ title: 'Pick', options: ['A', 'A'] }] } as any), null);
});

test('a question from Codex reaches the dashboard at once, before the turn ends', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking() });
    const [q] = await until(() => of(dash.inbox, 'question').length && of(dash.inbox, 'question'));
    assert.equal(q.requestId, 'codex-q:call_1');
    assert.equal(q.context, undefined);
    assert.deepEqual(q.questions, expectedQuestions);
  } finally {
    dash.ws.close();
  }
});

test('the question is not sent again as a reply when the turn ends, while a later answer still is', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_3') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: { type: 'agentMessage', id: 'm2', text: 'You prefer Blue.', phase: 'final_answer' } });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_3')], error: null } });
    const reply = await until(() => of(dash.inbox, 'reply_from_session')[0]);
    assert.equal(reply.content, 'You prefer Blue.');
    assert.equal(of(dash.inbox, 'question').length, 1);
  } finally {
    dash.ws.close();
  }
});

test('a turn that only asked ends without a reply', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_4') });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_4')], error: null } });
    await until(() => of(dash.inbox, 'question').length);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(of(dash.inbox, 'reply_from_session'), []);
  } finally {
    dash.ws.close();
  }
});

test('a question seen only in the turn summary is sent once when the turn ends', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_9')], error: null } });
    const [q] = await until(() => of(dash.inbox, 'question').length && of(dash.inbox, 'question'));
    assert.equal(q.requestId, 'codex-q:call_9');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(of(dash.inbox, 'question').length, 1);
    assert.deepEqual(of(dash.inbox, 'reply_from_session'), []);
  } finally {
    dash.ws.close();
  }
});

test('a question Codex shaped wrongly falls back to the old reply', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const broken = { ...asking(), questions: [{ title: '', options: null }] };
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: broken });
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [], error: null } });
    const reply = await until(() => of(dash.inbox, 'reply_from_session')[0]);
    assert.equal(reply.content, broken.text);
    assert.deepEqual(of(dash.inbox, 'question'), []);
  } finally {
    dash.ws.close();
  }
});

test('an answer is steered into the turn Codex is waiting in and confirmed without a Queued notice', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u1', status: 'inProgress', items: [] }], nextCursor: null }));
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_7') });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_7', answers: { q1: 'Blue', q2: 'Probe' } }));
    const resolved = await until(() => of(dash.inbox, 'question_resolved')[0]);
    assert.deepEqual(resolved, { type: 'question_resolved', sessionId: 'codex:t1', requestId: 'codex-q:call_7', state: 'answered', answers: { q1: 'Blue', q2: 'Probe' }, source: 'dashboard' });
    assert.deepEqual(d.calls('turn/steer')[0].params, {
      threadId: 't1',
      expectedTurnId: 'u1',
      input: [{ type: 'text', text: '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe' }],
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(of(dash.inbox, 'notification'), []);
  } finally {
    dash.ws.close();
  }
});

test('an answer after the turn ended starts a new turn', async () => {
  const d = await startAdapter([thread('t1')]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed', items: [asking('call_8')], error: null } });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_8', answers: { q1: 'Red', q2: 'Ann' } }));
    await until(() => of(dash.inbox, 'question_resolved').length);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Red\n- What name should I use? → Ann');
  } finally {
    dash.ws.close();
  }
});

test('an answer while Codex waits for an approval reopens the card with the reason and sends nothing', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_9a') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await until(async () => (await sessions()).find((s) => s.id === 'codex:t1' && s.status === 'waiting_input'));
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_9a', answers: { q1: 'Blue', q2: 'P' } }));
    const rejected = await until(() => of(dash.inbox, 'question_rejected')[0]);
    assert.equal(rejected.reason, 'Codex is waiting for an approval or input');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(of(dash.inbox, 'notification'), []);
    assert.equal(d.calls('turn/steer').length + d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a steer the daemon refuses reopens the card with the error', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => ({ data: [{ id: 'u1', status: 'inProgress', items: [] }], nextCursor: null }));
    dm.handle('turn/steer', () => { throw new Error('expected turn u1 is no longer running'); });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_10') });
    await until(() => of(dash.inbox, 'question').length);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_10', answers: { q1: 'Blue', q2: 'P' } }));
    const rejected = await until(() => of(dash.inbox, 'question_rejected')[0]);
    assert.equal(rejected.reason, 'Codex rejected the message: expected turn u1 is no longer running');
  } finally {
    dash.ws.close();
  }
});

test('requestUserInput still points to Codex and logs only its shape', async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, 'warn', (msg: string) => { warnings.push(msg); });
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.serverRequest(7, 'item/tool/requestUserInput', {
      threadId: 't1', turnId: 'u3', itemId: 'i1', isBlocking: true,
      questions: [{ id: 'pw', header: 'Login', question: `Password? ${'x'.repeat(300)}`, isOther: false, isSecret: true, options: null }],
    });
    const n = await until(() => of(dash.inbox, 'notification')[0]);
    assert.match(n.message, /Handle it in Codex/);
    const line = warnings.find((w) => w.startsWith('Codex requestUserInput not relayed: '));
    assert.ok(line, 'the requestUserInput shape is logged');
    const shape = JSON.parse(line.slice('Codex requestUserInput not relayed: '.length));
    assert.deepEqual(shape, { isBlocking: true, questions: [{ id: 'pw', header: 'Login', question: `Password? ${'x'.repeat(190)}`, options: null, isOther: false, isSecret: true }] });
  } finally {
    dash.ws.close();
  }
});

test('the logged shape stays within 2000 characters', () => {
  const many = { questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, question: 'y'.repeat(200) })) };
  assert.equal(userInputShape(many).length, 2000);
});

test('a question stays open when Codex stops the turn, and its answer starts a new turn', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('item/completed', { threadId: 't1', turnId: 'u1', completedAtMs: 0, item: asking('call_11') });
    await until(() => of(dash.inbox, 'question').length);
    d.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'interrupted', items: [], error: null } });
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const stopped = await until(() => of(dash.inbox, 'notification')[0]);
    assert.equal(stopped.title, 'Codex task stopped');
    assert.deepEqual(of(dash.inbox, 'question_resolved'), []);
    dash.ws.send(JSON.stringify({ type: 'question_answer', sessionId: 'codex:t1', requestId: 'codex-q:call_11', answers: { q1: 'Red', q2: 'Ann' } }));
    await until(() => of(dash.inbox, 'question_resolved').length);
    assert.equal(d.calls('turn/start')[0].params.input[0].text, '[claude-alarm · Dashboard] Answers to your questions:\n- Which color do you prefer? → Red\n- What name should I use? → Ann');
  } finally {
    dash.ws.close();
  }
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/codex-questions.test.ts`
Expected: FAIL — the import of `asyncQuestions` from `../src/codex/mapping.js` is missing.

- [ ] **Step 3: Map Codex questions**

In `src/codex/mapping.ts`:

Edit 1 of 3 — replace:

````ts
import type { MessageSource, SessionStatus } from '../shared/types.js';

export type CodexThreadStatus =
  | { type: 'notLoaded' | 'idle' | 'systemError' }
````

with:

````ts
import type { MessageSource, Question, SessionStatus } from '../shared/types.js';
import { QUESTION_LIMITS, parseQuestions } from '../shared/questions.js';

export type CodexThreadStatus =
  | { type: 'notLoaded' | 'idle' | 'systemError' }
````

Edit 2 of 3 — replace:

````ts
  ephemeral?: boolean;
}

export interface AgentMessage {
  text: string;
  phase?: string | null;
}

const TITLE_MAX = 30;
````

with:

````ts
  ephemeral?: boolean;
}

export interface AsyncQuestion {
  title: string;
  options: string[] | null;
}

export interface AgentMessage {
  id?: string;
  text: string;
  phase?: string | null;
  delivery?: string | null;
  questions?: AsyncQuestion[] | null;
}

const TITLE_MAX = 30;
````

Edit 3 of 3 — replace:

````ts
  const s = input.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;
}
````

with:

````ts
  const s = input.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;
}

const LIST_LINE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

// Codex 0.160 asks with an agentMessage whose `questions` repeat what its text already lists; the card shows only the rest.
export function asyncQuestions(item: AgentMessage): { questions: Question[]; context?: string } | null {
  if (!Array.isArray(item.questions) || item.questions.length === 0) return null;
  const parsed = parseQuestions(item.questions.map((q, i) => ({
    id: `q${i + 1}`,
    question: q?.title,
    options: Array.isArray(q?.options) ? q.options.map((label) => ({ label })) : null,
    allowOther: true,
  })));
  if (!parsed.ok) return null;
  const titles = new Set(parsed.questions.map((q) => q.question));
  const labels = new Set(parsed.questions.flatMap((q) => (q.options ?? []).map((o) => o.label)));
  const rest = (item.text ?? '').split('\n').filter((line) => {
    if (titles.has(line.trim())) return false;
    const listed = LIST_LINE.exec(line);
    return !(listed && labels.has(listed[1].trim()));
  });
  const context = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!context) return { questions: parsed.questions };
  const clipped = context.length > QUESTION_LIMITS.context ? `${context.slice(0, QUESTION_LIMITS.context - 1)}…` : context;
  return { questions: parsed.questions, context: clipped };
}

// Logs what a request_user_input asked without the full prompt text, so the format can be relayed once it is seen.
export function userInputShape(params: any): string {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const shape = {
    isBlocking: params?.isBlocking,
    questions: questions.map((q: any) => ({
      id: q?.id,
      header: q?.header,
      question: typeof q?.question === 'string' ? q.question.slice(0, 200) : q?.question,
      options: Array.isArray(q?.options) ? q.options.map((o: any) => o?.label) : q?.options,
      isOther: q?.isOther,
      isSecret: q?.isSecret,
    })),
  };
  return JSON.stringify(shape).slice(0, 2000);
}
````

- [ ] **Step 4: Relay questions and deliver answers in the adapter**

In `src/codex/adapter.ts`:

Edit 1 of 11 — replace:

````ts
import { RpcClient, type RpcId } from './rpc.js';
import { approvalView, fileChanges, type ApprovalChoice, type ApprovalView, type FileChange } from './approvals.js';
import {
  cleanFolder,
  codexSessionId,
  finalAnswer,
  hubStatus,
  isTrackable,
  threadTitle,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';

export type FirstConnect =
  | { connected: true; userAgent?: string }
````

with:

````ts
import { RpcClient, type RpcId } from './rpc.js';
import { approvalView, fileChanges, type ApprovalChoice, type ApprovalView, type FileChange } from './approvals.js';
import {
  asyncQuestions,
  cleanFolder,
  codexSessionId,
  finalAnswer,
  hubStatus,
  isTrackable,
  threadTitle,
  userInputShape,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';
import { answerText, isRequestId } from '../shared/questions.js';

export type FirstConnect =
  | { connected: true; userAgent?: string }
````

Edit 2 of 11 — replace:

````ts
  releaseTimer?: ReturnType<typeof setTimeout>;
  unrelayed: boolean;
  files: Map<string, FileChange[]>;
}

// Requests a person must answer that claude-alarm cannot relay; the user is pointed back to Codex.
const USER_REQUESTS = new Set(['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
````

with:

````ts
  releaseTimer?: ReturnType<typeof setTimeout>;
  unrelayed: boolean;
  files: Map<string, FileChange[]>;
  // Items relayed as questions, by item id, with the turn they belong to.
  asked: Map<string, string>;
}

type Report = (ok: boolean, reason?: string) => void;

// Requests a person must answer that claude-alarm cannot relay; the user is pointed back to Codex.
const USER_REQUESTS = new Set(['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
````

Edit 3 of 11 — replace:

````ts
        turns: new Map(),
        unrelayed: false,
        files: new Map(),
      });
      hub.onMessage((msg) => this.onHubMessage(thread.id, msg));
      hub.connect();
````

with:

````ts
        turns: new Map(),
        unrelayed: false,
        files: new Map(),
        asked: new Map(),
      });
      hub.onMessage((msg) => this.onHubMessage(thread.id, msg));
      hub.connect();
````

Edit 4 of 11 — replace:

````ts
  private collect(threadId: string, turnId: string, item: AgentMessage): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    const list = t.turns.get(turnId) ?? [];
    list.push({ text: item.text, phase: item.phase });
    t.turns.set(turnId, list);
  }

  private onTurnCompleted(
    threadId: string,
    turn: { id: string; status: string; error?: { message: string } | null; items?: Array<{ type: string } & AgentMessage> },
````

with:

````ts
  private collect(threadId: string, turnId: string, item: AgentMessage): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    this.askIfQuestion(t, turnId, item);
    const list = t.turns.get(turnId) ?? [];
    list.push({ id: item.id, text: item.text, phase: item.phase });
    t.turns.set(turnId, list);
  }

  // Codex waits (sleep) for the answer inside its turn, so the question goes out now rather than with the turn's reply.
  private askIfQuestion(t: Tracked, turnId: string, item: AgentMessage): void {
    if (typeof item.id !== 'string' || t.asked.has(item.id)) return;
    const requestId = `codex-q:${item.id}`;
    const asked = isRequestId(requestId) ? asyncQuestions(item) : null;
    if (!asked) return;
    t.asked.set(item.id, turnId);
    t.hub.send({
      type: 'question',
      sessionId: codexSessionId(t.thread.id),
      requestId,
      ...(asked.context ? { context: asked.context } : {}),
      questions: asked.questions,
      timestamp: Date.now(),
    });
  }

  private onTurnCompleted(
    threadId: string,
    turn: { id: string; status: string; error?: { message: string } | null; items?: Array<{ type: string } & AgentMessage> },
````

Edit 5 of 11 — replace:

````ts
    const collected = t.turns.get(turn.id) ?? [];
    t.turns.delete(turn.id);
    t.files.clear();
    // The daemon announces name changes but not preview changes, so a title taken from the folder is re-read once text exists.
    if (!t.thread.name?.trim() && !t.thread.preview?.trim()) void this.refresh(threadId);
    if (t.thread.status.type !== 'active') void this.want(threadId, false);
````

with:

````ts
    const collected = t.turns.get(turn.id) ?? [];
    t.turns.delete(turn.id);
    t.files.clear();
    // turn/completed may carry only a summary of the items, so prefer what was collected live.
    const fromTurn = (turn.items ?? []).filter((i) => i.type === 'agentMessage');
    for (const item of fromTurn) this.askIfQuestion(t, turn.id, item);
    const unasked = (collected.length ? collected : fromTurn).filter((m) => !(m.id && t.asked.has(m.id)));
    for (const [itemId, turnId] of t.asked) if (turnId === turn.id) t.asked.delete(itemId);
    // The daemon announces name changes but not preview changes, so a title taken from the folder is re-read once text exists.
    if (!t.thread.name?.trim() && !t.thread.preview?.trim()) void this.refresh(threadId);
    if (t.thread.status.type !== 'active') void this.want(threadId, false);
````

Edit 6 of 11 — replace:

````ts
      this.notify(threadId, 'Codex task stopped', 'The task was interrupted.', 'info');
      return;
    }
    // turn/completed may carry only a summary of the items, so prefer what was collected live.
    const fromTurn = (turn.items ?? []).filter((i) => i.type === 'agentMessage');
    const text = finalAnswer(collected.length ? collected : fromTurn);
    if (text) t.hub.send({ type: 'reply', sessionId: codexSessionId(threadId), content: text });
  }
````

with:

````ts
      this.notify(threadId, 'Codex task stopped', 'The task was interrupted.', 'info');
      return;
    }
    const text = finalAnswer(unasked);
    if (text) t.hub.send({ type: 'reply', sessionId: codexSessionId(threadId), content: text });
  }
````

Edit 7 of 11 — replace:

````ts
      this.answer(threadId, msg.requestId, msg.choiceId);
    } else if (msg.type === 'codex_close') {
      void this.close(threadId);
    }
  }

  // One message at a time per conversation, so a message right behind another sees the turn the first one started.
  private enqueue(threadId: string, build: () => Promise<UserInput[]>, source?: MessageSource): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.sending = t.sending
      .then(() => this.deliver(t, build, source))
      .catch((err) => logger.warn(`Codex delivery for ${threadId} failed: ${(err as Error).message}`));
  }

  private async deliver(t: Tracked, build: () => Promise<UserInput[]>, source?: MessageSource): Promise<void> {
    const threadId = t.thread.id;
    if (this.threads.get(threadId) !== t) return;
    // A steer is accepted while an approval is pending but read only after it is answered, which reads like an answer.
    if (this.waitingForAnswer(t)) {
      this.refuseWhileWaiting(threadId);
      return;
    }
    let input: UserInput[];
````

with:

````ts
      this.answer(threadId, msg.requestId, msg.choiceId);
    } else if (msg.type === 'codex_close') {
      void this.close(threadId);
    } else if (msg.type === 'question_answer') {
      const text = answerText(msg.questions ?? [], msg.answers);
      this.enqueue(threadId, async () => textInput(text, msg.source), msg.source, (ok, reason) => {
        this.threads.get(threadId)?.hub.send({ type: 'question_delivery', sessionId: codexSessionId(threadId), requestId: msg.requestId, ok, ...(reason ? { reason } : {}) });
      });
    }
  }

  // One message at a time per conversation, so a message right behind another sees the turn the first one started.
  // With report, the outcome goes back to whoever is waiting for it (an answer card) instead of a notice.
  private enqueue(threadId: string, build: () => Promise<UserInput[]>, source?: MessageSource, report?: Report): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.sending = t.sending
      .then(() => this.deliver(t, build, source, report))
      .catch((err) => logger.warn(`Codex delivery for ${threadId} failed: ${(err as Error).message}`));
  }

  private async deliver(t: Tracked, build: () => Promise<UserInput[]>, source?: MessageSource, report?: Report): Promise<void> {
    const threadId = t.thread.id;
    if (this.threads.get(threadId) !== t) return;
    // A steer is accepted while an approval is pending but read only after it is answered, which reads like an answer.
    if (this.waitingForAnswer(t)) {
      this.refuseWhileWaiting(threadId, report);
      return;
    }
    let input: UserInput[];
````

Edit 8 of 11 — replace:

````ts
      input = await build();
    } catch (err) {
      logger.debug(`Codex input for ${threadId} could not be built: ${(err as Error).message}`);
      this.notify(threadId, 'Not delivered', 'The image could not be read here, so it was not delivered. Codex may be running on another PC.', 'warning');
      return;
    }
    if (this.threads.get(threadId) !== t) return;
````

with:

````ts
      input = await build();
    } catch (err) {
      logger.debug(`Codex input for ${threadId} could not be built: ${(err as Error).message}`);
      if (report) report(false, 'the message could not be built');
      else this.notify(threadId, 'Not delivered', 'The image could not be read here, so it was not delivered. Codex may be running on another PC.', 'warning');
      return;
    }
    if (this.threads.get(threadId) !== t) return;
````

Edit 9 of 11 — replace:

````ts
      // An approval can start while the input is built and the turn looked up; the check at the top cannot see it.
      if (this.waitingForAnswer(t)) {
        this.abandonDelivery(t, wasUnrelayed);
        this.refuseWhileWaiting(threadId);
        return;
      }
      if (unsubscribed) t.unrelayed = true;
      if (running) {
        await rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info', source);
        return;
      }
      await rpc.request('turn/start', { threadId, input });
    } catch (err) {
      this.abandonDelivery(t, wasUnrelayed);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }
````

with:

````ts
      // An approval can start while the input is built and the turn looked up; the check at the top cannot see it.
      if (this.waitingForAnswer(t)) {
        this.abandonDelivery(t, wasUnrelayed);
        this.refuseWhileWaiting(threadId, report);
        return;
      }
      if (unsubscribed) t.unrelayed = true;
      if (running) {
        await rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        if (report) report(true);
        else this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info', source);
        return;
      }
      await rpc.request('turn/start', { threadId, input });
      report?.(true);
    } catch (err) {
      this.abandonDelivery(t, wasUnrelayed);
      if (report) report(false, `Codex rejected the message: ${(err as Error).message}`);
      else this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }
````

Edit 10 of 11 — replace:

````ts
    return false;
  }

  private refuseWhileWaiting(threadId: string): void {
    this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
  }

  // The list is unavailable before a new conversation's first turn; starting a turn is safe then, since turn/start steers a running turn.
````

with:

````ts
    return false;
  }

  private refuseWhileWaiting(threadId: string, report?: Report): void {
    if (report) report(false, 'Codex is waiting for an approval or input');
    else this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
  }

  // The list is unavailable before a new conversation's first turn; starting a turn is safe then, since turn/start steers a running turn.
````

Edit 11 of 11 — replace:

````ts
    }
    if (!t || !view) {
      if (t && (broken || USER_REQUESTS.has(method))) {
        this.waitingInCodex(t.thread.id);
      } else {
        logger.debug(`Ignoring Codex server request ${method}`);
````

with:

````ts
    }
    if (!t || !view) {
      if (t && (broken || USER_REQUESTS.has(method))) {
        if (method === 'item/tool/requestUserInput') logger.warn(`Codex requestUserInput not relayed: ${userInputShape(params)}`);
        this.waitingInCodex(t.thread.id);
      } else {
        logger.debug(`Ignoring Codex server request ${method}`);
````

- [ ] **Step 5: Run the tests, the existing adapter tests, and the type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/codex-questions.test.ts` → 13 pass.
Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=120000 test/codex-adapter.test.ts test/codex-mapping.test.ts` → all pass (73).
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/codex/mapping.ts src/codex/adapter.ts test/codex-questions.test.ts
git commit -m "feat(codex): a Codex question reaches the dashboard when it is asked and the answer goes back into the waiting turn" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Telegram questions

**Files:**
- Modify: `src/hub/telegram.ts`, `src/hub/server.ts` (calls into the bot, `onQuestionAnswer`)
- Test: `test/telegram-questions.test.ts` (new), `test/hub-questions.test.ts` (one test appended)

**Interfaces:**
- Consumes (Task 1): `readAnswers` and the types. From Task 2: `answerQuestion`, `announceQuestion`, `finishQuestionDelivery`, `wireTelegram`.
- Produces:
  - **Bot methods:**
    - `sendQuestion(sessionId, sessionLabel, request)`
    - `resolveQuestion(sessionId, requestId, state, answers?, source?)`
    - `reopenQuestion(sessionId, requestId, reason)`, which acts only while the bot itself is sending that request
    - Callback `onQuestionAnswer(sessionId, requestId, answers)` → `'ok'` or a reason
  - **Private helpers:** `rememberSession`, `fit(render, body, max?)` (`fitNotification` now uses it, same behaviour). `editMessageText` takes an optional `replyMarkup`.
  - **Behaviour:**
    - Buttons use `qa:<16 hex>` tokens. Each pick edits that message to `☑️ Selected` and keeps the buttons.
    - A text reply to a question message that allows typing is that question's answer, checked before the normal reply routing.
    - When every question has an answer, the bot calls `onQuestionAnswer`. If the Hub refuses, the bot sends `Not delivered: <reason>` and stays open.
    - Results rewrite every question message and remove the buttons.
    - At most 100 requests are kept.
    - The heading message of a multi-question request is remembered for reply routing.
  - **Hub:** `case 'question'` calls `sendQuestion`; `announceQuestion` calls `resolveQuestion`; a failed delivery calls `reopenQuestion`; `wireTelegram` sets `onQuestionAnswer` to `answerQuestion(…, 'telegram')`.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram-questions.test.ts`:

````ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, visibleLength } from '../src/hub/telegram.js';
import type { QuestionRequest } from '../src/shared/types.js';

function setup(t: any, outcome = 'ok') {
  const calls: Array<{ api: string; body: any }> = [];
  let nextId = 100;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const api = String(url).split('/').pop()!;
    calls.push({ api, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: api === 'sendMessage' ? nextId++ : 0 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const submitted: any[] = [];
  const delivered: string[] = [];
  bot.onQuestionAnswer = (sessionId, requestId, answers) => { submitted.push({ sessionId, requestId, answers }); return outcome; };
  bot.onMessageToSession = (sessionId, content) => { delivered.push(`${sessionId}:${content}`); return true; };
  return { bot, calls, submitted, delivered };
}

const color = { id: 'q1', header: 'Color', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: true };
const name = { id: 'q2', question: 'What name should I use?', options: null, allowOther: true };
const fixed = { id: 'q3', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }], allowOther: false };
const request = (questions: any[], extra: Partial<QuestionRequest> = {}): QuestionRequest =>
  ({ sessionId: 's1', requestId: 'r1', questions, timestamp: 0, ...extra });

const sends = (calls: any[]) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body);
const edits = (calls: any[]) => calls.filter((c) => c.api === 'editMessageText').map((c) => c.body);
const toasts = (calls: any[]) => calls.filter((c) => c.api === 'answerCallbackQuery').map((c) => c.body.text);
const buttonsOf = (body: any) => (body.reply_markup?.inline_keyboard ?? []).flat();
const press = (bot: TelegramBot, data: string, messageId = 100) =>
  (bot as any).handleCallbackQuery({ id: 'cb', data, message: { chat: { id: 111 }, message_id: messageId, text: '' } });
const replyTo = (bot: TelegramBot, messageId: number, text: string) =>
  (bot as any).handleIncomingMessage({ message_id: 999, chat: { id: 111 }, text, reply_to_message: { message_id: messageId } });

test('a single question is one message with the context, a button per option, and a reply hint', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'weekly · proj', request([color], { context: 'Two ways **to** do it.' }));
  const [msg] = sends(calls);
  assert.equal(sends(calls).length, 1);
  assert.match(msg.text, /^❓ <b>Question<\/b> — weekly · proj\n\nTwo ways <b>to<\/b> do it\.\n\n<b>\[Color\]<\/b> Which color do you prefer\?/);
  assert.match(msg.text, /<i>Or reply to this message with your own answer\.<\/i>$/);
  const b = buttonsOf(msg);
  assert.deepEqual(b.map((x: any) => x.text), ['Red', 'Blue']);
  for (const x of b) {
    assert.match(x.callback_data, /^qa:[0-9a-f]{16}$/);
    assert.equal(Buffer.byteLength(x.callback_data) <= 64, true);
  }
});

test('several questions get a heading message, then one numbered message per question', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name, fixed], { context: 'Before I plan.' }));
  const sent = sends(calls);
  assert.equal(sent.length, 4);
  assert.equal(sent[0].text, '❓ <b>Questions (3)</b> — proj\n\nBefore I plan.');
  assert.equal(sent[0].reply_markup, undefined);
  assert.match(sent[1].text, /^<b>1\/3<\/b> <b>\[Color\]<\/b> Which color/);
  assert.match(sent[2].text, /^<b>2\/3<\/b> What name should I use\?\n\n<i>Reply to this message with your answer\.<\/i>$/);
  assert.equal(sent[2].reply_markup, undefined);
  assert.match(sent[3].text, /^<b>3\/3<\/b> Ship it\?$/);
});

test('a button marks the choice and keeps the buttons, so it can be changed until the last answer', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  const [, colorMsg] = sends(calls);
  const [red, blue] = buttonsOf(colorMsg);
  await press(bot, red.callback_data, 101);
  await press(bot, blue.callback_data, 101);
  const [first, second] = edits(calls);
  assert.equal(first.message_id, 101);
  assert.match(first.text, /☑️ <b>Selected:<\/b> Red$/);
  assert.deepEqual(first.reply_markup, colorMsg.reply_markup);
  assert.match(second.text, /☑️ <b>Selected:<\/b> Blue$/);
  assert.deepEqual(toasts(calls), ['Selected', 'Selected']);
  assert.deepEqual(submitted, []);
});

test('a reply to a question message is its typed answer and goes nowhere else; the last answer sends them all', async (t) => {
  const { bot, calls, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  await press(bot, buttonsOf(sends(calls)[1])[1].callback_data, 101);
  await replyTo(bot, 102, '  Probe  ');
  assert.deepEqual(delivered, []);
  assert.deepEqual(submitted, [{ sessionId: 's1', requestId: 'r1', answers: { q1: 'Blue', q2: 'Probe' } }]);
});

test('a typed reply replaces a picked option when the question allows typing', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  await press(bot, buttonsOf(sends(calls)[1])[0].callback_data, 101);
  await replyTo(bot, 101, 'Teal');
  await replyTo(bot, 102, 'Probe');
  assert.deepEqual(submitted[0].answers, { q1: 'Teal', q2: 'Probe' });
});

test('a reply to a question that takes only its buttons goes to the session as a plain message', async (t) => {
  const { bot, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  await replyTo(bot, 100, 'maybe later');
  assert.deepEqual(delivered, ['s1:maybe later']);
  assert.deepEqual(submitted, []);
});

test('the hub refusing the answers says why and leaves the question open to answer again', async (t) => {
  const { bot, calls, submitted } = setup(t, 'the question is already being answered');
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const [yes, no] = buttonsOf(sends(calls)[0]);
  await press(bot, yes.callback_data);
  assert.equal(sends(calls).at(-1).text, 'Not delivered: the question is already being answered');
  assert.deepEqual(toasts(calls), ['Not delivered']);
  await press(bot, no.callback_data);
  assert.equal(submitted.length, 2);
});

test('the result overwrites every question message and retires the buttons', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name]));
  const [red] = buttonsOf(sends(calls)[1]);
  await press(bot, red.callback_data, 101);
  const before = edits(calls).length;
  await bot.resolveQuestion('s1', 'r1', 'answered', { q1: 'Blue', q2: 'Probe' }, 'dashboard');
  const result = edits(calls).slice(before);
  assert.deepEqual(result.map((e) => e.message_id), [101, 102]);
  assert.match(result[0].text, /\n\n✅ <b>Blue<\/b> \(Dashboard\)$/);
  assert.doesNotMatch(result[0].text, /Selected/);
  assert.equal(result[0].reply_markup, undefined);
  assert.match(result[1].text, /\n\n✅ <b>Probe<\/b> \(Dashboard\)$/);
  await press(bot, red.callback_data, 101);
  assert.equal(toasts(calls).at(-1), 'Expired');
});

test('closed and expired results say so, and an answer from Telegram carries no source tag', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'a' }));
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'b' }));
  await bot.sendQuestion('s1', 'proj', request([name], { requestId: 'c' }));
  await bot.resolveQuestion('s1', 'a', 'closed');
  await bot.resolveQuestion('s1', 'b', 'expired');
  await bot.resolveQuestion('s1', 'c', 'answered', { q2: 'Probe' }, 'telegram');
  const [a, b, c] = edits(calls);
  assert.match(a.text, /\n\n<i>Closed — a message was sent instead<\/i>$/);
  assert.match(b.text, /\n\n⌛ <b>Expired<\/b>$/);
  assert.match(c.text, /\n\n✅ <b>Probe<\/b>$/);
});

test('a result that lands while the messages are still being sent is applied as each one goes out', async (t) => {
  const { bot, calls } = setup(t);
  const sending = bot.sendQuestion('s1', 'proj', request([color, name]));
  await bot.resolveQuestion('s1', 'r1', 'expired');
  await sending;
  const sent = sends(calls);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].reply_markup, undefined);
  assert.equal(edits(calls).some((e) => /Expired/.test(e.text)), true);
});

test('a session that could not take the answer reopens the messages with their buttons', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const [yes] = buttonsOf(sends(calls)[0]);
  await press(bot, yes.callback_data);
  assert.equal(submitted.length, 1);
  await press(bot, yes.callback_data);
  assert.equal(toasts(calls).at(-1), 'Sending…');
  await bot.reopenQuestion('s1', 'r1', 'Codex is waiting for an approval or input');
  const restored = edits(calls).at(-1);
  assert.doesNotMatch(restored.text, /Selected/);
  assert.deepEqual(restored.reply_markup, sends(calls)[0].reply_markup);
  assert.equal(sends(calls).at(-1).text, 'Not delivered: Codex is waiting for an approval or input');
  await press(bot, yes.callback_data);
  assert.equal(submitted.length, 2);
});

test('a reopen for a question Telegram was not sending changes nothing', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([fixed]));
  const before = calls.length;
  await bot.reopenQuestion('s1', 'r1', 'whatever');
  assert.equal(calls.length, before);
});

test('long answers are clipped on screen but sent in full', async (t) => {
  const { bot, calls, submitted } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([name]));
  const long = 'z'.repeat(1000);
  await replyTo(bot, 100, long);
  assert.equal(submitted[0].answers.q2, long);
  assert.match(edits(calls)[0].text, new RegExp(`Selected:</b> ${'z'.repeat(300)}…$`));
});

test('a long context still leaves room for the result line within the message limit', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color], { context: 'c'.repeat(20000) }));
  const [msg] = sends(calls);
  assert.equal(visibleLength(msg.text) <= 4000 - 400, true);
  assert.match(msg.text, /…\(truncated\)/);
  await bot.resolveQuestion('s1', 'r1', 'answered', { q1: 'x'.repeat(300) }, 'dashboard');
  assert.equal(visibleLength(edits(calls)[0].text) <= 4000, true);
});

test('only the latest 100 requests keep working buttons', async (t) => {
  const { bot, calls } = setup(t);
  for (let i = 0; i < 101; i++) await bot.sendQuestion('s1', 'proj', request([fixed], { requestId: `r${i}` }));
  const [oldest] = buttonsOf(sends(calls)[0]);
  await press(bot, oldest.callback_data);
  assert.equal(toasts(calls).at(-1), 'Expired');
  const [newest] = buttonsOf(sends(calls).at(-1));
  await press(bot, newest.callback_data);
  assert.equal(toasts(calls).at(-1), 'Sending…');
});

test('a reply to the heading of several questions reaches the session as a plain message', async (t) => {
  const { bot, submitted, delivered } = setup(t);
  await bot.sendQuestion('s1', 'proj', request([color, name], { context: 'Before I plan.' }));
  await replyTo(bot, 100, 'let me think');
  assert.deepEqual(delivered, ['s1:let me think']);
  assert.deepEqual(submitted, []);
});
````

Append to `test/hub-questions.test.ts`:

````ts
test('questions, results and reopenings reach Telegram, and a Telegram answer goes to the session', async () => {
  const calls: string[] = [];
  const bot: any = {
    sendQuestion: async (sessionId: string, label: string, request: any) => { calls.push(`send ${sessionId} ${label} ${request.requestId}`); },
    resolveQuestion: async (sessionId: string, requestId: string, state: string, answers?: any, source?: string) => { calls.push(`resolve ${requestId} ${state} ${JSON.stringify(answers ?? null)} ${source ?? '-'}`); },
    reopenQuestion: async (sessionId: string, requestId: string, reason: string) => { calls.push(`reopen ${requestId} ${reason}`); },
  };
  (hub as any).telegramBot = bot;
  (hub as any).wireTelegram(bot);
  const ch = await channel('s14');
  try {
    ask(ch.ws, 's14', 'r14');
    await settle();
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Red' }), 'question q2 has no answer');
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Red', q2: 'From phone' }), 'ok');
    await settle();
    assert.equal(of(ch.inbox, 'question_answer')[0].source, 'telegram');
    send(ch.ws, { type: 'question_delivery', sessionId: 's14', requestId: 'r14', ok: false, reason: 'busy' });
    await settle();
    assert.equal(bot.onQuestionAnswer('s14', 'r14', { q1: 'Blue', q2: 'Again' }), 'ok');
    await settle();
    send(ch.ws, { type: 'question_delivery', sessionId: 's14', requestId: 'r14', ok: true });
    await settle();
    assert.deepEqual(calls, [
      'send s14 s14 r14',
      'reopen r14 busy',
      'resolve r14 answered {"q1":"Blue","q2":"Again"} telegram',
    ]);
  } finally {
    (hub as any).telegramBot = undefined;
    (hub as any).notifier.telegramBot = undefined;
    ch.ws.close();
  }
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/telegram-questions.test.ts test/hub-questions.test.ts`
Expected: FAIL — `bot.sendQuestion is not a function`, and the Hub test sees no Telegram calls.

- [ ] **Step 3: Teach the bot questions**

In `src/hub/telegram.ts`:

Edit 1 of 9 — replace:

````ts
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { UPLOADS_DIR } from '../shared/constants.js';
import type { TelegramConfig, SessionInfo, PermissionChoice } from '../shared/types.js';
import { sessionLabel } from '../shared/session-label.js';
import { permissionKey } from '../shared/permission-key.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_CHOICE_MESSAGES = 200;
````

with:

````ts
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { UPLOADS_DIR } from '../shared/constants.js';
import type { TelegramConfig, SessionInfo, PermissionChoice, MessageSource, Question, QuestionAnswers, QuestionRequest, QuestionState } from '../shared/types.js';
import { sessionLabel } from '../shared/session-label.js';
import { permissionKey } from '../shared/permission-key.js';
import { readAnswers } from '../shared/questions.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_CHOICE_MESSAGES = 200;
````

Edit 2 of 9 — replace:

````ts
const TRUNCATED = '…(truncated)';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const NO_LONGER_CONNECTED = 'the session is no longer connected';

// Telegram's 4096 limit counts the text left after parsing entities: tags are free and each escape is one character.
export function visibleLength(html: string): number {
````

with:

````ts
const TRUNCATED = '…(truncated)';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const NO_LONGER_CONNECTED = 'the session is no longer connected';
const MAX_QUESTION_REQUESTS = 100;
const SHOWN_ANSWER = 300;
// Room kept free in a question message for the "Selected" or result line added when it is edited.
const QUESTION_EDIT_ROOM = 400;
const SOURCE_NAMES: Record<MessageSource, string> = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

// Telegram's 4096 limit counts the text left after parsing entities: tags are free and each escape is one character.
export function visibleLength(html: string): number {
````

Edit 3 of 9 — replace:

````ts
  outcome?: string;
}

interface PendingSelection {
  text?: string;
  photoFileId?: string;
````

with:

````ts
  outcome?: string;
}

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface QuestionMessage {
  html: string;
  keyboard: InlineKeyboard | null;
  id?: number;
}

interface TelegramQuestion {
  key: string;
  sessionId: string;
  requestId: string;
  questions: Question[];
  answers: Map<string, string>;
  messages: Map<string, QuestionMessage>;
  state: 'open' | 'sending' | 'done';
  final?: { state: QuestionState; answers?: QuestionAnswers; source?: MessageSource };
}

interface PendingSelection {
  text?: string;
  photoFileId?: string;
````

Edit 4 of 9 — replace:

````ts
  // Telegram caps callback_data at 64 bytes, so buttons carry a short token instead of the ids.
  private choiceTokens = new Map<string, { sessionId: string; requestId: string; choiceId: string; label: string }>();
  private choiceMessages = new Map<string, ChoiceMessage>();
  // Callback: get current sessions list
  public getSessions?: () => SessionInfo[];
  private latestSelection: string | undefined;
````

with:

````ts
  // Telegram caps callback_data at 64 bytes, so buttons carry a short token instead of the ids.
  private choiceTokens = new Map<string, { sessionId: string; requestId: string; choiceId: string; label: string }>();
  private choiceMessages = new Map<string, ChoiceMessage>();
  // Callback: all questions of a request are answered here; returns 'ok' or why the hub refused
  public onQuestionAnswer?: (sessionId: string, requestId: string, answers: QuestionAnswers) => string;
  private questionRequests = new Map<string, TelegramQuestion>();
  private questionTokens = new Map<string, { key: string; qid: string; label: string }>();
  private questionReplies = new Map<number, { key: string; qid: string }>();
  // Callback: get current sessions list
  public getSessions?: () => SessionInfo[];
  private latestSelection: string | undefined;
````

Edit 5 of 9 — replace:

````ts
  async sendNotification(sessionId: string, _sessionLabel: string, title: string, message: string): Promise<void> {
    const text = this.fitNotification(title, message);
    const result = await this.sendMessage(text);
    if (result?.message_id) {
      this.messageSessionMap.set(result.message_id, sessionId);
      // Cleanup old mappings (keep last 200)
      if (this.messageSessionMap.size > 200) {
        const keys = [...this.messageSessionMap.keys()];
        for (let i = 0; i < keys.length - 200; i++) {
          this.messageSessionMap.delete(keys[i]);
        }
      }
    }
  }

  private fitNotification(title: string, message: string): string {
    const render = (body: string) => `<b>${this.escHtml(title)}</b>\n${this.mdToHtml(body)}`;
    const full = render(message);
    if (visibleLength(full) <= MAX_VISIBLE_CHARS) return full;
    const cut = (n: number) => {
      // Cutting between the halves of a surrogate pair would send invalid UTF-16.
      const end = n > 0 && /[\uD800-\uDBFF]/.test(message[n - 1]) ? n - 1 : n;
      return render(`${message.slice(0, end)}\n${TRUNCATED}`);
    };
    let lo = 0;
    let hi = message.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (visibleLength(cut(mid)) <= MAX_VISIBLE_CHARS) lo = mid;
      else hi = mid - 1;
    }
    return cut(lo);
````

with:

````ts
  async sendNotification(sessionId: string, _sessionLabel: string, title: string, message: string): Promise<void> {
    const text = this.fitNotification(title, message);
    const result = await this.sendMessage(text);
    if (result?.message_id) this.rememberSession(result.message_id, sessionId);
  }

  private rememberSession(messageId: number, sessionId: string): void {
    this.messageSessionMap.set(messageId, sessionId);
    // Cleanup old mappings (keep last 200)
    if (this.messageSessionMap.size > 200) {
      const keys = [...this.messageSessionMap.keys()];
      for (let i = 0; i < keys.length - 200; i++) {
        this.messageSessionMap.delete(keys[i]);
      }
    }
  }

  private fitNotification(title: string, message: string): string {
    return this.fit((body) => `<b>${this.escHtml(title)}</b>\n${this.mdToHtml(body)}`, message);
  }

  private fit(render: (body: string) => string, body: string, max = MAX_VISIBLE_CHARS): string {
    const full = render(body);
    if (visibleLength(full) <= max) return full;
    const cut = (n: number) => {
      // Cutting between the halves of a surrogate pair would send invalid UTF-16.
      const end = n > 0 && /[\uD800-\uDBFF]/.test(body[n - 1]) ? n - 1 : n;
      return render(`${body.slice(0, end)}\n${TRUNCATED}`);
    };
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (visibleLength(cut(mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    return cut(lo);
````

Edit 6 of 9 — replace:

````ts
      }
    }

    // Check if it's a reply to a known message
    if (msg.reply_to_message) {
      const sessionId = this.messageSessionMap.get(msg.reply_to_message.message_id);
````

with:

````ts
      }
    }

    // A reply to an open question is its typed answer, not a message to the session.
    if (msg.reply_to_message && text && !hasPhoto && (await this.answerByReply(msg.reply_to_message.message_id, text))) return;

    // Check if it's a reply to a known message
    if (msg.reply_to_message) {
      const sessionId = this.messageSessionMap.get(msg.reply_to_message.message_id);
````

Edit 7 of 9 — replace:

````ts
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;
    if (String(query.message?.chat.id) !== String(this.config.chatId)) return;
````

with:

````ts
    }
  }

  async sendQuestion(sessionId: string, sessionLabel: string, request: QuestionRequest): Promise<void> {
    const key = permissionKey(sessionId, request.requestId);
    const entry: TelegramQuestion = { key, sessionId, requestId: request.requestId, questions: request.questions, answers: new Map(), messages: new Map(), state: 'open' };
    this.questionRequests.set(key, entry);
    this.trimQuestions();
    const count = request.questions.length;
    const head = `❓ <b>${count === 1 ? 'Question' : `Questions (${count})`}</b> — ${this.escHtml(sessionLabel)}`;
    const context = request.context ?? '';
    if (count > 1) {
      const heading = await this.sendMessage(this.fit((body) => (body ? `${head}\n\n${this.mdToHtml(body)}` : head), context));
      if (heading) this.rememberSession(heading.message_id, sessionId);
    }
    for (const [i, q] of request.questions.entries()) {
      const hint = q.options ? (q.allowOther ? 'Or reply to this message with your own answer.' : '') : 'Reply to this message with your answer.';
      const body = `${q.header ? `<b>[${this.escHtml(q.header)}]</b> ` : ''}${this.mdToHtml(q.question)}${hint ? `\n\n<i>${hint}</i>` : ''}`;
      const html = count === 1
        ? this.fit((ctx) => `${head}${ctx ? `\n\n${this.mdToHtml(ctx)}` : ''}\n\n${body}`, context, MAX_VISIBLE_CHARS - QUESTION_EDIT_ROOM)
        : this.fit((text) => `<b>${i + 1}/${count}</b> ${text}`, body, MAX_VISIBLE_CHARS - QUESTION_EDIT_ROOM);
      const keyboard = q.options && entry.state !== 'done' ? q.options.map((o) => {
        const token = randomUUID().replace(/-/g, '').slice(0, 16);
        this.questionTokens.set(token, { key, qid: q.id, label: o.label });
        return [{ text: o.label, callback_data: `qa:${token}` }];
      }) : null;
      const message: QuestionMessage = { html, keyboard };
      entry.messages.set(q.id, message);
      const sent = await this.sendMessage(html, undefined, keyboard ? { inline_keyboard: keyboard } : undefined);
      if (!sent) continue;
      message.id = sent.message_id;
      this.rememberSession(sent.message_id, sessionId);
      if (entry.state === 'done') {
        await this.editMessageText(this.config.chatId, sent.message_id, this.finalHtml(entry, q.id, message));
      } else {
        this.questionReplies.set(sent.message_id, { key, qid: q.id });
      }
    }
  }

  async resolveQuestion(sessionId: string, requestId: string, state: QuestionState, answers?: QuestionAnswers, source?: MessageSource): Promise<void> {
    const key = permissionKey(sessionId, requestId);
    const entry = this.questionRequests.get(key);
    if (!entry) return;
    this.questionRequests.delete(key);
    this.dropQuestionRefs(key);
    entry.state = 'done';
    entry.final = { state, answers, source };
    for (const [qid, message] of entry.messages) {
      if (message.id !== undefined) await this.editMessageText(this.config.chatId, message.id, this.finalHtml(entry, qid, message));
    }
  }

  async reopenQuestion(sessionId: string, requestId: string, reason: string): Promise<void> {
    const entry = this.questionRequests.get(permissionKey(sessionId, requestId));
    if (!entry || entry.state !== 'sending') return;
    entry.state = 'open';
    entry.answers.clear();
    for (const message of entry.messages.values()) {
      if (message.id !== undefined) await this.editMessageText(this.config.chatId, message.id, message.html, message.keyboard ? { inline_keyboard: message.keyboard } : undefined);
    }
    await this.sendMessage(`Not delivered: ${this.escHtml(reason)}`);
  }

  private finalHtml(entry: TelegramQuestion, qid: string, message: QuestionMessage): string {
    const final = entry.final!;
    if (final.state === 'answered') {
      const from = final.source && final.source !== 'telegram' ? ` (${SOURCE_NAMES[final.source]})` : '';
      return `${message.html}\n\n✅ <b>${this.shown(final.answers?.[qid] ?? '')}</b>${from}`;
    }
    return `${message.html}\n\n${final.state === 'closed' ? '<i>Closed — a message was sent instead</i>' : '⌛ <b>Expired</b>'}`;
  }

  private shown(answer: string): string {
    return this.escHtml(answer.length > SHOWN_ANSWER ? `${answer.slice(0, SHOWN_ANSWER)}…` : answer);
  }

  private async handleQuestionCallback(query: TelegramCallbackQuery): Promise<void> {
    const token = this.questionTokens.get(query.data!.slice('qa:'.length));
    const entry = token && this.questionRequests.get(token.key);
    if (!token || !entry) {
      await this.expire(query);
      return;
    }
    if (entry.state !== 'open') {
      await this.answerCallbackQuery(query.id, 'Sending…');
      return;
    }
    const result = await this.recordAnswer(entry, token.qid, token.label);
    await this.answerCallbackQuery(query.id, result === 'sending' ? 'Sending…' : result === 'failed' ? 'Not delivered' : 'Selected');
  }

  private async answerByReply(messageId: number, text: string): Promise<boolean> {
    const ref = this.questionReplies.get(messageId);
    const entry = ref && this.questionRequests.get(ref.key);
    if (!ref || !entry || entry.state !== 'open') return false;
    if (!entry.questions.find((q) => q.id === ref.qid)?.allowOther) return false;
    await this.recordAnswer(entry, ref.qid, text);
    return true;
  }

  private async recordAnswer(entry: TelegramQuestion, qid: string, answer: string): Promise<'selected' | 'sending' | 'failed'> {
    entry.answers.set(qid, answer);
    const message = entry.messages.get(qid);
    if (message?.id !== undefined) {
      await this.editMessageText(this.config.chatId, message.id, `${message.html}\n\n☑️ <b>Selected:</b> ${this.shown(answer)}`, message.keyboard ? { inline_keyboard: message.keyboard } : undefined);
    }
    if (entry.answers.size < entry.questions.length || entry.state !== 'open') return 'selected';
    entry.state = 'sending';
    const read = readAnswers(entry.questions, Object.fromEntries(entry.answers));
    const outcome = read.ok ? (this.onQuestionAnswer?.(entry.sessionId, entry.requestId, read.answers) ?? 'the hub is not listening') : read.error;
    if (outcome === 'ok') return 'sending';
    if (entry.state === 'sending') entry.state = 'open';
    await this.sendMessage(`Not delivered: ${this.escHtml(outcome)}`);
    return 'failed';
  }

  private dropQuestionRefs(key: string): void {
    for (const [token, ref] of this.questionTokens) if (ref.key === key) this.questionTokens.delete(token);
    for (const [messageId, ref] of this.questionReplies) if (ref.key === key) this.questionReplies.delete(messageId);
  }

  private trimQuestions(): void {
    while (this.questionRequests.size > MAX_QUESTION_REQUESTS) {
      const oldest = this.questionRequests.keys().next().value as string;
      this.questionRequests.delete(oldest);
      this.dropQuestionRefs(oldest);
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;
    if (String(query.message?.chat.id) !== String(this.config.chatId)) return;
````

Edit 8 of 9 — replace:

````ts
      return;
    }

    if (!query.data.startsWith('perm:')) return;

    const parts = query.data.split(':');
````

with:

````ts
      return;
    }

    if (query.data.startsWith('qa:')) {
      await this.handleQuestionCallback(query);
      return;
    }

    if (!query.data.startsWith('perm:')) return;

    const parts = query.data.split(':');
````

Edit 9 of 9 — replace:

````ts
    }
  }

  private async editMessageText(chatId: number | string, messageId: number, text: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageText error: ${(err as Error).message}`);
````

with:

````ts
    }
  }

  // Telegram drops the buttons of an edited message unless reply_markup is sent again.
  private async editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: { inline_keyboard: InlineKeyboard }): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageText error: ${(err as Error).message}`);
````

- [ ] **Step 4: Connect the Hub to the bot's question methods**

In `src/hub/server.ts`:

Edit 1 of 4 — replace:

````ts
        this.sessions.updateActivity(request.sessionId);
        this.broadcastToDashboards({ type: 'question', ...request });
        const label = this.getSessionLabel(this.sessions.get(request.sessionId));
        void this.notifier.notifyWithSession(undefined, undefined, `[${label}] Question`, questionSummary(request), 'warning');
        break;
      }
````

with:

````ts
        this.sessions.updateActivity(request.sessionId);
        this.broadcastToDashboards({ type: 'question', ...request });
        const label = this.getSessionLabel(this.sessions.get(request.sessionId));
        // The bot sends the question with its own buttons, so the desktop notice leaves Telegram out.
        void this.notifier.notifyWithSession(undefined, undefined, `[${label}] Question`, questionSummary(request), 'warning');
        void this.telegramBot?.sendQuestion(request.sessionId, label, request);
        break;
      }
````

Edit 2 of 4 — replace:

````ts
      return;
    }
    open.sending = undefined;
    this.broadcastToDashboards({ type: 'question_rejected', sessionId, requestId, reason: reason || 'the session could not take the answer' });
  }

  // A plain message closes the questions it overtakes; one already being answered waits for its own outcome.
````

with:

````ts
      return;
    }
    open.sending = undefined;
    const why = reason || 'the session could not take the answer';
    this.broadcastToDashboards({ type: 'question_rejected', sessionId, requestId, reason: why });
    void this.telegramBot?.reopenQuestion(sessionId, requestId, why);
  }

  // A plain message closes the questions it overtakes; one already being answered waits for its own outcome.
````

Edit 3 of 4 — replace:

````ts

  private announceQuestion(sessionId: string, requestId: string, state: QuestionState, answers?: QuestionAnswers, source?: MessageSource): void {
    this.broadcastToDashboards({ type: 'question_resolved', sessionId, requestId, state, ...(answers ? { answers } : {}), ...(source ? { source } : {}) });
  }

  private broadcastToDashboards(msg: ChannelMessage): void {
````

with:

````ts

  private announceQuestion(sessionId: string, requestId: string, state: QuestionState, answers?: QuestionAnswers, source?: MessageSource): void {
    this.broadcastToDashboards({ type: 'question_resolved', sessionId, requestId, state, ...(answers ? { answers } : {}), ...(source ? { source } : {}) });
    void this.telegramBot?.resolveQuestion(sessionId, requestId, state, answers, source);
  }

  private broadcastToDashboards(msg: ChannelMessage): void {
````

Edit 4 of 4 — replace:

````ts
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    bot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
````

with:

````ts
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    bot.onQuestionAnswer = (sessionId, requestId, answers) => this.answerQuestion(sessionId, requestId, answers, 'telegram');
    bot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
````

- [ ] **Step 5: Run the tests and the type check**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/telegram-questions.test.ts test/hub-questions.test.ts` → 31 pass (16 + 15).
Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/telegram-*.test.ts` → all pass (`telegram-limits.test.ts` covers `fitNotification`).
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/hub/telegram.ts src/hub/server.ts test/telegram-questions.test.ts test/hub-questions.test.ts
git commit -m "feat(telegram): questions arrive with a button per option, a reply is a typed answer, and the result rewrites every question message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Question cards in the dashboard

**Files:**
- Modify: `src/dashboard/index.html` (CSS, state, message cases, `renderMessages`, the `// --- Questions ---` block, the 30 s refresh)
- Test: `test/dashboard-questions.test.ts`

**Interfaces:**
- Consumes: the `question`, `questions_pending`, `question_sending`, `question_resolved` and `question_rejected` messages (Tasks 2–5), and the dashboard's own `esc`, `renderMarkdown`, `saveMessages`, `flashTitle`, `showMentionError`, `renderSessions`, `renderNotifications`, `renderMessages` and `agentName`.
- Produces, in the dashboard script:
  - **Message model:** `state.messages[sid]` entries `{ from: 'session', kind: 'question', requestId, context, questions, state: 'open' | 'sending' | 'answered' | 'closed' | 'expired' | 'gone', answers, source, error, time }`.
  - **State:** `state.questionDrafts[requestId][questionId] = { choice, other }`, plus `state.composing`.
  - **Functions:**
    - Message handlers: `showQuestion`, `restorePendingQuestions`, `markQuestionSending`, `resolveQuestionCard`, `rejectQuestionCard`
    - Card logic: `readyAnswers`, `questionCardHtml`, `sendQuestionAnswer`, `bindQuestionCards`
    - Focus: `captureQuestionFocus`, `restoreQuestionFocus`, `typingInQuestion`
  - **Rules:**
    - With one question, a button press sends at once, and Enter in the box sends.
    - With several questions, each one is answered first and then Send.
    - A typed answer wins over a picked option.
    - The 30 s refresh skips the conversation while a card's box has focus or an IME is composing.

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard-questions.test.ts`:

````ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function section(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start > 0 && end > start, `anchors not found: ${from.trim()}`);
  return html.slice(start, end);
}

// The dashboard is a single inline-script HTML file; evaluate the question block in a sandbox.
function load(selectedSession = 's1') {
  const flashes: string[] = [];
  const sent: any[] = [];
  const errors: string[] = [];
  const renders = { messages: 0, sessions: 0, notifications: 0 };
  const ctx: Record<string, any> = {
    state: { selectedSession, messages: {}, notifications: [], unread: {}, waitingReply: { s1: true }, questionDrafts: {}, composing: false, ws: { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) } },
    WebSocket: { OPEN: 1 },
    document: { activeElement: null, querySelectorAll: () => [] },
    CSS: { escape: (s: string) => s },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderMarkdown: (s: string) => `<md>${s}</md>`,
    renderMessages: () => { renders.messages++; },
    renderSessions: () => { renders.sessions++; },
    renderNotifications: () => { renders.notifications++; },
    saveMessages: () => {},
    flashTitle: (m: string) => flashes.push(m),
    showMentionError: (m: string) => errors.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // --- Questions ---', '  // --- Permission relay ---'), ctx);
  return { ctx, flashes, sent, errors, renders };
}

const questions = [
  { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue', description: 'the calm one' }], allowOther: true },
  { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
];
const ask = (extra: object = {}) => ({ type: 'question', sessionId: 's1', requestId: 'r1', questions, timestamp: 5, ...extra });
const card = (ctx: any, sid = 's1', requestId = 'r1') => ctx.state.messages[sid].find((m: any) => m.requestId === requestId);

test('the dashboard routes the question messages to their handlers', () => {
  assert.match(html, /case 'question':\s*showQuestion\(msg\);\s*break;/);
  assert.match(html, /case 'questions_pending':\s*restorePendingQuestions\(msg\.requests \|\| \[\]\);\s*break;/);
  assert.match(html, /case 'question_sending':\s*markQuestionSending\(msg\);\s*break;/);
  assert.match(html, /case 'question_resolved':\s*resolveQuestionCard\(msg\);\s*break;/);
  assert.match(html, /case 'question_rejected':\s*rejectQuestionCard\(msg\);\s*break;/);
  assert.match(html, /setInterval\(\(\) => \{ if \(!typingInQuestion\(\)\) renderMessages\(\); renderNotifications\(\); \}, 30000\);/);
});

test('a question joins the conversation once, stops the typing dots, and raises one notice', () => {
  const { ctx, flashes } = load('other');
  ctx.showQuestion(ask({ context: 'Two ways.' }));
  ctx.showQuestion(ask());
  const msgs = ctx.state.messages.s1;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'question');
  assert.equal(msgs[0].state, 'open');
  assert.equal(msgs[0].context, 'Two ways.');
  assert.equal(ctx.state.waitingReply.s1, false);
  assert.equal(ctx.state.unread.s1, 1);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.notifications[0].title, 'Question');
  assert.equal(ctx.state.notifications[0].message, 'Which color do you prefer? (+1 more)');
  assert.equal(ctx.state.notifications[0].level, 'warning');
  assert.deepEqual(flashes, ['Question']);
});

test('restoring adds missing questions with one notice, sets the lock from the hub, and marks vanished ones', () => {
  const { ctx, flashes } = load();
  ctx.state.messages = {
    s1: [
      { kind: 'question', requestId: 'stuck', questions, state: 'sending', answers: { q1: 'Red', q2: 'A' } },
      { kind: 'question', requestId: 'gone', questions, state: 'open' },
      { kind: 'question', requestId: 'done', questions, state: 'answered' },
    ],
  };
  ctx.restorePendingQuestions([
    { sessionId: 's1', requestId: 'stuck', questions, timestamp: 1, sending: false },
    { sessionId: 's2', requestId: 'new', questions, timestamp: 2, sending: true },
  ]);
  assert.equal(card(ctx, 's1', 'stuck').state, 'open');
  assert.equal(card(ctx, 's1', 'stuck').answers, null);
  assert.equal(card(ctx, 's1', 'gone').state, 'gone');
  assert.equal(card(ctx, 's1', 'done').state, 'answered');
  assert.equal(card(ctx, 's2', 'new').state, 'sending');
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.notifications[0].title, '1 question(s) waiting');
  assert.deepEqual(flashes, ['1 question(s) waiting']);
  ctx.restorePendingQuestions([]);
  assert.equal(ctx.state.notifications.length, 1);
});

test('sending, answered, and rejected update the card; a rejection reopens it with the reason', () => {
  const { ctx, errors } = load();
  ctx.showQuestion(ask());
  ctx.markQuestionSending({ sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'A' }, source: 'telegram' });
  assert.equal(card(ctx).state, 'sending');
  assert.equal(card(ctx).source, 'telegram');
  ctx.rejectQuestionCard({ sessionId: 's1', requestId: 'r1', reason: 'Codex is waiting for an approval or input' });
  assert.equal(card(ctx).state, 'open');
  assert.equal(card(ctx).error, 'Codex is waiting for an approval or input');
  assert.deepEqual(errors, ['Answer not delivered: Codex is waiting for an approval or input']);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Red', other: '' } };
  ctx.resolveQuestionCard({ sessionId: 's1', requestId: 'r1', state: 'answered', answers: { q1: 'Blue', q2: 'B' }, source: 'dashboard' });
  assert.equal(card(ctx).state, 'answered');
  assert.deepEqual({ ...card(ctx).answers }, { q1: 'Blue', q2: 'B' });
  assert.equal(card(ctx).error, null);
  assert.equal(ctx.state.questionDrafts.r1, undefined);
  ctx.markQuestionSending({ sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'C' }, source: 'dashboard' });
  assert.equal(card(ctx).state, 'answered');
});

test('a typed answer wins over a picked option, and every question needs one before sending', () => {
  const { ctx } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  assert.equal(ctx.readyAnswers(m), null);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Blue', other: '' } };
  assert.equal(ctx.readyAnswers(m), null);
  ctx.state.questionDrafts.r1.q2 = { choice: '', other: '  Probe ' };
  assert.deepEqual({ ...ctx.readyAnswers(m) }, { q1: 'Blue', q2: 'Probe' });
  ctx.state.questionDrafts.r1.q1 = { choice: 'Blue', other: 'Teal' };
  assert.equal(ctx.readyAnswers(m).q1, 'Teal');
});

test('an open card shows buttons with descriptions, typing boxes, and Send only for several questions', () => {
  const { ctx } = load();
  ctx.showQuestion(ask({ context: 'Two ways.' }));
  const many = ctx.questionCardHtml(card(ctx));
  assert.match(many, /<div class="question-context"><md>Two ways\.<\/md><\/div>/);
  assert.match(many, /<button type="button" class="question-option" data-q="q1" data-i="1">Blue<span class="question-option-desc">the calm one<\/span><\/button>/);
  assert.match(many, /<input type="text" class="question-other" data-q="q2" placeholder="Type your answer">/);
  assert.match(many, /<button type="button" class="question-send" disabled>Send<\/button>/);
  ctx.state.questionDrafts.r1 = { q1: { choice: 'Red', other: '' }, q2: { choice: '', other: 'x' } };
  const ready = ctx.questionCardHtml(card(ctx));
  assert.match(ready, /class="question-option selected" data-q="q1" data-i="0"/);
  assert.match(ready, /<button type="button" class="question-send">Send<\/button>/);
  ctx.showQuestion(ask({ requestId: 'one', questions: [questions[0]] }));
  const single = ctx.questionCardHtml(card(ctx, 's1', 'one'));
  assert.doesNotMatch(single, /question-send/);
  assert.match(single, /placeholder="Or type your own answer \(Enter to send\)"/);
});

test('a closed card shows the answers and why it closed, without buttons', () => {
  const { ctx } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  Object.assign(m, { state: 'answered', answers: { q1: 'Blue', q2: '<b>x</b>' }, source: 'telegram' });
  const answered = ctx.questionCardHtml(m);
  assert.doesNotMatch(answered, /question-option|question-other/);
  assert.match(answered, /&rarr; Blue/);
  assert.match(answered, /&rarr; &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(answered, /Answered &middot; Telegram/);
  for (const [state, text] of [['closed', 'Closed — a message was sent instead'], ['expired', 'Expired — the session ended'], ['gone', 'No longer open'], ['sending', 'Sending…']]) {
    Object.assign(m, { state, answers: null });
    assert.match(ctx.questionCardHtml(m), new RegExp(text));
  }
});

test('sending an answer posts it to the hub and locks the card', () => {
  const { ctx, sent } = load();
  ctx.showQuestion(ask());
  const m = card(ctx);
  ctx.sendQuestionAnswer('s1', m, { q1: 'Red', q2: 'A' });
  assert.deepEqual(sent, [{ type: 'question_answer', sessionId: 's1', requestId: 'r1', answers: { q1: 'Red', q2: 'A' } }]);
  assert.equal(m.state, 'sending');
  assert.equal(m.source, 'dashboard');
  ctx.state.ws = null;
  m.state = 'open';
  ctx.sendQuestionAnswer('s1', m, { q1: 'Red', q2: 'A' });
  assert.equal(m.error, 'Not connected to the hub');
  assert.equal(m.state, 'open');
});

test('the time refresh waits while an answer is being typed', () => {
  const { ctx } = load();
  assert.equal(ctx.typingInQuestion(), false);
  ctx.document.activeElement = { classList: { contains: (c: string) => c === 'question-other' } };
  assert.equal(ctx.typingInQuestion(), true);
  ctx.document.activeElement = null;
  ctx.state.composing = true;
  assert.equal(ctx.typingInQuestion(), true);
});

test('headers, labels and descriptions from a session are escaped in the card', () => {
  const { ctx } = load();
  ctx.showQuestion(ask({ requestId: 'x', questions: [{ id: 'q1', header: '<i>h</i>', question: 'Q', options: [{ label: '<b>A</b>', description: '<x>' }, { label: 'B' }], allowOther: false }] }));
  const html = ctx.questionCardHtml(card(ctx, 's1', 'x'));
  assert.match(html, /<span class="question-header">&lt;i&gt;h&lt;\/i&gt;<\/span>/);
  assert.match(html, />&lt;b&gt;A&lt;\/b&gt;<span class="question-option-desc">&lt;x&gt;<\/span><\/button>/);
  assert.doesNotMatch(html, /<b>A<\/b>|<i>h<\/i>/);
  assert.doesNotMatch(html, /question-other/);
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/dashboard-questions.test.ts`
Expected: FAIL — `anchors not found: // --- Questions ---`.

- [ ] **Step 3: Add the cards**

In `src/dashboard/index.html`:

Edit 1 of 7 — replace:

````html
    margin-top: 4px;
  }

  /* Typing indicator */
  .typing-indicator {
    display: none;
````

with:

````html
    margin-top: 4px;
  }

  /* Question cards */
  .message.question-card { max-width: 90%; border-color: var(--yellow); }
  .question-context { margin-bottom: 10px; }
  .question-item { padding: 8px 0; border-top: 1px solid var(--border); }
  .question-item:first-child { border-top: none; padding-top: 0; }
  .question-header { display: inline-block; margin-bottom: 4px; padding: 0 6px; border: 1px solid var(--yellow); border-radius: 4px; color: var(--yellow); font-size: 11px; font-weight: 600; }
  .question-text { margin-bottom: 6px; }
  .question-options { display: flex; flex-direction: column; gap: 6px; }
  .question-option { padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .question-option:hover { border-color: var(--yellow); }
  .question-option.selected { border-color: var(--accent); background: rgba(224,168,109,0.12); }
  .question-option-desc { display: block; margin-top: 2px; color: var(--text-dim); font-size: 11px; }
  .question-other { width: 100%; margin-top: 6px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; }
  .question-other:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .question-answer { margin-top: 2px; font-weight: 500; }
  .question-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .question-send { padding: 6px 16px; border: none; border-radius: 6px; background: var(--accent); color: #1a1d27; font: inherit; font-weight: 600; cursor: pointer; }
  .question-send:disabled { opacity: 0.4; cursor: default; }
  .question-status { color: var(--text-dim); font-size: 12px; }
  .question-status.answered { color: var(--green); }
  .question-error { margin-top: 6px; color: var(--red); font-size: 12px; }

  /* Typing indicator */
  .typing-indicator {
    display: none;
````

Edit 2 of 7 — replace:

````html
    codexAdapters: [],
    pendingSelect: null,
    closeArmed: null,
  };

  const $ = (sel) => document.querySelector(sel);
````

with:

````html
    codexAdapters: [],
    pendingSelect: null,
    closeArmed: null,
    questionDrafts: {},  // requestId -> { questionId: { choice, other } }
    composing: false,
  };

  const $ = (sel) => document.querySelector(sel);
````

Edit 3 of 7 — replace:

````html
          renderNotifications();
        }
        break;
      case 'permission_pending':
        restorePendingRequests(msg.requests || []);
        break;
````

with:

````html
          renderNotifications();
        }
        break;
      case 'question':
        showQuestion(msg);
        break;
      case 'questions_pending':
        restorePendingQuestions(msg.requests || []);
        break;
      case 'question_sending':
        markQuestionSending(msg);
        break;
      case 'question_resolved':
        resolveQuestionCard(msg);
        break;
      case 'question_rejected':
        rejectQuestionCard(msg);
        break;
      case 'permission_pending':
        restorePendingRequests(msg.requests || []);
        break;
````

Edit 4 of 7 — replace:

````html
    header.textContent = s ? sessionDisplayName(s) : state.selectedSession.slice(0, 12);

    const msgs = state.messages[state.selectedSession] || [];
    if (!msgs.length) {
      el.innerHTML = '<div class="empty-state">No messages yet</div>';
      return;
    }

    el.innerHTML = msgs.map(m => {
      const cls = m.from === 'session' ? 'from-session' : 'from-dashboard';
      const timeStr = relativeTime(m.time);
      let content;
      if (m.imageData) {
        content = `<img src="${m.imageData}" alt="${esc(m.imageName || 'image')}">`;
````

with:

````html
    header.textContent = s ? sessionDisplayName(s) : state.selectedSession.slice(0, 12);

    const msgs = state.messages[state.selectedSession] || [];
    const focus = captureQuestionFocus();
    if (!msgs.length) {
      el.innerHTML = '<div class="empty-state">No messages yet</div>';
      return;
    }

    el.innerHTML = msgs.map(m => {
      const timeStr = relativeTime(m.time);
      if (m.kind === 'question') {
        return `<div class="message from-session question-card" data-request="${esc(m.requestId)}">
        <div class="message-meta">${agentName(s)} &middot; ${timeStr} &middot; Question</div>
        <div class="message-body">${questionCardHtml(m)}</div>
      </div>`;
      }
      const cls = m.from === 'session' ? 'from-session' : 'from-dashboard';
      let content;
      if (m.imageData) {
        content = `<img src="${m.imageData}" alt="${esc(m.imageName || 'image')}">`;
````

Edit 5 of 7 — replace:

````html
    if (state.waitingReply[state.selectedSession]) {
      el.innerHTML += '<div class="typing-indicator active"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    }
    renderPermissionBar();
    // Only auto-scroll if user is near the bottom (within 150px)
    setTimeout(() => {
````

with:

````html
    if (state.waitingReply[state.selectedSession]) {
      el.innerHTML += '<div class="typing-indicator active"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
    }
    // Bound after the typing indicator: appending to innerHTML re-creates the cards and drops their listeners.
    bindQuestionCards(el);
    restoreQuestionFocus(focus);
    renderPermissionBar();
    // Only auto-scroll if user is near the bottom (within 150px)
    setTimeout(() => {
````

Edit 6 of 7 — replace:

````html
    return html;
  }

  // --- Permission relay ---
  // Format tool name for display — extract title for notify, friendly names for known tools
  function formatToolName(toolName, inputPreview) {
````

with:

````html
    return html;
  }

  // --- Questions ---
  const QUESTION_STATUS = {
    sending: 'Sending…',
    closed: 'Closed — a message was sent instead',
    expired: 'Expired — the session ended',
    gone: 'No longer open',
  };
  const SOURCE_NAMES = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

  function questionMessage(sessionId, requestId) {
    return (state.messages[sessionId] || []).find(m => m.kind === 'question' && m.requestId === requestId);
  }

  function firstQuestionLine(req) {
    const first = ((req.questions[0] && req.questions[0].question) || '').split('\n')[0].trim();
    const more = req.questions.length - 1;
    return more > 0 ? `${first} (+${more} more)` : first;
  }

  // Returns true when this dashboard did not have the question yet.
  function addQuestion(req) {
    const sid = req.sessionId;
    if (!state.messages[sid]) state.messages[sid] = [];
    if (questionMessage(sid, req.requestId)) return false;
    state.messages[sid].push({
      from: 'session', kind: 'question', requestId: req.requestId, context: req.context || '',
      questions: req.questions, state: req.sending ? 'sending' : 'open', answers: null, source: null, error: null,
      time: req.timestamp || Date.now(),
    });
    state.waitingReply[sid] = false;
    if (state.selectedSession !== sid) state.unread[sid] = (state.unread[sid] || 0) + 1;
    return true;
  }

  function showQuestion(msg) {
    if (!addQuestion(msg)) return;
    saveMessages();
    state.notifications.unshift({ sessionId: msg.sessionId, title: 'Question', message: firstQuestionLine(msg), level: 'warning', time: Date.now() });
    flashTitle('Question');
    renderSessions();
    renderNotifications();
    if (state.selectedSession === msg.sessionId) renderMessages();
  }

  // After a reconnect the hub lists the questions still open; any other open card here closed while this page was away.
  function restorePendingQuestions(requests) {
    const live = new Set(requests.map(r => r.sessionId + '\n' + r.requestId));
    const added = requests.filter(r => addQuestion(r));
    for (const r of requests) {
      const m = questionMessage(r.sessionId, r.requestId);
      if (m && !added.includes(r)) { m.state = r.sending ? 'sending' : 'open'; if (!r.sending) m.answers = null; }
    }
    for (const [sid, msgs] of Object.entries(state.messages)) {
      for (const m of msgs) {
        if (m.kind === 'question' && (m.state === 'open' || m.state === 'sending') && !live.has(sid + '\n' + m.requestId)) m.state = 'gone';
      }
    }
    if (added.length) {
      const label = `${added.length} question(s) waiting`;
      state.notifications.unshift({ sessionId: added[0].sessionId, title: label, message: added.slice(0, 3).map(firstQuestionLine).join(' · '), level: 'warning', time: Date.now() });
      flashTitle(label);
    }
    saveMessages();
    renderSessions();
    renderNotifications();
    renderMessages();
  }

  function updateQuestion(msg, change) {
    const m = questionMessage(msg.sessionId, msg.requestId);
    if (!m) return null;
    change(m);
    saveMessages();
    if (state.selectedSession === msg.sessionId) renderMessages();
    return m;
  }

  function markQuestionSending(msg) {
    updateQuestion(msg, m => {
      if (m.state !== 'open' && m.state !== 'sending') return;
      m.state = 'sending';
      m.answers = msg.answers;
      m.source = msg.source;
      m.error = null;
    });
  }

  function resolveQuestionCard(msg) {
    updateQuestion(msg, m => {
      m.state = msg.state;
      if (msg.answers) m.answers = msg.answers;
      m.source = msg.source || null;
      m.error = null;
      delete state.questionDrafts[m.requestId];
    });
  }

  function rejectQuestionCard(msg) {
    const m = updateQuestion(msg, q => {
      if (q.state !== 'open' && q.state !== 'sending') return;
      q.state = 'open';
      q.answers = null;
      q.error = msg.reason;
    });
    if (m && state.selectedSession === msg.sessionId) showMentionError(`Answer not delivered: ${msg.reason}`);
  }

  function questionDraft(requestId) {
    if (!state.questionDrafts[requestId]) state.questionDrafts[requestId] = {};
    return state.questionDrafts[requestId];
  }

  // A typed answer wins over a picked option; picking an option clears the typed one.
  function draftAnswer(d) {
    if (!d) return '';
    const typed = (d.other || '').trim();
    return typed || d.choice || '';
  }

  function readyAnswers(m) {
    const d = state.questionDrafts[m.requestId] || {};
    const answers = {};
    for (const q of m.questions) {
      const a = draftAnswer(d[q.id]);
      if (!a) return null;
      answers[q.id] = a;
    }
    return answers;
  }

  function questionCardHtml(m) {
    const open = m.state === 'open';
    const d = state.questionDrafts[m.requestId] || {};
    const single = m.questions.length === 1;
    let html = m.context ? `<div class="question-context">${renderMarkdown(m.context)}</div>` : '';
    for (const q of m.questions) {
      const qd = d[q.id] || {};
      html += `<div class="question-item" data-q="${esc(q.id)}">`;
      if (q.header) html += `<span class="question-header">${esc(q.header)}</span>`;
      html += `<div class="question-text">${renderMarkdown(q.question)}</div>`;
      if (open) {
        if (q.options) {
          const picked = !(qd.other || '').trim() ? qd.choice : null;
          html += '<div class="question-options">' + q.options.map((o, i) =>
            `<button type="button" class="question-option${picked === o.label ? ' selected' : ''}" data-q="${esc(q.id)}" data-i="${i}">${esc(o.label)}${o.description ? `<span class="question-option-desc">${esc(o.description)}</span>` : ''}</button>`
          ).join('') + '</div>';
        }
        if (q.allowOther) {
          const hint = (q.options ? 'Or type your own answer' : 'Type your answer') + (single ? ' (Enter to send)' : '');
          html += `<input type="text" class="question-other" data-q="${esc(q.id)}" placeholder="${esc(hint)}">`;
        }
      } else if (m.answers && m.answers[q.id]) {
        html += `<div class="question-answer">&rarr; ${esc(m.answers[q.id])}</div>`;
      }
      html += '</div>';
    }
    if (m.error) html += `<div class="question-error">${esc(m.error)}</div>`;
    let status;
    if (open) status = single ? '' : `<button type="button" class="question-send"${readyAnswers(m) ? '' : ' disabled'}>Send</button>`;
    else if (m.state === 'answered') status = `<span class="question-status answered">Answered &middot; ${esc(SOURCE_NAMES[m.source] || 'Dashboard')}</span>`;
    else status = `<span class="question-status">${esc(QUESTION_STATUS[m.state] || '')}</span>`;
    if (status) html += `<div class="question-actions">${status}</div>`;
    return html;
  }

  function sendQuestionAnswer(sessionId, m, answers) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      m.error = 'Not connected to the hub';
      renderMessages();
      return;
    }
    state.ws.send(JSON.stringify({ type: 'question_answer', sessionId, requestId: m.requestId, answers }));
    m.state = 'sending';
    m.answers = answers;
    m.source = 'dashboard';
    m.error = null;
    saveMessages();
    renderMessages();
  }

  // Updates the picked button and Send without re-rendering, so the box being typed in keeps its focus.
  function refreshQuestionCard(card, m) {
    const d = state.questionDrafts[m.requestId] || {};
    card.querySelectorAll('.question-option').forEach(btn => {
      const q = m.questions.find(x => x.id === btn.dataset.q);
      const qd = d[q.id] || {};
      const picked = !(qd.other || '').trim() ? qd.choice : null;
      btn.classList.toggle('selected', picked === q.options[Number(btn.dataset.i)].label);
    });
    const send = card.querySelector('.question-send');
    if (send) send.disabled = !readyAnswers(m);
  }

  function bindQuestionCards(el) {
    const sid = state.selectedSession;
    el.querySelectorAll('.question-card').forEach(card => {
      const m = questionMessage(sid, card.dataset.request);
      if (!m || m.state !== 'open') return;
      const d = questionDraft(m.requestId);
      const single = m.questions.length === 1;
      card.querySelectorAll('.question-option').forEach(btn => btn.addEventListener('click', () => {
        const q = m.questions.find(x => x.id === btn.dataset.q);
        const label = q.options[Number(btn.dataset.i)].label;
        if (single) { sendQuestionAnswer(sid, m, { [q.id]: label }); return; }
        d[q.id] = { choice: label, other: '' };
        const input = card.querySelector(`.question-other[data-q="${CSS.escape(q.id)}"]`);
        if (input) input.value = '';
        refreshQuestionCard(card, m);
      }));
      card.querySelectorAll('.question-other').forEach(input => {
        const qid = input.dataset.q;
        input.value = (d[qid] && d[qid].other) || '';
        input.addEventListener('compositionstart', () => { state.composing = true; });
        input.addEventListener('compositionend', () => { state.composing = false; });
        input.addEventListener('input', () => {
          const prev = d[qid] || {};
          d[qid] = { choice: input.value.trim() ? '' : (prev.choice || ''), other: input.value };
          refreshQuestionCard(card, m);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          const answers = readyAnswers(m);
          if (answers) sendQuestionAnswer(sid, m, answers);
        });
      });
      const send = card.querySelector('.question-send');
      if (send) send.addEventListener('click', () => {
        const answers = readyAnswers(m);
        if (answers) sendQuestionAnswer(sid, m, answers);
      });
    });
  }

  function captureQuestionFocus() {
    const a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains('question-other')) return null;
    const card = a.closest('.question-card');
    return card ? { request: card.dataset.request, q: a.dataset.q, start: a.selectionStart, end: a.selectionEnd } : null;
  }

  function restoreQuestionFocus(saved) {
    if (!saved) return;
    const card = [...document.querySelectorAll('.question-card')].find(c => c.dataset.request === saved.request);
    const input = card && card.querySelector(`.question-other[data-q="${CSS.escape(saved.q)}"]`);
    if (!input) return;
    input.focus();
    try { input.setSelectionRange(saved.start, saved.end); } catch {}
  }

  // The 30 s time refresh re-renders the conversation; skipping it while an answer is typed keeps the IME and the caret intact.
  function typingInQuestion() {
    const a = document.activeElement;
    return state.composing || !!(a && a.classList && a.classList.contains('question-other'));
  }

  // --- Permission relay ---
  // Format tool name for display — extract title for notify, friendly names for known tools
  function formatToolName(toolName, inputPreview) {
````

Edit 7 of 7 — replace:

````html
  });

  // Refresh relative times every 30s
  setInterval(() => { renderMessages(); renderNotifications(); }, 30000);

  // Mobile tabs
  document.querySelectorAll('#mobileTabs button').forEach(btn => {
````

with:

````html
  });

  // Refresh relative times every 30s
  setInterval(() => { if (!typingInQuestion()) renderMessages(); renderNotifications(); }, 30000);

  // Mobile tabs
  document.querySelectorAll('#mobileTabs button').forEach(btn => {
````

- [ ] **Step 4: Check the script still parses, then run the tests**

Run: `node -e "const h=require('fs').readFileSync('src/dashboard/index.html','utf8');new Function(h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1]);console.log('parses')"` → `parses`.
Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/dashboard-questions.test.ts test/dashboard-*.test.ts` → all pass (10 new).

- [ ] **Step 5: Run everything**

Run: `npm test` → 621 pass, 0 fail.
Run: `npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/index.html test/dashboard-questions.test.ts
git commit -m "feat(dashboard): questions show as cards in the conversation, answered with one click or with Send for several" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Checks against real parts

No code changes and no commit. Put these three scripts in your scratchpad (not in the repository). Each one starts its own isolated hub on 7984 and prints `CHECK PASSED` or `CHECK FAILED`. Before step 3, tell the user through claude-alarm `reply` that a short Codex turn is about to run in `C:\tmp\codex-ask-probe`. Afterwards, confirm port 7984 is free (`Get-NetTCPConnection -LocalPort 7984 -State Listen` returns nothing) and that no `codex.exe app-server proxy` you started is left (compare with the list from before; stop only your own PIDs).

`check-ask.mts`: a real channel server asks through the Hub, a dashboard socket answers, and the session gets the answer.

````ts
// Task 7 check: a real channel server asks through an isolated hub, a dashboard socket answers, the session gets the answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-ask-check-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const PORT = 7984;
const TOKEN = 'ask-check';
const url = (p: string) => new URL(p, `file:///${repo.replace(/\\/g, '/')}/`).href;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { HubServer } = await import(url('src/hub/server.ts'));
const { default: WebSocket } = await import(url('node_modules/ws/wrapper.mjs'));
const { Client } = await import(url('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const { StdioClientTransport } = await import(url('node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
const { z } = await import(url('node_modules/zod/index.js'));

const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
await hub.start();
const dash = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
const inbox: any[] = [];
dash.on('message', (d: Buffer) => inbox.push(JSON.parse(String(d))));
await new Promise((r) => dash.once('open', r));

const client = new Client({ name: 'ask-check', version: '0' });
const notes: any[] = [];
client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({}).passthrough() }), (n: any) => { notes.push(n.params); });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', path.join(repo, 'src', 'channel', 'server.ts')],
  cwd: repo,
  env: { ...process.env, CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: String(PORT), CLAUDE_ALARM_HUB_TOKEN: TOKEN } as Record<string, string>,
  stderr: 'ignore',
}));

const until = async <T,>(probe: () => T | undefined | false, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = probe(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); }
};

let failed = false;
try {
  await until(() => inbox.find((m) => m.type === 'session_connected' || (m.type === 'sessions_list' && m.sessions.length)));
  const result: any = await client.callTool({ name: 'ask', arguments: { context: 'Check run.', questions: [{ question: 'Pick one', options: [{ label: 'Left' }, { label: 'Right' }] }] } });
  log('ask result:', result.content[0].text);
  const q = await until(() => inbox.find((m) => m.type === 'question'));
  log('dashboard got question', q.requestId, JSON.stringify(q.questions));
  const status = await until(() => inbox.find((m) => m.type === 'session_updated' && m.session.status === 'waiting_input'));
  log('session status', status.session.status);
  dash.send(JSON.stringify({ type: 'question_answer', sessionId: q.sessionId, requestId: q.requestId, answers: { q1: 'Right' } }));
  const resolved = await until(() => inbox.find((m) => m.type === 'question_resolved'));
  log('resolved', resolved.state, JSON.stringify(resolved.answers), resolved.source);
  const note = await until(() => notes.find((n) => n.meta?.questionId === q.requestId));
  log('session got:', JSON.stringify(note.content), 'sender', note.meta.sender);
} catch (err) {
  failed = true;
  log('FAILED', (err as Error).message);
} finally {
  await client.close();
  dash.close();
  await hub.stop();
}
log(failed ? 'CHECK FAILED' : 'CHECK PASSED');
process.exit(failed ? 1 : 0);
````

`check-codex.mts`: a real Codex question reaches the dashboard while the turn waits, and the answer goes back into that turn.

````ts
// Task 7 check: a real Codex question reaches an isolated hub's dashboard at once, and the dashboard's answer reaches Codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-ask-check-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const PORT = 7984;
const TOKEN = 'ask-check';
const PROBE_DIR = 'C:\\tmp\\codex-ask-probe';
const url = (p: string) => new URL(p, `file:///${repo.replace(/\\/g, '/')}/`).href;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

const { HubServer } = await import(url('src/hub/server.ts'));
const { CodexAdapter } = await import(url('src/codex/adapter.ts'));
const { connectProxy } = await import(url('src/codex/transport.ts'));
const { RpcClient } = await import(url('src/codex/rpc.ts'));
const { default: WebSocket } = await import(url('node_modules/ws/wrapper.mjs'));

fs.mkdirSync(PROBE_DIR, { recursive: true });
const HUB = { host: '127.0.0.1', port: PORT, token: TOKEN };
const hub = new HubServer({ hub: HUB, notifications: { desktop: false, sound: false } } as any);
await hub.start();
const dash = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=${TOKEN}`);
const inbox: any[] = [];
dash.on('message', (d: Buffer) => inbox.push(JSON.parse(String(d))));
await new Promise((r) => dash.once('open', r));
const adapter = new CodexAdapter({ command: 'codex', hub: HUB, hostName: 'ask-check' });
adapter.start();

const until = async <T,>(probe: () => T | undefined | false, ms = 120000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = probe(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); }
};

const conn = await connectProxy('codex');
const rpc = new RpcClient(conn.ws);
let failed = false;
let threadId = '';
try {
  await rpc.request('initialize', { clientInfo: { name: 'ask-check-starter', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  rpc.notify('initialized');
  const started = await rpc.request<any>('thread/start', { cwd: PROBE_DIR, sandbox: 'read-only', approvalPolicy: 'never' }, null);
  threadId = started.thread.id;
  const sessionId = `codex:${threadId}`;
  log('thread', threadId);
  await rpc.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'This is a protocol test. Do not read files. Use the request_user_input tool right away to ask me exactly two questions: first, which color I prefer, with the two options "Red" and "Blue"; second, what name to use, as a free-form question. After I answer, reply with one sentence repeating my answers, and stop.' }],
    collaborationMode: { mode: 'plan', settings: { model: started.model, reasoning_effort: null, developer_instructions: null } },
  });
  const q = await until(() => inbox.find((m) => m.type === 'question' && m.sessionId === sessionId));
  log('card on the dashboard:', q.requestId, JSON.stringify({ context: q.context, questions: q.questions }));
  const replyBefore = inbox.some((m) => m.type === 'reply_from_session' && m.sessionId === sessionId);
  log('reply before the answer:', replyBefore);
  dash.send(JSON.stringify({ type: 'question_answer', sessionId, requestId: q.requestId, answers: { q1: 'Blue', q2: 'Probe' } }));
  const resolved = await until(() => inbox.find((m) => m.type === 'question_resolved' && m.sessionId === sessionId));
  log('resolved:', resolved.state, resolved.source);
  const reply = await until(() => inbox.find((m) => m.type === 'reply_from_session' && m.sessionId === sessionId));
  log('Codex replied:', JSON.stringify(reply.content));
  log('question cards for this thread:', inbox.filter((m) => m.type === 'question' && m.sessionId === sessionId).length);
  log('notices for this thread:', JSON.stringify(inbox.filter((m) => m.type === 'notification' && m.sessionId === sessionId).map((m) => m.title)));
  if (replyBefore || !/Blue/.test(reply.content) || /Which color/.test(reply.content)) failed = true;
} catch (err) {
  failed = true;
  log('FAILED', (err as Error).message);
} finally {
  if (threadId) await rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
  await conn.close();
  await adapter.stop();
  dash.close();
  await hub.stop();
}
log(failed ? 'CHECK FAILED' : 'CHECK PASSED');
process.exit(failed ? 1 : 0);
````

`check-hub.mts`: a stand-in session with two questions, for looking at the cards in Chrome.

````ts
// Task 7 check: an isolated hub with a stand-in session that asks two questions, for looking at the cards in a real browser.
// The stand-in refuses an answer whose first question contains "fail", to show the refusal path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const logFile = process.argv[3];
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-ask-check-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const PORT = 7984;
const TOKEN = 'ask-check';
const url = (p: string) => new URL(p, `file:///${repo.replace(/\\/g, '/')}/`).href;
const log = (...a: unknown[]) => fs.appendFileSync(logFile, `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);

const { HubServer } = await import(url('src/hub/server.ts'));
const { default: WebSocket } = await import(url('node_modules/ws/wrapper.mjs'));

const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
await hub.start();
log(`hub on ${PORT}, home ${home}, pid ${process.pid}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/channel?token=${TOKEN}`);
await new Promise((r) => ws.once('open', r));
const sessionId = 'check-1';
ws.send(JSON.stringify({ type: 'register', session: { id: sessionId, name: 'ask-check', status: 'idle', connectedAt: Date.now(), lastActivity: Date.now(), cwd: 'C:/w/ask-check', channelEnabled: true } }));
ws.on('message', (d: Buffer) => {
  const msg = JSON.parse(String(d));
  log('channel got', msg);
  if (msg.type === 'question_answer') {
    const ok = !String(msg.answers.q1 ?? '').includes('fail');
    ws.send(JSON.stringify({ type: 'question_delivery', sessionId, requestId: msg.requestId, ok, ...(ok ? {} : { reason: 'the check session refused it' }) }));
  }
});
await new Promise((r) => setTimeout(r, 500));
ws.send(JSON.stringify({
  type: 'question', sessionId, requestId: 'single-1', timestamp: Date.now(),
  questions: [{ id: 'q1', header: 'Scope', question: 'Who needs the approval alert?', options: [{ label: 'Approvers only', description: 'Badge on the menu, no new table' }, { label: 'Approvers and requesters', description: 'Adds a notifications table' }], allowOther: true }],
}));
ws.send(JSON.stringify({
  type: 'question', sessionId, requestId: 'multi-1', timestamp: Date.now(),
  context: 'Two quick things before I plan. **Jev** split 0.42 / 0.41 on the second.',
  questions: [
    { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: true },
    { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
  ],
}));
log('questions sent');
````

- [ ] **Step 1: Claude `ask`, end to end**

Run (from the worktree): `node --import tsx <scratchpad>/check-ask.mts C:/workspace/claude-alarm-ask`
Expected: the `ask` result begins `Question sent (id`, the dashboard gets the question, the session status becomes `waiting_input`, it resolves `answered {"q1":"Right"} dashboard`, and the session gets `"Answer to your question:\n- Pick one → Right"` from sender `dashboard`. Then `CHECK PASSED`.

- [ ] **Step 2: Cards in Chrome**

Start `node --import tsx <scratchpad>/check-hub.mts C:/workspace/claude-alarm-ask <scratchpad>/check-hub.log` in the background, wait for `questions sent` in the log, and note the PID it logs. Open `http://127.0.0.1:7984/` in a new Chrome tab and sign in with the test token (`POST /api/login` with `{"token":"ask-check"}`, then reload). Select `ask-check`, then check each of these. If coordinate clicks do not land because the tab is in the background, use element references.
- Both cards show. The single question has two option buttons with their descriptions and a box whose placeholder ends `(Enter to send)`. The multi card shows the context and a disabled `Send`.
- On the multi card, pick `Blue` and type `Probe 이름` in the name box. `Send` becomes enabled. Mark the box (`document.activeElement.dataset.mark = 'kept'`), wait 31 s, and check that the same element still has focus and its text.
- Press `Send`. The card shows `→ Blue`, `→ Probe 이름` and `Answered · Dashboard`, and the log shows the `question_answer`.
- On the single card, type `fail please` and press Enter. The card reopens with `the check session refused it`, and `Answer not delivered: the check session refused it` appears under the message box.
- Press `Approvers only`. The card shows `→ Approvers only` and `Answered · Dashboard` with one click.

Close the tab and stop the check hub by its logged PID.

- [ ] **Step 3: A real Codex question**

Run: `node --import tsx <scratchpad>/check-codex.mts C:/workspace/claude-alarm-ask`
Expected: the card appears while the turn waits (about 10 s in the plan check), there is no reply before the answer, it resolves `answered dashboard`, and Codex's reply contains `Blue` without repeating the questions. There is one card and no notices. Then `CHECK PASSED`. The real Hub's own Codex adapter may also see this test conversation; say so to the user.

- [ ] **Step 4: Record the results**

Add the outcomes of steps 1–3 to the Obsidian task note `Projects/claude_alarm/docs/tasks/2026-10-06-질문은-대화로-ask-도구.md` (local vault), then sync that note to the server as `C:/workspace/vault-migration/README.md` describes. The real Telegram screens are checked by the user after a release.
