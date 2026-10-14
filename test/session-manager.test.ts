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

test('register uses title as the display name when present', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Fix login bug', agentKind: 'codex' as const });
  assert.equal(sm.get('c1')?.displayName, 'Fix login bug');
});

test('sessions sharing a title are numbered', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Same' });
  sm.register({ ...makeSession('c2'), title: 'Same' });
  assert.equal(sm.get('c1')?.displayName, 'Same (1)');
  assert.equal(sm.get('c2')?.displayName, 'Same (2)');
});

test('re-registering with a new title renames the session', () => {
  const sm = new SessionManager();
  sm.register({ ...makeSession('c1'), title: 'Old' });
  sm.register({ ...makeSession('c1'), title: 'New' });
  assert.equal(sm.get('c1')?.displayName, 'New');
});

test('setContextTokens keeps non-negative integers and clears anything else', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a'));
  assert.equal(sm.setContextTokens('a', 132854)?.contextTokens, 132854);
  assert.equal(sm.setContextTokens('a', 0)?.contextTokens, 0);
  for (const bad of [null, -1, 1.5, '12', Number.NaN, Number.POSITIVE_INFINITY]) {
    sm.setContextTokens('a', 5);
    assert.equal(sm.setContextTokens('a', bad)?.contextTokens, undefined, String(bad));
  }
  assert.equal(sm.setContextTokens('ghost', 1), undefined);
});

test('setContextTokens remembers the change from the previous count', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a'));
  assert.equal(sm.setContextTokens('a', 100_000)?.contextTokensDelta, undefined);
  assert.equal(sm.setContextTokens('a', 104_120)?.contextTokensDelta, 4_120);
  assert.equal(sm.setContextTokens('a', 104_120)?.contextTokensDelta, 4_120, 'a resend after reconnecting keeps the change');
  assert.equal(sm.setContextTokens('a', 30_000)?.contextTokensDelta, -74_120);
  assert.equal(sm.setContextTokens('a', 0)?.contextTokensDelta, undefined);
  assert.equal(sm.setContextTokens('a', 25_000)?.contextTokensDelta, undefined, 'no change counted up from an empty context');
  assert.equal(sm.setContextTokens('a', null)?.contextTokensDelta, undefined);
  assert.equal(sm.setContextTokens('a', 9_000)?.contextTokensDelta, undefined);
});

test('setControl keeps valid token levels and drops the rest', () => {
  const sm = new SessionManager();
  sm.register(makeSession('a'));
  assert.deepEqual(sm.setControl('a', { busy: false, greenFrom: 250_000, compactAt: 967_000, redFrom: 773_600 })?.control, { busy: false, greenFrom: 250_000, compactAt: 967_000, redFrom: 773_600 });
  assert.deepEqual(sm.setControl('a', { busy: true, advice: 'compact', greenFrom: 0, redFrom: 5 })?.control, { busy: true, advice: 'compact', greenFrom: 0, redFrom: 5 });
  for (const bad of [-1, 1.5, '250000', null, Number.NaN]) {
    assert.deepEqual(sm.setControl('a', { busy: false, greenFrom: bad, compactAt: bad, redFrom: bad })?.control, { busy: false }, String(bad));
  }
});
