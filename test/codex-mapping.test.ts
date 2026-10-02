import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFolder, codexSessionId, finalAnswer, hubStatus, isTrackable, threadTitle, withSourcePrefix, type CodexThread } from '../src/codex/mapping.js';

const thread = (extra: Partial<CodexThread> = {}): CodexThread => ({ id: '01a0f656-434c', name: null, preview: '', cwd: 'C:\\tmp\\codex-test', status: { type: 'idle' }, ...extra });

test('codexSessionId prefixes the thread id', () => {
  assert.equal(codexSessionId('abc'), 'codex:abc');
});

test('only loaded top-level persistent threads are tracked', () => {
  assert.equal(isTrackable(thread()), true);
  assert.equal(isTrackable(thread({ status: { type: 'active', activeFlags: [] } })), true);
  assert.equal(isTrackable(thread({ status: { type: 'notLoaded' } })), false);
  assert.equal(isTrackable(thread({ parentThreadId: 'parent' })), false);
  assert.equal(isTrackable(thread({ ephemeral: true })), false);
});

test('threadTitle prefers the name, then a trimmed preview, then the folder', () => {
  assert.equal(threadTitle(thread({ name: '  Fix login  ' })), 'Fix login');
  assert.equal(threadTitle(thread({ preview: 'Write the release notes\nfor version two' })), 'Write the release notes for ve…');
  assert.equal(threadTitle(thread({ preview: 'short' })), 'short');
  assert.equal(threadTitle(thread()), 'codex-test');
  assert.equal(threadTitle(thread({ cwd: '' })), '01a0f656');
});

test('hubStatus maps Codex thread status', () => {
  assert.equal(hubStatus({ type: 'idle' }), 'idle');
  assert.equal(hubStatus({ type: 'systemError' }), 'idle');
  assert.equal(hubStatus({ type: 'notLoaded' }), 'idle');
  assert.equal(hubStatus({ type: 'active', activeFlags: [] }), 'working');
  assert.equal(hubStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'waiting_input');
  assert.equal(hubStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }), 'waiting_input');
});

test('withSourcePrefix marks where the instruction came from', () => {
  assert.equal(withSourcePrefix('run tests', 'dashboard'), '[claude-alarm · Dashboard] run tests');
  assert.equal(withSourcePrefix('run tests', 'telegram'), '[claude-alarm · Telegram] run tests');
  assert.equal(withSourcePrefix('run tests', 'api'), '[claude-alarm · API] run tests');
  assert.equal(withSourcePrefix('run tests'), '[claude-alarm] run tests');
});

test('finalAnswer joins final answers and falls back to the last message', () => {
  assert.equal(finalAnswer([{ text: 'looking', phase: 'commentary' }, { text: 'done', phase: 'final_answer' }]), 'done');
  assert.equal(finalAnswer([{ text: 'a', phase: 'final_answer' }, { text: 'b', phase: 'final_answer' }]), 'a\n\nb');
  assert.equal(finalAnswer([{ text: 'first' }, { text: 'last' }]), 'last');
  assert.equal(finalAnswer([]), null);
});

test('pasted folders lose surrounding spaces and one pair of double quotes', () => {
  assert.equal(cleanFolder('  "C:\\work\\새 프로젝트"  '), 'C:\\work\\새 프로젝트');
  assert.equal(cleanFolder('C:\\work'), 'C:\\work');
  assert.equal(cleanFolder('"'), '"');
  assert.equal(cleanFolder('""'), '');
});
