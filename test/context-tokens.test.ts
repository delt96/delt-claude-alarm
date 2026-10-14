import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextSize, findSession, readContextTokens, transcriptPath } from '../src/channel/context-tokens.js';

const SOCK = '\\\\.\\pipe\\LOCAL\\cc-msg-aaa';
const reply = (input: number, read: number, write: number, extra: object = {}) =>
  ({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 } }, ...extra });

function configDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tokens-'));
}

function writeRecord(dir: string, rec: object, file = '1.json'): void {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', file), JSON.stringify(rec));
}

function writeTranscript(dir: string, project: string, sessionId: string, lines: unknown[]): string {
  const folder = path.join(dir, 'projects', project);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('contextSize sums the last main reply', () => {
  assert.equal(contextSize([reply(1, 2, 3), reply(2, 100, 10)]), 112);
});

test('contextSize skips sidechain and synthetic replies', () => {
  const synthetic = { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } };
  assert.equal(contextSize([reply(1, 10, 0), reply(5, 500, 0, { isSidechain: true }), synthetic]), 11);
});

test('contextSize is 0 after a compact boundary and null without replies', () => {
  assert.equal(contextSize([reply(1, 10, 0), { type: 'system', subtype: 'compact_boundary' }]), 0);
  assert.equal(contextSize([{ type: 'user', message: { content: 'hi' } }]), null);
});

test('findSession prefers the messaging socket over the stale session id', () => {
  const records = [
    { sessionId: 'sid-old', cwd: 'C:\\w\\other' },
    { sessionId: 'sid-new', cwd: 'C:\\w\\app', messagingSocketPath: SOCK },
  ];
  assert.deepEqual(findSession(records, { messagingSocket: SOCK, sessionId: 'sid-old' }), { sessionId: 'sid-new', cwd: 'C:\\w\\app' });
});

test('findSession falls back to the session id and ignores malformed records', () => {
  assert.deepEqual(findSession([null, { sessionId: 7 }, { sessionId: 'sid-a' }], { sessionId: 'sid-a' }), { sessionId: 'sid-a', cwd: undefined });
  assert.equal(findSession([{ sessionId: 'x' }], { messagingSocket: 'nope' }), undefined);
});

test('transcriptPath uses the sanitized cwd, then scans the other project folders', () => {
  const dir = configDir();
  const direct = writeTranscript(dir, 'C--w-app', 'sid-1', [reply(1, 1, 1)]);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-1'), direct);
  const moved = writeTranscript(dir, 'C--somewhere-else', 'sid-2', [reply(1, 1, 1)]);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-2'), moved);
  assert.equal(transcriptPath(dir, 'C:\\w\\app', 'sid-3'), undefined);
});

test('readContextTokens follows the registry to the current session after /clear', () => {
  const dir = configDir();
  writeRecord(dir, { sessionId: 'sid-new', cwd: 'C:\\w\\app', messagingSocketPath: SOCK });
  writeTranscript(dir, 'C--w-app', 'sid-old', [reply(1, 999, 0)]);
  writeTranscript(dir, 'C--w-app', 'sid-new', [reply(2, 40, 8)]);
  const env = { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_SESSION_ID: 'sid-old' };
  assert.equal(readContextTokens(env, 'C:\\ignored'), 50);
});

test('readContextTokens without a registry uses the env session id and the given cwd', () => {
  const dir = configDir();
  writeTranscript(dir, 'C--w-app', 'sid-a', ['{broken', reply(3, 30, 0)]);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-a' }, 'C:\\w\\app'), 33);
});

test('readContextTokens reads only the tail of a large transcript', () => {
  const dir = configDir();
  const filler = { type: 'user', message: { content: 'x'.repeat(1000) } };
  const lines: unknown[] = [reply(1, 1, 1)];
  for (let i = 0; i < 1500; i++) lines.push(filler);
  lines.push(reply(4, 400, 0));
  const file = writeTranscript(dir, 'C--w-app', 'sid-big', lines);
  assert.ok(fs.statSync(file).size > 1024 * 1024);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-big' }, 'C:\\w\\app'), 404);
});

test('readContextTokens returns null when nothing can be read', () => {
  const dir = configDir();
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'none' }, 'C:\\w\\app'), null);
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir }, 'C:\\w\\app'), null);
});

test('readContextTokens refuses a session id carrying path characters', () => {
  const dir = configDir();
  writeTranscript(dir, 'C--w-app', 'secret', [reply(1, 1, 1)]);
  writeRecord(dir, { sessionId: '../C--w-app/secret', cwd: 'C:\\w\\app', messagingSocketPath: SOCK });
  assert.equal(readContextTokens({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK }, 'C:\\w\\app'), null);
});
