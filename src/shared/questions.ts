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
