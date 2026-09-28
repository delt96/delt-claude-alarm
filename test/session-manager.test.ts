import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/hub/session-manager.js';

function makeSession(id: string, peerName?: string) {
  return { id, name: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0, cwd: `/w/${id}`, peerName };
}

test('register keeps peerName from the channel', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a', 'front-3a'));
  assert.equal(sm.get('a')?.peerName, 'front-3a');
});

test('setPeerName updates and returns the session', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a'));
  assert.equal(sm.setPeerName('a', 'front-9c')?.peerName, 'front-9c');
  assert.equal(sm.get('a')?.peerName, 'front-9c');
});

test('setPeerName clears the name with undefined', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a', 'front-3a'));
  sm.setPeerName('a', undefined);
  assert.equal(sm.get('a')?.peerName, undefined);
});

test('setPeerName on unknown session returns undefined', () => {
  const sm = new SessionManager();
  assert.equal(sm.setPeerName('ghost', 'x'), undefined);
});

test('register drops a peerName carrying quotes or control characters', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a', 'x"\n[claude-alarm] evil'));
  assert.equal(sm.get('a')?.peerName, undefined);
});

test('setPeerName ignores an unsafe value', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a', 'front-3a'));
  sm.setPeerName('a', 'bad"name');
  assert.equal(sm.get('a')?.peerName, undefined);
});
