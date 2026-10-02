import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  STALE_GUARD_MS,
  acquireLock,
  controlEndpoint,
  queryOwner,
  requestStop,
  type Acquired,
  type Attempt,
  type LockOwner,
} from '../src/codex/instance-lock.js';
import { until } from './helpers/fake-codex-daemon.js';

function freshEndpoint(): string {
  return controlEndpoint(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-lock-')));
}

function owner(pid: number, token = 'tok'): LockOwner & { stops: number } {
  const o = { pid, token, stops: 0, onStop: () => { o.stops++; } };
  return o;
}

async function release(...results: Acquired[]): Promise<void> {
  for (const r of results) if (r.kind === 'owner') await r.close();
}

function rawRequest(endpoint: string, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (d: string) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve(data));
  });
}

// --- endpoint names

test('the Windows endpoint is a pipe named after the config directory, ignoring case', () => {
  const a = controlEndpoint('C:\\Users\\A\\.claude-alarm-missing', 'win32');
  assert.match(a, /^\\\\\.\\pipe\\claude-alarm-codex-[0-9a-f]{16}$/);
  assert.equal(controlEndpoint('c:\\users\\a\\.CLAUDE-ALARM-MISSING', 'win32'), a);
  assert.notEqual(controlEndpoint('C:\\Users\\B\\.claude-alarm-missing', 'win32'), a);
});

test('elsewhere the endpoint is codex.sock in the config directory', () => {
  assert.equal(controlEndpoint('/home/u/.claude-alarm', 'linux'), '/home/u/.claude-alarm/codex.sock');
});

// --- real endpoint

test('the first adapter owns the lock and a second one sees it held, with the owner PID', async () => {
  const endpoint = freshEndpoint();
  const a = await acquireLock(endpoint, owner(1111));
  try {
    assert.equal(a.kind, 'owner');
    assert.deepEqual(await acquireLock(endpoint, owner(2222)), { kind: 'held', pid: 1111 });
    assert.deepEqual(await queryOwner(endpoint), { state: 'running', pid: 1111 });
  } finally { await release(a); }
});

test('of two simultaneous starts exactly one owns the lock', async () => {
  const endpoint = freshEndpoint();
  const results = await Promise.all([acquireLock(endpoint, owner(1)), acquireLock(endpoint, owner(2))]);
  try {
    assert.deepEqual(results.map((r) => r.kind).sort(), ['held', 'owner']);
  } finally { await release(...results); }
});

test('after the owner closes, nobody answers and the lock can be taken again', async () => {
  const endpoint = freshEndpoint();
  const a = await acquireLock(endpoint, owner(1));
  assert.equal(a.kind, 'owner');
  await release(a);
  assert.deepEqual(await queryOwner(endpoint), { state: 'absent' });
  const b = await acquireLock(endpoint, owner(2));
  try {
    assert.equal(b.kind, 'owner');
  } finally { await release(b); }
});

test('a stop with the right token is acknowledged, then the owner is told to stop', async () => {
  const endpoint = freshEndpoint();
  const o = owner(7, 'secret');
  const a = await acquireLock(endpoint, o);
  try {
    assert.deepEqual(await requestStop(endpoint, 'wrong'), { state: 'unauthorized' });
    assert.equal(o.stops, 0);
    assert.deepEqual(await requestStop(endpoint, 'secret'), { state: 'stopping', pid: 7 });
    await until(() => o.stops === 1);
  } finally { await release(a); }
});

test('an owner without a token refuses every stop', async () => {
  const endpoint = freshEndpoint();
  const o = owner(7, '');
  const a = await acquireLock(endpoint, o);
  try {
    assert.deepEqual(await requestStop(endpoint, ''), { state: 'unauthorized' });
    assert.equal(o.stops, 0);
  } finally { await release(a); }
});

test('a stop with nobody listening is absent', async () => {
  assert.deepEqual(await requestStop(freshEndpoint(), 'tok'), { state: 'absent' });
});

test('an unknown or unreadable request gets an error line', async () => {
  const endpoint = freshEndpoint();
  const a = await acquireLock(endpoint, owner(1));
  try {
    assert.equal(await rawRequest(endpoint, '{"type":"dance"}\n'), '{"type":"error","error":"unknown request"}\n');
    assert.equal(await rawRequest(endpoint, 'not json\n'), '{"type":"error","error":"unknown request"}\n');
  } finally { await release(a); }
});

test('a client that never finishes its request is dropped, and others are answered meanwhile', async () => {
  const endpoint = freshEndpoint();
  const a = await acquireLock(endpoint, owner(1));
  try {
    const idle = net.connect(endpoint);
    idle.on('error', () => {});
    const closed = new Promise((resolve) => idle.on('close', resolve));
    idle.write('{"type":"sta');
    const started = Date.now();
    assert.deepEqual(await queryOwner(endpoint), { state: 'running', pid: 1 });
    await closed;
    assert.ok(Date.now() - started < 3500);
  } finally { await release(a); }
});

test('a request over 4096 bytes without a newline is dropped', async () => {
  const endpoint = freshEndpoint();
  const a = await acquireLock(endpoint, owner(1));
  try {
    assert.equal(await rawRequest(endpoint, 'x'.repeat(5000)), '');
  } finally { await release(a); }
});

test('an endpoint that answers garbage or nothing is unknown', async () => {
  const endpoint = freshEndpoint();
  const garbage = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.end('nope\n')); });
  await new Promise<void>((resolve) => garbage.listen(endpoint, () => resolve()));
  try {
    assert.deepEqual(await queryOwner(endpoint), { state: 'unknown', error: 'unreadable reply' });
  } finally { await new Promise((resolve) => garbage.close(resolve)); }

  const silent = freshEndpoint();
  const mute = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise<void>((resolve) => mute.listen(silent, () => resolve()));
  try {
    assert.deepEqual(await queryOwner(silent, 200), { state: 'unknown', error: 'no answer within 200ms' });
  } finally { mute.close(); }
});

test('an endpoint held by something that does not answer is unknown, never a second owner', async () => {
  const endpoint = freshEndpoint();
  const squatter = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise<void>((resolve) => squatter.listen(endpoint, () => resolve()));
  try {
    const r = await acquireLock(endpoint, owner(1), { queryOwner: (e) => queryOwner(e, 200) });
    assert.deepEqual(r, { kind: 'unknown', error: 'no answer within 200ms' });
  } finally { squatter.close(); }
});

// --- Windows retry and the POSIX socket-file path, with fakes

const NOW = 1_000_000;
const SOCK = '/home/u/.claude-alarm/codex.sock';
const ownerAttempt = (): Attempt => ({ kind: 'owner', close: async () => {} });

function fakeFs(guardAgeMs?: number) {
  const dirs = new Map<string, number>();
  if (guardAgeMs !== undefined) dirs.set(`${SOCK}.lock`, NOW - guardAgeMs);
  const calls: string[] = [];
  const fsFake = {
    mkdirSync: (p: string) => {
      calls.push(`mkdir ${p}`);
      if (dirs.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      dirs.set(p, NOW);
    },
    rmdirSync: (p: string) => { calls.push(`rmdir ${p}`); dirs.delete(p); },
    statSync: (p: string) => {
      if (!dirs.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { mtimeMs: dirs.get(p)! };
    },
    unlinkSync: (p: string) => { calls.push(`unlink ${p}`); },
  };
  return { calls, fs: fsFake as any };
}

function scripted(attempts: Attempt[]) {
  let count = 0;
  return { listen: async () => { count++; return attempts.shift()!; }, count: () => count };
}

test('on Windows a busy pipe whose owner just left is listened on again', async () => {
  const l = scripted([{ kind: 'busy' }, ownerAttempt()]);
  const r = await acquireLock('\\\\.\\pipe\\x', owner(1), { platform: 'win32', listen: l.listen, queryOwner: async () => ({ state: 'absent' }) });
  assert.equal(r.kind, 'owner');
  assert.equal(l.count(), 2);
});

test('on Windows a pipe that stays busy without answering is unknown', async () => {
  const l = scripted([{ kind: 'busy' }, { kind: 'busy' }]);
  const r = await acquireLock('\\\\.\\pipe\\x', owner(1), { platform: 'win32', listen: l.listen, queryOwner: async () => ({ state: 'absent' }) });
  assert.deepEqual(r, { kind: 'unknown', error: 'the control pipe is in use but does not answer' });
});

test('outside Windows a dead socket file is removed under a guard and the lock taken', async () => {
  const f = fakeFs();
  const l = scripted([{ kind: 'busy' }, ownerAttempt()]);
  const r = await acquireLock(SOCK, owner(1), { platform: 'linux', fs: f.fs, now: () => NOW, listen: l.listen, queryOwner: async () => ({ state: 'absent' }) });
  assert.equal(r.kind, 'owner');
  assert.deepEqual(f.calls, [`mkdir ${SOCK}.lock`, `unlink ${SOCK}`, `rmdir ${SOCK}.lock`]);
});

test('a fresh guard means another adapter is starting, and nothing is removed', async () => {
  const f = fakeFs(1000);
  const l = scripted([{ kind: 'busy' }]);
  const r = await acquireLock(SOCK, owner(1), { platform: 'linux', fs: f.fs, now: () => NOW, listen: l.listen, queryOwner: async () => ({ state: 'absent' }) });
  assert.deepEqual(r, { kind: 'unknown', error: 'another Codex adapter is starting' });
  assert.deepEqual(f.calls, [`mkdir ${SOCK}.lock`]);
});

test('a guard older than 10 s is cleared and recovery goes on', async () => {
  const f = fakeFs(STALE_GUARD_MS + 1);
  const l = scripted([{ kind: 'busy' }, ownerAttempt()]);
  const r = await acquireLock(SOCK, owner(1), { platform: 'linux', fs: f.fs, now: () => NOW, listen: l.listen, queryOwner: async () => ({ state: 'absent' }) });
  assert.equal(r.kind, 'owner');
  assert.deepEqual(f.calls, [`mkdir ${SOCK}.lock`, `rmdir ${SOCK}.lock`, `mkdir ${SOCK}.lock`, `unlink ${SOCK}`, `rmdir ${SOCK}.lock`]);
});

test('an owner that appears while the guard is taken wins, and the socket is left alone', async () => {
  const f = fakeFs();
  const answers = [{ state: 'absent' as const }, { state: 'running' as const, pid: 42 }];
  const l = scripted([{ kind: 'busy' }]);
  const r = await acquireLock(SOCK, owner(1), { platform: 'linux', fs: f.fs, now: () => NOW, listen: l.listen, queryOwner: async () => answers.shift()! });
  assert.deepEqual(r, { kind: 'held', pid: 42 });
  assert.deepEqual(f.calls, [`mkdir ${SOCK}.lock`, `rmdir ${SOCK}.lock`]);
});

test('a socket path longer than 103 bytes is refused without listening', async () => {
  const long = `/home/${'x'.repeat(100)}/.claude-alarm/codex.sock`;
  const l = scripted([]);
  const r = await acquireLock(long, owner(1), { platform: 'linux', listen: l.listen });
  assert.deepEqual(r, { kind: 'unknown', error: `control socket path is too long: ${long}` });
  assert.equal(l.count(), 0);
});
