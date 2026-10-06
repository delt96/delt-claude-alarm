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
