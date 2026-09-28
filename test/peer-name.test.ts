import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPeerName, readPeerName } from '../src/channel/peer-name.js';

const SOCK_A = '\\\\.\\pipe\\LOCAL\\cc-msg-aaa';
const SOCK_B = '\\\\.\\pipe\\LOCAL\\cc-msg-bbb';
const recA = { pid: 1, sessionId: 'sid-a', messagingSocketPath: SOCK_A, name: 'front-3a' };
const recB = { pid: 2, sessionId: 'sid-b', messagingSocketPath: SOCK_B, name: 'back-7f' };

test('matches by messaging socket', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: SOCK_B }), 'back-7f');
});

test('falls back to session id when socket is absent', () => {
  assert.equal(findPeerName([recA, recB], { sessionId: 'sid-a' }), 'front-3a');
});

test('socket match wins over session id match', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: SOCK_A, sessionId: 'sid-b' }), 'front-3a');
});

test('falls back to session id when socket matches nothing', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: 'nope', sessionId: 'sid-b' }), 'back-7f');
});

test('returns undefined when nothing matches', () => {
  assert.equal(findPeerName([recA, recB], { messagingSocket: 'nope', sessionId: 'nope' }), undefined);
});

test('returns undefined when env is empty', () => {
  assert.equal(findPeerName([recA, recB], {}), undefined);
});

test('ignores empty or non-string names', () => {
  const blank = { ...recA, name: '  ' };
  const numeric = { ...recB, name: 42 };
  assert.equal(findPeerName([blank], { messagingSocket: SOCK_A }), undefined);
  assert.equal(findPeerName([numeric], { messagingSocket: SOCK_B }), undefined);
});

test('skips malformed records', () => {
  assert.equal(findPeerName([null, 'x', 7, recB], { messagingSocket: SOCK_B }), 'back-7f');
});

function makeConfigDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-name-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'sessions', name), body);
  }
  return dir;
}

test('readPeerName reads registry and skips corrupt files', () => {
  const dir = makeConfigDir({
    '1.json': '{ not json',
    '2.json': JSON.stringify(recB),
    '2.abc.key': 'secret',
  });
  const name = readPeerName({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: SOCK_B });
  assert.equal(name, 'back-7f');
});

test('readPeerName returns undefined when sessions dir is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-name-'));
  assert.equal(readPeerName({ CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sid-a' }), undefined);
});

test('readPeerName returns undefined without lookup env', () => {
  const dir = makeConfigDir({ '2.json': JSON.stringify(recB) });
  assert.equal(readPeerName({ CLAUDE_CONFIG_DIR: dir }), undefined);
});
