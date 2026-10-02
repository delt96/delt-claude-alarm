# Codex Adapter, Telegram and Dashboard Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only one Codex adapter ever runs per config directory, `codex stop`/`status` stop trusting PIDs, and the remaining adapter, Telegram and dashboard failures stop being silent.

**Architecture:** A new `src/codex/instance-lock.ts` turns a named pipe (Windows) or `codex.sock` (elsewhere) into both the single-instance lock and a tiny JSON-line control channel (`status`, `stop`). `src/codex/main.ts` takes the lock before creating the adapter (a hub-supervised adapter waits and takes over; a standalone one reports over IPC and exits), and `codex start`/`stop`/`status` ask the endpoint instead of reading `codex.pid` (new `src/codex/control-cli.ts`). The other fixes are local: supervisor environment, proxy handshake timeout, `.cmd`/`.bat` paths, unrelayed terminal turns, approval-relay failures, Telegram selection/expiry/length/photo handling, and dashboard upload rejections.

**Tech Stack:** TypeScript (ESM), Node built-ins (`net`, `crypto`, `child_process`, `fs`, global `fetch`), `ws`, `node:test` + `tsx`, tsup.

**Spec:** `docs/superpowers/specs/2026-10-02-codex-stabilization-design.md`

## Global Constraints

- No new dependencies.
- Control endpoint: Windows `\\.\pipe\claude-alarm-codex-<first 16 hex of sha256(lowercased realpath of the config dir)>`; elsewhere `<config dir>/codex.sock`, refused when its UTF-8 length exceeds 103 bytes.
- Control protocol: one JSON line each way. `{"type":"status"}` → `{"type":"status","protocol":1,"pid":N}`; `{"type":"stop","token":T}` → `{"type":"stopping","pid":N}` or `{"type":"error","error":"unauthorized"}`; anything else → `{"type":"error","error":"unknown request"}`. The server drops a connection with no newline after 2000 ms or more than 4096 bytes.
- The stop token is `config.hub.token` from `config.json`, never `CLAUDE_ALARM_HUB_TOKEN`. An empty token refuses every stop.
- New code never reads or writes `codex.pid` except the CLI's legacy note.
- Supervised waiting: 2000 ms doubling to 30 000 ms. Proxy handshake limit 10 000 ms. Stop wait 5000 ms polled every 100 ms. Telegram visible limit 4000 characters. Photo and upload limit `10 * 1024 * 1024` bytes. At most 20 open Telegram selection prompts.
- All user-facing strings are English and must match the spec character for character; each task holds the ones it needs.
- Comments: none, except a one-line English "why" where the code alone would mislead. The code blocks below already contain the allowed ones.
- Tests run with `npm test` (`node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 "test/**/*.test.ts"`). Every new test file starts with `import './isolate-home.js';`. Existing tests start isolated hubs on ports 7980–7998 — that is allowed and expected; new hub tests use port 7989. Never use port 7900. Never start a real Codex daemon: adapter processes in tests get `codex.command` pointing at a file that does not exist. Kill only processes the test itself started (by `ChildProcess` handle), never by image name. Nothing may call the real Telegram API: Telegram tests mock `globalThis.fetch`.
- Platform: Windows is the primary target; code must also run on POSIX.

## Review Focus

1. `codex stop` while a hub-supervised adapter is waiting: the waiting one takes over at once, so the endpoint answers with a different PID → must print `Codex adapter stopped (PID: <old>)`, exit 0, not "still running". Test: Task 3 `stopAdapter` takeover case.
2. A client connects to the control endpoint and never finishes its line → others must still get `status` answers meanwhile, and the idle client is dropped within ~2 s. Test: Task 1 idle-client case.
3. A Telegram photo over 10 MB sent while several sessions are open → refused before a selection prompt is sent or anything is downloaded. Test: Task 8 first photo case.
4. Truncating a long Telegram notification inside an emoji or inside a code fence → no lone surrogate, balanced `<pre>` tags. Test: Task 8 emoji and code-fence cases.
5. `CLAUDE_ALARM_HUB_TOKEN` set in the shell that runs the hub → must not reach the adapter's environment. Test: Task 4 `adapterEnv` case.

---

### Task 1: Instance lock and control channel

**Files:**
- Create: `src/codex/instance-lock.ts`
- Test: `test/codex-instance-lock.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2 and 3):
  - `export const CONTROL_PROTOCOL = 1`, `export const STALE_GUARD_MS = 10_000`
  - `export type OwnerState = { state: 'running'; pid: number } | { state: 'absent' } | { state: 'unknown'; error: string }`
  - `export type StopResult = { state: 'stopping'; pid: number } | { state: 'unauthorized' } | { state: 'absent' } | { state: 'unknown'; error: string }`
  - `export type Acquired = { kind: 'owner'; close: () => Promise<void> } | { kind: 'held'; pid: number } | { kind: 'unknown'; error: string }`
  - `export type Attempt = Acquired | { kind: 'busy' }`
  - `export interface LockOwner { pid: number; token: string; onStop: () => void }`
  - `export interface LockDeps { platform?; listen?; queryOwner?; fs?; now? }`
  - `controlEndpoint(configDir: string, platform?: NodeJS.Platform): string`
  - `queryOwner(endpoint: string, timeoutMs = 1000): Promise<OwnerState>`
  - `requestStop(endpoint: string, token: string, timeoutMs = 1000): Promise<StopResult>`
  - `listenControl(endpoint: string, owner: LockOwner): Promise<Attempt>`
  - `acquireLock(endpoint: string, owner: LockOwner, deps?: LockDeps): Promise<Acquired>`

- [ ] **Step 1: Write the failing tests**

Create `test/codex-instance-lock.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-instance-lock.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/instance-lock.js'`.

- [ ] **Step 3: Implement**

Create `src/codex/instance-lock.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const CONTROL_PROTOCOL = 1;
export const STALE_GUARD_MS = 10_000;
const MAX_LINE_BYTES = 4096;
const REQUEST_IDLE_MS = 2000;
const MAX_SOCKET_PATH_BYTES = 103;

export type OwnerState =
  | { state: 'running'; pid: number }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

export type StopResult =
  | { state: 'stopping'; pid: number }
  | { state: 'unauthorized' }
  | { state: 'absent' }
  | { state: 'unknown'; error: string };

export type Acquired =
  | { kind: 'owner'; close: () => Promise<void> }
  | { kind: 'held'; pid: number }
  | { kind: 'unknown'; error: string };

export type Attempt = Acquired | { kind: 'busy' };

export interface LockOwner {
  pid: number;
  token: string;
  onStop: () => void;
}

type LockFs = Pick<typeof fs, 'mkdirSync' | 'rmdirSync' | 'statSync' | 'unlinkSync'>;

export interface LockDeps {
  platform?: NodeJS.Platform;
  listen?: (endpoint: string, owner: LockOwner) => Promise<Attempt>;
  queryOwner?: (endpoint: string) => Promise<OwnerState>;
  fs?: LockFs;
  now?: () => number;
}

export function controlEndpoint(configDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.posix.join(configDir, 'codex.sock');
  let dir: string;
  try {
    dir = fs.realpathSync.native(configDir);
  } catch {
    dir = path.win32.resolve(configDir);
  }
  const hash = crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\claude-alarm-codex-${hash}`;
}

type Answer = { reply: unknown } | { state: 'absent' } | { state: 'unknown'; error: string };

function ask(endpoint: string, request: object, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const socket = net.connect(endpoint);
    const finish = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ state: 'unknown', error: `no answer within ${timeoutMs}ms` }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) finish({ state: 'unknown', error: 'reply too long' });
        return;
      }
      try {
        finish({ reply: JSON.parse(buffer.slice(0, end)) });
      } catch {
        finish({ state: 'unknown', error: 'unreadable reply' });
      }
    });
    socket.on('end', () => finish({ state: 'unknown', error: 'closed without a reply' }));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') finish({ state: 'absent' });
      else finish({ state: 'unknown', error: err.code ?? err.message });
    });
  });
}

export async function queryOwner(endpoint: string, timeoutMs = 1000): Promise<OwnerState> {
  const answer = await ask(endpoint, { type: 'status' }, timeoutMs);
  if (!('reply' in answer)) return answer;
  const reply = answer.reply as { type?: unknown; protocol?: unknown; pid?: unknown } | null;
  if (reply?.type === 'status' && reply.protocol === CONTROL_PROTOCOL && Number.isInteger(reply.pid)) {
    return { state: 'running', pid: reply.pid as number };
  }
  return { state: 'unknown', error: 'unexpected reply' };
}

export async function requestStop(endpoint: string, token: string, timeoutMs = 1000): Promise<StopResult> {
  const answer = await ask(endpoint, { type: 'stop', token }, timeoutMs);
  if (!('reply' in answer)) return answer;
  const reply = answer.reply as { type?: unknown; pid?: unknown; error?: unknown } | null;
  if (reply?.type === 'stopping' && Number.isInteger(reply.pid)) return { state: 'stopping', pid: reply.pid as number };
  if (reply?.type === 'error' && reply.error === 'unauthorized') return { state: 'unauthorized' };
  return { state: 'unknown', error: 'unexpected reply' };
}

const line = (message: object) => `${JSON.stringify(message)}\n`;

function controlServer(owner: LockOwner): net.Server {
  return net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    const idle = setTimeout(() => socket.destroy(), REQUEST_IDLE_MS);
    socket.on('close', () => clearTimeout(idle));
    const onData = (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) socket.destroy();
        return;
      }
      socket.off('data', onData);
      clearTimeout(idle);
      let request: { type?: unknown; token?: unknown } | null = null;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {}
      if (request?.type === 'status') {
        socket.end(line({ type: 'status', protocol: CONTROL_PROTOCOL, pid: owner.pid }));
      } else if (request?.type === 'stop' && owner.token !== '' && request.token === owner.token) {
        socket.end(line({ type: 'stopping', pid: owner.pid }), () => owner.onStop());
      } else if (request?.type === 'stop') {
        socket.end(line({ type: 'error', error: 'unauthorized' }));
      } else {
        socket.end(line({ type: 'error', error: 'unknown request' }));
      }
    };
    socket.on('data', onData);
  });
}

export function listenControl(endpoint: string, owner: LockOwner): Promise<Attempt> {
  const server = controlServer(owner);
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? { kind: 'busy' } : { kind: 'unknown', error: err.code ?? err.message });
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      server.on('error', () => {});
      resolve({ kind: 'owner', close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

function settle(attempt: Attempt, busy: string): Acquired {
  return attempt.kind === 'busy' ? { kind: 'unknown', error: busy } : attempt;
}

export async function acquireLock(endpoint: string, owner: LockOwner, deps: LockDeps = {}): Promise<Acquired> {
  const platform = deps.platform ?? process.platform;
  const listen = deps.listen ?? listenControl;
  const query = deps.queryOwner ?? ((e: string) => queryOwner(e));
  if (platform !== 'win32' && Buffer.byteLength(endpoint) > MAX_SOCKET_PATH_BYTES) {
    return { kind: 'unknown', error: `control socket path is too long: ${endpoint}` };
  }
  const first = await listen(endpoint, owner);
  if (first.kind !== 'busy') return first;
  const state = await query(endpoint);
  if (state.state === 'running') return { kind: 'held', pid: state.pid };
  if (state.state === 'unknown') return { kind: 'unknown', error: state.error };
  if (platform === 'win32') return settle(await listen(endpoint, owner), 'the control pipe is in use but does not answer');
  return recoverSocket(endpoint, owner, listen, query, deps.fs ?? fs, deps.now ?? Date.now);
}

// Two starters that both find a dead socket file would each unlink it, and the second unlink would remove the first one's live socket.
async function recoverSocket(
  endpoint: string,
  owner: LockOwner,
  listen: (endpoint: string, owner: LockOwner) => Promise<Attempt>,
  query: (endpoint: string) => Promise<OwnerState>,
  f: LockFs,
  now: () => number,
): Promise<Acquired> {
  const guard = `${endpoint}.lock`;
  const blocked = takeGuard(guard, f, now);
  if (blocked) return { kind: 'unknown', error: blocked };
  try {
    const state = await query(endpoint);
    if (state.state === 'running') return { kind: 'held', pid: state.pid };
    if (state.state === 'unknown') return { kind: 'unknown', error: state.error };
    try {
      f.unlinkSync(endpoint);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unknown', error: (err as Error).message };
    }
    return settle(await listen(endpoint, owner), 'the control socket is in use but does not answer');
  } finally {
    try {
      f.rmdirSync(guard);
    } catch {}
  }
}

function takeGuard(guard: string, f: LockFs, now: () => number): string | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      f.mkdirSync(guard);
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return (err as Error).message;
    }
    let age: number;
    try {
      age = now() - f.statSync(guard).mtimeMs;
    } catch {
      continue;
    }
    if (age <= STALE_GUARD_MS) return 'another Codex adapter is starting';
    try {
      f.rmdirSync(guard);
    } catch {}
  }
  return 'another Codex adapter is starting';
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-instance-lock.test.ts`
Expected: PASS, all tests. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/codex/instance-lock.ts test/codex-instance-lock.test.ts
git commit -m "feat(codex): single-instance lock and control channel on a named pipe"
```

---

### Task 2: The adapter takes the lock before it starts

**Files:**
- Modify: `src/codex/main.ts` (whole file)
- Test: `test/codex-main-lock.test.ts`

**Interfaces:**
- Consumes (Task 1): `acquireLock(endpoint, owner)`, `controlEndpoint(configDir)`, `queryOwner(endpoint)`, `requestStop(endpoint, token)`.
- Produces (used by Task 3): IPC messages `{ type: 'codex-already-running', pid: number }` (then exit 0) and `{ type: 'codex-lock-failed', error: string }` (then exit 1) from a standalone adapter; `{ type: 'codex-first-connect', ...FirstConnect }` is unchanged. `codex.pid` is no longer written or removed.

- [ ] **Step 1: Write the failing tests**

Create `test/codex-main-lock.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { controlEndpoint, queryOwner, requestStop } from '../src/codex/instance-lock.js';
import { until } from './helpers/fake-codex-daemon.js';

const TOKEN = 'lock-test';

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function makeHome(): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-main-lock-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: await closedPort(), token: TOKEN },
    notifications: { desktop: false, sound: false },
    webhooks: [],
    codex: { command: path.join(home, 'no-such-codex.exe') },
  }));
  return home;
}

const endpointOf = (home: string) => controlEndpoint(path.join(home, '.claude-alarm'));

function adapterIn(home: string, supervised = false): { child: ChildProcess; inbox: any[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_ALARM_HUB_HOST;
  delete env.CLAUDE_ALARM_HUB_PORT;
  delete env.CLAUDE_ALARM_HUB_TOKEN;
  const args = ['--import', 'tsx', path.join('src', 'codex', 'main.ts'), ...(supervised ? ['--watch-stdin'] : [])];
  const child = spawn(process.execPath, args, { env, stdio: [supervised ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout?.resume();
  child.stderr?.resume();
  const inbox: any[] = [];
  child.on('message', (m) => inbox.push(m));
  return { child, inbox };
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('of two adapters started at once, one runs and the other reports it and exits 0', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  const b = adapterIn(home);
  try {
    const loser = await until(() => [a, b].find((x) => x.inbox.some((m) => m.type === 'codex-already-running')), 30_000);
    const winner = loser === a ? b : a;
    assert.equal(await exited(loser.child), 0);
    assert.equal(loser.inbox.find((m) => m.type === 'codex-already-running').pid, winner.child.pid);
    assert.deepEqual(await queryOwner(endpointOf(home)), { state: 'running', pid: winner.child.pid });
    assert.equal(fs.existsSync(path.join(home, '.claude-alarm', 'codex.pid')), false);
  } finally {
    a.child.kill();
    b.child.kill();
  }
});

test('an adapter started by the hub waits while another runs and takes over when it stops', { timeout: 90_000 }, async () => {
  const home = await makeHome();
  const endpoint = endpointOf(home);
  const a = adapterIn(home);
  let b: ReturnType<typeof adapterIn> | undefined;
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    b = adapterIn(home, true);
    await sleep(3000);
    assert.equal(b.child.exitCode, null);
    assert.deepEqual(await queryOwner(endpoint), { state: 'running', pid: a.child.pid });
    assert.deepEqual(await requestStop(endpoint, TOKEN), { state: 'stopping', pid: a.child.pid });
    assert.equal(await exited(a.child), 0);
    const pidB = b.child.pid;
    await until(async () => {
      const o = await queryOwner(endpoint);
      return o.state === 'running' && o.pid === pidB;
    }, 45_000);
  } finally {
    a.child.kill();
    b?.child.kill();
  }
});

test('a waiting adapter exits when the hub closes its stdin', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  let b: ReturnType<typeof adapterIn> | undefined;
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    b = adapterIn(home, true);
    await sleep(2500);
    assert.equal(b.child.exitCode, null);
    b.child.stdin!.end();
    assert.equal(await exited(b.child), 0);
  } finally {
    a.child.kill();
    b?.child.kill();
  }
});

test('a stop request with the wrong token leaves the adapter running', { timeout: 60_000 }, async () => {
  const home = await makeHome();
  const a = adapterIn(home);
  try {
    await until(() => a.inbox.find((m) => m.type === 'codex-first-connect'), 30_000);
    assert.deepEqual(await requestStop(endpointOf(home), 'wrong'), { state: 'unauthorized' });
    await sleep(500);
    assert.equal(a.child.exitCode, null);
  } finally {
    a.child.kill();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-main-lock.test.ts`
Expected: FAIL — the first test times out waiting for `codex-already-running` (today the loser exits 0 without any IPC message, or both keep running); the takeover test fails because nothing answers on the endpoint (`queryOwner` is `absent`).

- [ ] **Step 3: Implement**

Replace the whole of `src/codex/main.ts` with:

```ts
import { loadConfig } from '../shared/config.js';
import { CONFIG_DIR } from '../shared/constants.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import { logger } from '../shared/logger.js';
import { CodexAdapter } from './adapter.js';
import { resolveAdapterHub } from './hub-target.js';
import { acquireLock, controlEndpoint } from './instance-lock.js';

const WAIT_MIN_MS = 2000;
const WAIT_MAX_MS = 30_000;

installCrashGuard('codex adapter');
// Once the hub is gone its pipes break; without listeners every log line would become an uncaught EPIPE.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const config = loadConfig();
const supervised = process.argv.includes('--watch-stdin');
const endpoint = controlEndpoint(CONFIG_DIR);

let adapter: CodexAdapter | undefined;
let release: (() => Promise<void>) | undefined;
let exiting = false;
const shutdown = () => {
  if (exiting) return;
  exiting = true;
  adapter?.stop();
  const exit = () => process.exit(0);
  // server.close() waits for open control connections; a client that never finishes must not keep a stopped adapter alive.
  setTimeout(exit, 3000).unref();
  if (release) release().then(exit, exit);
  else exit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// On Windows `hub stop` kills the hub without running its exit handlers, so stdin EOF is the only sign the parent is gone.
if (supervised) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}

function send(message: object, then?: () => void): void {
  if (!process.send || !process.connected) {
    then?.();
    return;
  }
  // With a callback, a channel that closes between the check and the send reports here instead of throwing.
  process.send(message, undefined, undefined, (err: Error | null) => {
    if (err) logger.debug(`Report to the parent not delivered: ${err.message}`);
    then?.();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeLock(): Promise<boolean> {
  let delay = WAIT_MIN_MS;
  let waiting = false;
  for (;;) {
    const lock = await acquireLock(endpoint, { pid: process.pid, token: config.hub.token ?? '', onStop: shutdown });
    if (lock.kind === 'owner') {
      release = lock.close;
      return true;
    }
    if (!supervised) {
      if (lock.kind === 'held') {
        logger.info(`Codex adapter already running (PID: ${lock.pid})`);
        send({ type: 'codex-already-running', pid: lock.pid }, () => process.exit(0));
      } else {
        logger.error(`Codex adapter cannot start: ${lock.error}`);
        send({ type: 'codex-lock-failed', error: lock.error }, () => process.exit(1));
      }
      return false;
    }
    if (!waiting) {
      waiting = true;
      if (lock.kind === 'held') logger.info(`Another Codex adapter is running (PID: ${lock.pid}); this one takes over when it stops`);
      else logger.warn(`Codex adapter control endpoint is unavailable (${lock.error}); retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, WAIT_MAX_MS);
  }
}

void takeLock().then((owned) => {
  if (!owned) return;
  logStartup('Codex adapter');
  const { host, port, token } = resolveAdapterHub(config);
  adapter = new CodexAdapter({
    command: config.codex?.command ?? 'codex',
    hub: { host, port, token },
    onFirstConnect: (outcome) => send({ type: 'codex-first-connect', ...outcome }),
  });
  adapter.start();
});
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-main-lock.test.ts test/codex-main-ipc.test.ts`
Expected: PASS (6 tests). Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/codex/main.ts test/codex-main-lock.test.ts
git commit -m "feat(codex): the adapter holds the control lock instead of codex.pid, and a hub-started one waits to take over"
```

---

### Task 3: `codex start`, `stop` and `status` ask the control endpoint

**Files:**
- Modify: `src/codex/start-check.ts` (types at the top, `waitForAdapterReport`, `daemonLine` signature, `StartDeps`, `startAdapter`)
- Create: `src/codex/control-cli.ts`
- Modify: `src/cli.ts` (imports, `codexStart`, replace `codexStop`/`codexStatus`, codex dispatch)
- Test: `test/codex-start-check.test.ts`, `test/codex-control-cli.test.ts`

**Interfaces:**
- Consumes (Task 1): `OwnerState`, `StopResult`, `controlEndpoint`, `queryOwner`, `requestStop`. (Task 2): the IPC messages `codex-already-running` `{ pid }` and `codex-lock-failed` `{ error }`.
- Produces: `StartDeps` loses `readPid`, `isRunning`, `removePidFile` and gains `queryOwner: () => Promise<OwnerState>`; `AdapterReport` gains `{ kind: 'already'; pid: number }` and `{ kind: 'lockFailed'; error: string }`; `control-cli.ts` exports `STOP_WAIT_MS = 5000`, `interface ControlDeps`, `stopAdapter(d): Promise<number>`, `adapterStatus(d, startWithHub: boolean): Promise<number>`.

- [ ] **Step 1: Write the failing tests for `start-check`**

In `test/codex-start-check.test.ts`:

1. Add to the imports: `import type { OwnerState } from '../src/codex/instance-lock.js';`
2. Replace the whole `deps` helper (from `function deps(` to its closing `}`) with:

```ts
function deps(over: Partial<StartDeps> & { child?: FakeChild; owners?: OwnerState[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const owners = [...(over.owners ?? [])];
  let spawned = 0;
  const d: StartDeps = {
    hub: hubAt(1),
    command: 'codex',
    logFile: LOG,
    spawnAdapter: () => { spawned++; return asChild(over.child ?? new FakeChild()); },
    queryOwner: async () => owners.shift() ?? { state: 'absent' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    reportTimeoutMs: 1000,
    hubTimeoutMs: 1000,
    ...over,
  };
  return { d, out, err, spawnedCount: () => spawned };
}
```

3. In `'a started adapter that reached Codex and the hub prints three lines and exits 0'`: change `deps({ child, hub: s.hub, pidFile: { pid: 4242 } })` to `deps({ child, hub: s.hub })` and delete the line `assert.equal(t.pidFile.pid, 4242);`.
4. In `'an exit after the report wins over the report'`: change `deps({ child, hub: s.hub, pidFile: { pid: 4242 } })` to `deps({ child, hub: s.hub })` and delete the line `assert.equal(t.pidFile.pid, undefined);`.
5. Replace the whole test `'a PID file owned by another live adapter is kept, and the start reports it as already running'` with:

```ts
test('an adapter that exits at startup while another one owns the lock is reported as already running', async () => {
  const s = await serve(statusOk);
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub, owners: [{ state: 'absent' }, { state: 'running', pid: 9999 }] });
  try {
    const running = startAdapter(t.d);
    setTimeout(() => child.emit('exit', 0, null), 20);
    assert.equal(await running, 0);
    assert.deepEqual(t.out, [
      'Codex adapter is already running (PID: 9999)',
      '  Codex daemon: not checked (the adapter was already running)',
      `  Hub: reachable at http://127.0.0.1:${s.hub.port}`,
    ]);
    assert.deepEqual(t.err, []);
  } finally { await s.close(); }
});

test('a lock-held report from the adapter is printed as already running', async () => {
  const s = await serve(statusOk);
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub });
  try {
    const running = startAdapter(t.d);
    setTimeout(() => {
      child.emit('message', { type: 'codex-already-running', pid: 5150 });
      child.emit('exit', 0, null);
    }, 20);
    assert.equal(await running, 0);
    assert.deepEqual(t.out, [
      'Codex adapter is already running (PID: 5150)',
      '  Codex daemon: not checked (the adapter was already running)',
      `  Hub: reachable at http://127.0.0.1:${s.hub.port}`,
    ]);
    assert.deepEqual(t.err, []);
  } finally { await s.close(); }
});

test('a lock failure from the adapter is an error', async () => {
  const child = new FakeChild();
  const t = deps({ child, hub: hubAt(await closedPort()) });
  const running = startAdapter(t.d);
  setTimeout(() => {
    child.emit('message', { type: 'codex-lock-failed', error: 'control socket path is too long: /x' });
    child.emit('exit', 1, null);
  }, 20);
  assert.equal(await running, 1);
  assert.deepEqual(t.out, []);
  assert.deepEqual(t.err, ['Codex adapter cannot start: control socket path is too long: /x']);
});
```

6. In `'a running adapter is not started again, but the hub is still checked'`: change `deps({ hub: s.hub, pidFile: { pid: 777 }, isRunning: (pid) => pid === 777 })` to `deps({ hub: s.hub, owners: [{ state: 'running', pid: 777 }] })`.
7. In `'a running adapter with an unreachable hub also gets the restart hint'`: change `deps({ hub: hubAt(await closedPort()), pidFile: { pid: 777 }, isRunning: (pid) => pid === 777 })` to `deps({ hub: hubAt(await closedPort()), owners: [{ state: 'running', pid: 777 }] })`.
8. Add after the test `'no report in time is a timeout, and the listeners are removed'`:

```ts
test('lock reports end the wait', async () => {
  const a = new FakeChild();
  const waitingA = waitForAdapterReport(asChild(a), 1000);
  a.emit('message', { type: 'codex-already-running', pid: 31 });
  assert.deepEqual(await waitingA, { kind: 'already', pid: 31 });
  const b = new FakeChild();
  const waitingB = waitForAdapterReport(asChild(b), 1000);
  b.emit('message', { type: 'codex-lock-failed', error: 'boom' });
  assert.deepEqual(await waitingB, { kind: 'lockFailed', error: 'boom' });
});
```

- [ ] **Step 2: Write the failing tests for `control-cli`**

Create `test/codex-control-cli.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterStatus, stopAdapter, type ControlDeps } from '../src/codex/control-cli.js';
import type { OwnerState, StopResult } from '../src/codex/instance-lock.js';

const PIDFILE = 'C:\\home\\.claude-alarm\\codex.pid';
const CONFIG = 'C:\\home\\.claude-alarm\\config.json';
const note = (pid: number) =>
  `Note: ${PIDFILE} names a running process (PID: ${pid}). claude-alarm 1.2.0 and earlier wrote this file; if that process is an old Codex adapter, restart the hub or end it yourself.`;

function deps(o: { owners?: OwnerState[]; stop?: StopResult; legacy?: number; alive?: number[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const owners: OwnerState[] = [...(o.owners ?? [{ state: 'absent' }])];
  let removed = 0;
  let stops = 0;
  const d: ControlDeps = {
    queryOwner: async () => (owners.length > 1 ? owners.shift()! : owners[0]),
    requestStop: async () => { stops++; return o.stop ?? { state: 'absent' }; },
    legacyPid: () => o.legacy,
    isRunning: (pid) => (o.alive ?? []).includes(pid),
    removeLegacyPidFile: () => { removed++; },
    legacyPidFile: PIDFILE,
    configFile: CONFIG,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async () => {},
    stopWaitMs: 500,
  };
  return { d, out, err, removed: () => removed, stops: () => stops };
}

test('stop with nothing running says so and sends no stop request', async () => {
  const t = deps();
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running']);
  assert.equal(t.stops(), 0);
});

test('a live process in an old codex.pid is pointed out, never stopped or removed', async () => {
  const t = deps({ legacy: 4321, alive: [4321] });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running', note(4321)]);
  assert.equal(t.removed(), 0);
});

test('an old codex.pid naming a dead process is removed silently', async () => {
  const t = deps({ legacy: 4321 });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter is not running']);
  assert.equal(t.removed(), 1);
});

test('stop waits until the adapter is gone', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }, { state: 'running', pid: 10 }, { state: 'absent' }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter stopped (PID: 10)']);
  assert.deepEqual(t.err, []);
});

test('a waiting hub adapter taking over still counts as stopped', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }, { state: 'running', pid: 11 }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 0);
  assert.deepEqual(t.out, ['Codex adapter stopped (PID: 10)']);
});

test('a refused stop names the config file', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }], stop: { state: 'unauthorized' } });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, [`Codex adapter refused to stop: the token in ${CONFIG} does not match the one it started with`]);
});

test('an adapter that does not go away in time is reported', async () => {
  const t = deps({ owners: [{ state: 'running', pid: 10 }], stop: { state: 'stopping', pid: 10 } });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, ['Stop requested, but the Codex adapter (PID: 10) is still running. Check with: claude-alarm codex status']);
});

test('an unanswering endpoint is an error for stop', async () => {
  const t = deps({ owners: [{ state: 'unknown', error: 'no answer within 1000ms' }] });
  assert.equal(await stopAdapter(t.d), 1);
  assert.deepEqual(t.err, ['Codex adapter control endpoint is unavailable: no answer within 1000ms']);
  assert.equal(t.stops(), 0);
});

test('status lines', async () => {
  const running = deps({ owners: [{ state: 'running', pid: 10 }] });
  assert.equal(await adapterStatus(running.d, true), 0);
  assert.deepEqual(running.out, ['Codex adapter: running (PID: 10)', 'Start with hub: enabled']);

  const stopped = deps({ legacy: 4321, alive: [4321] });
  await adapterStatus(stopped.d, false);
  assert.deepEqual(stopped.out, ['Codex adapter: not running', note(4321), 'Start with hub: disabled']);

  const unknown = deps({ owners: [{ state: 'unknown', error: 'EACCES' }] });
  await adapterStatus(unknown.d, false);
  assert.deepEqual(unknown.out, ['Codex adapter: unknown (EACCES)', 'Start with hub: disabled']);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-start-check.test.ts test/codex-control-cli.test.ts`
Expected: FAIL — `Cannot find module '../src/codex/control-cli.js'`, and in start-check the new lock-report tests fail (no `already`/`lockFailed` kinds; `queryOwner` is not called).

- [ ] **Step 4: Implement `start-check.ts`**

1. Add the import: `import type { OwnerState } from './instance-lock.js';`
2. Replace the `AdapterReport` type with:

```ts
export type AdapterReport =
  | { kind: 'report'; outcome: FirstConnect }
  | { kind: 'already'; pid: number }
  | { kind: 'lockFailed'; error: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; error?: Error }
  | { kind: 'timeout' };
```

3. In `waitForAdapterReport`, replace the `onMessage` function with:

```ts
    const onMessage = (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'codex-first-connect') finish({ kind: 'report', outcome: toOutcome(m) });
      else if (m.type === 'codex-already-running' && Number.isInteger(m.pid)) finish({ kind: 'already', pid: m.pid as number });
      else if (m.type === 'codex-lock-failed') finish({ kind: 'lockFailed', error: String(m.error ?? '') });
    };
```

4. Change the `daemonLine` signature's first parameter type from `Exclude<AdapterReport, { kind: 'exited' }>` to `Extract<AdapterReport, { kind: 'report' | 'timeout' }>` (body unchanged).
5. In `StartDeps`, replace the three lines

```ts
  readPid: () => number | undefined;
  isRunning: (pid: number) => boolean;
  removePidFile: () => void;
```

with

```ts
  queryOwner: () => Promise<OwnerState>;
```

6. Replace the whole `startAdapter` function with:

```ts
export async function startAdapter(d: StartDeps): Promise<number> {
  const existing = await d.queryOwner();
  if (existing.state === 'running') {
    printAlreadyRunning(d, existing.pid, await checkHub(d.hub, d.hubTimeoutMs));
    return 0;
  }

  const child = d.spawnAdapter();
  const seen: { exit?: Exit } = {};
  // Watched until the very end: an adapter can report and then die while the hub check is still running.
  child.on('exit', (code, signal) => { seen.exit ??= { code, signal }; });
  child.on('error', (error) => { seen.exit ??= { code: null, signal: null, error }; });

  const [report, hub] = await Promise.all([
    waitForAdapterReport(child, d.reportTimeoutMs),
    checkHub(d.hub, d.hubTimeoutMs),
  ]);
  if (child.connected) child.disconnect();
  child.unref();

  if (report.kind === 'already') {
    printAlreadyRunning(d, report.pid, hub);
    return 0;
  }
  if (report.kind === 'lockFailed') {
    d.err(`Codex adapter cannot start: ${report.error}`);
    return 1;
  }
  if (report.kind !== 'exited' && !seen.exit && child.pid !== undefined) {
    d.out(`Codex adapter started (PID: ${child.pid}). Logs: ${d.logFile}`);
    printChecks(d, daemonLine(report, d.command, d.logFile), hubLine(hub, d.hub));
    return 0;
  }

  const exit: Exit | undefined = seen.exit ?? (report.kind === 'exited' ? report : undefined);
  if (!exit || exit.error) {
    d.err(`Codex adapter failed to start: ${exit?.error?.message ?? 'no process id'}`);
    return 1;
  }
  const owner = await d.queryOwner();
  if (owner.state === 'running' && owner.pid !== child.pid) {
    printAlreadyRunning(d, owner.pid, hub);
    return 0;
  }
  const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`;
  d.err(`Codex adapter exited during startup (${how}). See ${d.logFile}`);
  return 1;
}
```

- [ ] **Step 5: Implement `control-cli.ts`**

Create `src/codex/control-cli.ts`:

```ts
import type { OwnerState, StopResult } from './instance-lock.js';

export const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;

export interface ControlDeps {
  queryOwner: () => Promise<OwnerState>;
  requestStop: () => Promise<StopResult>;
  legacyPid: () => number | undefined;
  isRunning: (pid: number) => boolean;
  removeLegacyPidFile: () => void;
  legacyPidFile: string;
  configFile: string;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  stopWaitMs?: number;
}

function legacyNote(d: ControlDeps): void {
  const pid = d.legacyPid();
  if (pid === undefined) return;
  if (!d.isRunning(pid)) {
    d.removeLegacyPidFile();
    return;
  }
  d.out(`Note: ${d.legacyPidFile} names a running process (PID: ${pid}). claude-alarm 1.2.0 and earlier wrote this file; if that process is an old Codex adapter, restart the hub or end it yourself.`);
}

function unavailable(d: ControlDeps, error: string): number {
  d.err(`Codex adapter control endpoint is unavailable: ${error}`);
  return 1;
}

export async function stopAdapter(d: ControlDeps): Promise<number> {
  const owner = await d.queryOwner();
  if (owner.state === 'unknown') return unavailable(d, owner.error);
  if (owner.state === 'absent') {
    d.out('Codex adapter is not running');
    legacyNote(d);
    return 0;
  }
  const reply = await d.requestStop();
  if (reply.state === 'unknown') return unavailable(d, reply.error);
  if (reply.state === 'unauthorized') {
    d.err(`Codex adapter refused to stop: the token in ${d.configFile} does not match the one it started with`);
    return 1;
  }
  if (reply.state === 'absent') {
    d.out('Codex adapter is not running');
    return 0;
  }
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < (d.stopWaitMs ?? STOP_WAIT_MS); waited += STOP_POLL_MS) {
    await sleep(STOP_POLL_MS);
    const now = await d.queryOwner();
    // A hub adapter that was waiting takes over at once; a different PID still means this one stopped.
    if (now.state === 'absent' || (now.state === 'running' && now.pid !== reply.pid)) {
      d.out(`Codex adapter stopped (PID: ${reply.pid})`);
      return 0;
    }
  }
  d.err(`Stop requested, but the Codex adapter (PID: ${reply.pid}) is still running. Check with: claude-alarm codex status`);
  return 1;
}

export async function adapterStatus(d: ControlDeps, startWithHub: boolean): Promise<number> {
  const owner = await d.queryOwner();
  if (owner.state === 'running') {
    d.out(`Codex adapter: running (PID: ${owner.pid})`);
  } else if (owner.state === 'unknown') {
    d.out(`Codex adapter: unknown (${owner.error})`);
  } else {
    d.out('Codex adapter: not running');
    legacyNote(d);
  }
  d.out(`Start with hub: ${startWithHub ? 'enabled' : 'disabled'}`);
  return 0;
}
```

- [ ] **Step 6: Wire the CLI**

In `src/cli.ts`:

1. Change the constants import to `import { PID_FILE, LOG_FILE, DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, CODEX_PID_FILE, CODEX_LOG_FILE, CONFIG_DIR, CONFIG_FILE } from './shared/constants.js';`
2. Add after `import { startAdapter } from './codex/start-check.js';`:

```ts
import { controlEndpoint, queryOwner, requestStop } from './codex/instance-lock.js';
import { adapterStatus, stopAdapter, type ControlDeps } from './codex/control-cli.js';
```

3. In `codexStart`, replace

```ts
    readPid: readCodexPid,
    isRunning: isProcessRunning,
    removePidFile: () => {
      try { fs.unlinkSync(CODEX_PID_FILE); } catch {}
    },
```

with

```ts
    queryOwner: () => queryOwner(controlEndpoint(CONFIG_DIR)),
```

4. Replace the whole `codexStop` and `codexStatus` functions with:

```ts
function controlDeps(): ControlDeps {
  const endpoint = controlEndpoint(CONFIG_DIR);
  const token = loadConfig().hub.token ?? '';
  return {
    queryOwner: () => queryOwner(endpoint),
    requestStop: () => requestStop(endpoint, token),
    legacyPid: readCodexPid,
    isRunning: isProcessRunning,
    removeLegacyPidFile: () => {
      try { fs.unlinkSync(CODEX_PID_FILE); } catch {}
    },
    legacyPidFile: CODEX_PID_FILE,
    configFile: CONFIG_FILE,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}
```

5. In the `cmd === 'codex'` dispatch, replace

```ts
    else if (sub === 'stop') codexStop();
    else if (sub === 'status') codexStatus();
```

with

```ts
    else if (sub === 'stop') process.exitCode = await stopAdapter(controlDeps());
    else if (sub === 'status') process.exitCode = await adapterStatus(controlDeps(), loadConfig().codex?.enabled === true);
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-start-check.test.ts test/codex-control-cli.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors (no unused `readCodexPid`/`isProcessRunning`: both are still used).

- [ ] **Step 8: Commit**

```bash
git add src/codex/start-check.ts src/codex/control-cli.ts src/cli.ts test/codex-start-check.test.ts test/codex-control-cli.test.ts
git commit -m "feat(cli): codex start, stop and status ask the adapter's control endpoint instead of trusting codex.pid"
```

---

### Task 4: The hub hands its own address to the adapter it starts

**Files:**
- Modify: `src/hub/codex-supervisor.ts` (constructor, `launch`), `src/hub/server.ts:974-983` (`startCodexAdapter`)
- Test: `test/codex-supervisor.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface SupervisorOptions { spawnFn?: SupervisorSpawn; minDelayMs?: number; maxDelayMs?: number; stopGraceMs?: number; env?: NodeJS.ProcessEnv }`; `new CodexSupervisor(script: string, opts?: SupervisorOptions)`; `export function adapterEnv(base: NodeJS.ProcessEnv, hub: { host: string; port: number }): NodeJS.ProcessEnv`.

- [ ] **Step 1: Write the failing tests**

In `test/codex-supervisor.test.ts`:

1. Change the import to `import { CodexSupervisor, adapterEnv, resolveAdapterScript } from '../src/hub/codex-supervisor.js';`
2. Replace the `harness` function with:

```ts
function harness(graceMs = 3000, env?: NodeJS.ProcessEnv) {
  const children: FakeChild[] = [];
  const args: string[][] = [];
  const options: any[] = [];
  const sup = new CodexSupervisor('/x/codex/main.js', {
    spawnFn: (_cmd, a, o) => {
      args.push(a);
      options.push(o);
      const c = new FakeChild();
      children.push(c);
      return c as any;
    },
    minDelayMs: 10,
    maxDelayMs: 40,
    stopGraceMs: graceMs,
    env,
  });
  return { sup, children, args, options };
}
```

3. Add at the end of the file:

```ts
test('the adapter gets the environment it was given', () => {
  const env = { CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: '7900' };
  const { sup, options } = harness(3000, env);
  sup.start();
  assert.deepEqual(options[0].env, env);
  sup.stop();
});

test('without an environment the adapter inherits the hub one', () => {
  const { sup, options } = harness();
  sup.start();
  assert.equal('env' in options[0], false);
  sup.stop();
});

test('adapterEnv points at the hub itself and keeps the token out of the environment', () => {
  const base = {
    PATH: '/bin',
    CLAUDE_ALARM_HUB_HOST: 'other-pc',
    CLAUDE_ALARM_HUB_PORT: '9999',
    CLAUDE_ALARM_HUB_TOKEN: 'other-token',
  };
  const env = adapterEnv(base, { host: '0.0.0.0', port: 7900 });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_ALARM_HUB_HOST: '0.0.0.0', CLAUDE_ALARM_HUB_PORT: '7900' });
  assert.equal(base.CLAUDE_ALARM_HUB_TOKEN, 'other-token');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-supervisor.test.ts`
Expected: FAIL — `adapterEnv` is not exported, and the options object is taken as the spawn function (`TypeError: this.spawnFn is not a function`).

- [ ] **Step 3: Implement**

In `src/hub/codex-supervisor.ts`, replace everything from `export class CodexSupervisor {` through the end of the constructor with:

```ts
export interface SupervisorOptions {
  spawnFn?: SupervisorSpawn;
  minDelayMs?: number;
  maxDelayMs?: number;
  stopGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

// An adapter the hub starts must reach this hub, not one named by CLAUDE_ALARM_HUB_* in the shell; its token comes from config.json, not the environment.
export function adapterEnv(base: NodeJS.ProcessEnv, hub: { host: string; port: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_ALARM_HUB_HOST: hub.host, CLAUDE_ALARM_HUB_PORT: String(hub.port) };
  delete env.CLAUDE_ALARM_HUB_TOKEN;
  return env;
}

export class CodexSupervisor {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private delay: number;
  private readonly spawnFn: SupervisorSpawn;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stopGraceMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(private script: string, opts: SupervisorOptions = {}) {
    this.spawnFn = opts.spawnFn ?? spawn;
    this.minDelayMs = opts.minDelayMs ?? 2000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.stopGraceMs = opts.stopGraceMs ?? 3000;
    this.env = opts.env;
    this.delay = this.minDelayMs;
  }
```

In `launch()`, replace the spawn options object

```ts
    {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }
```

with

```ts
    {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.env ? { env: this.env } : {}),
    }
```

In `src/hub/server.ts`:

1. Change the import to `import { CodexSupervisor, adapterEnv, resolveAdapterScript } from './codex-supervisor.js';`
2. In `startCodexAdapter`, replace `this.codexSupervisor = new CodexSupervisor(script);` with

```ts
    this.codexSupervisor = new CodexSupervisor(script, { env: adapterEnv(process.env, { host: this.host, port: this.port }) });
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-supervisor.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/hub/codex-supervisor.ts src/hub/server.ts test/codex-supervisor.test.ts
git commit -m "fix(hub): the adapter the hub starts connects to that hub, whatever CLAUDE_ALARM_HUB_* the shell has"
```

---

### Task 5: Proxy handshake limit and explicit `.cmd`/`.bat` paths

**Files:**
- Modify: `src/codex/transport.ts` (`resolveCommand`, `connectProxy`)
- Test: `test/codex-transport.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const HANDSHAKE_TIMEOUT_MS = 10_000`; `connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn, timeoutMs = HANDSHAKE_TIMEOUT_MS)`. The adapter keeps calling `connectProxy(command, spawnFn)`.

- [ ] **Step 1: Write the failing tests**

In `test/codex-transport.test.ts`:

1. Change the first import block: add `type ChildProcess` to the `node:child_process` import (`import { spawn, type ChildProcess } from 'node:child_process';`) and change the helper import to `import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';`
2. Replace the test `'resolveCommand leaves explicit paths and other platforms alone'` with:

```ts
test('resolveCommand leaves explicit paths and other platforms alone', () => {
  assert.deepEqual(resolveCommand('C:/tools/codex.exe', 'win32', { PATH: '' }), { file: 'C:/tools/codex.exe', shell: false });
  assert.deepEqual(resolveCommand('codex', 'linux', { PATH: '/usr/bin' }), { file: 'codex', shell: false });
  assert.deepEqual(resolveCommand('/opt/codex.cmd', 'linux', { PATH: '' }), { file: '/opt/codex.cmd', shell: false });
});

test('an explicit .cmd or .bat path runs through a shell', () => {
  assert.deepEqual(resolveCommand('C:\\tools\\codex.cmd', 'win32', { PATH: '' }), { file: 'C:\\tools\\codex.cmd', shell: true });
  assert.deepEqual(resolveCommand('D:/x/Codex.BAT', 'win32', { PATH: '' }), { file: 'D:/x/Codex.BAT', shell: true });
  assert.deepEqual(resolveCommand('codex.cmd', 'win32', { PATH: '' }), { file: 'codex.cmd', shell: true });
});

test('an explicit .cmd path in a folder with spaces really runs', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cmd-')), 'with space');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'fake codex.cmd');
  fs.writeFileSync(file, '@echo ran %1 %2\r\n');
  const child = defaultSpawn(file, ['app-server', 'proxy']);
  let output = '';
  child.stdout?.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(output, /ran app-server proxy/);
});

test('connectProxy gives up on a daemon that never answers the handshake, and stops the proxy', async () => {
  let child: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' }));
  const started = Date.now();
  await assert.rejects(connectProxy('codex', spawnFn, 300), /^Error: codex daemon did not answer within 0.3s$/);
  assert.ok(Date.now() - started < 3000);
  await until(() => child!.exitCode !== null || child!.signalCode !== null);
});
```

3. Add `defaultSpawn` to the transport import: `import { connectProxy, defaultSpawn, findCodex, findOnPath, resolveCommand, type SpawnFn } from '../src/codex/transport.js';`

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts`
Expected: FAIL — `.cmd`/`.bat` cases return `shell: false`; the `.cmd` spawn exits with `EINVAL`; the handshake test hits the 30 s test timeout or never rejects.

- [ ] **Step 3: Implement**

In `src/codex/transport.ts`:

1. Replace the `resolveCommand` body with:

```ts
  if (platform !== 'win32') return { file: command, shell: false };
  if (/[\\/]/.test(command) || path.extname(command)) return { file: command, shell: /\.(cmd|bat)$/i.test(command) };
  const file = findCodex(command, platform, env);
  return file ? { file, shell: file.endsWith('.cmd') } : { file: command, shell: false };
```

2. Add above `connectProxy`: `export const HANDSHAKE_TIMEOUT_MS = 10_000;`
3. Change the `connectProxy` signature to `export function connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<ProxyConnection> {`
4. Replace the returned promise (from `return new Promise((resolve, reject) => {` to the end of the function) with:

```ts
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`codex daemon did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(err);
    };
    child.on('error', fail);
    child.once('exit', (code) => fail(new Error(`codex proxy exited (code ${code})`)));
    ws.on('error', fail);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.on('error', (err) => logger.warn(`codex proxy error: ${err.message}`));
      ws.on('error', (err) => logger.warn(`codex daemon socket error: ${err.message}`));
      resolve({ ws, close });
    });
  });
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts test/codex-adapter.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/codex/transport.ts test/codex-transport.test.ts
git commit -m "fix(codex): give up on a daemon that never answers the handshake, and run explicit .cmd/.bat paths through a shell"
```

---

### Task 6: Unrelayed terminal turns and approval-relay failures

**Files:**
- Modify: `src/codex/adapter.ts` (`syncSubscription` catch, `onServerRequest`, new private `waitingInCodex`)
- Test: `test/codex-adapter.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests**

Append to `test/codex-adapter.test.ts`:

```ts
test('a turn started in Codex whose subscription fails raises "Reply not relayed" when it ends', async () => {
  const d = await startAdapter([thread('t1')], (dm) => dm.handle('thread/resume', () => {
    throw new Error('thread busy');
  }), 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
    assert.equal(n.level, 'warning');
  } finally {
    dash.ws.close();
  }
});

test('a turn started in Codex that is followed normally raises no warning', async () => {
  const d = await startAdapter([thread('t1')], undefined, 150);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    d.notify('thread/status/changed', { threadId: 't1', status: active });
    await until(() => d.calls('thread/resume').length === 1);
    await new Promise((r) => setTimeout(r, 100));
    d.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!dash.inbox.some((m) => m.type === 'notification' && m.title === 'Reply not relayed'));
  } finally {
    dash.ws.close();
  }
});

test('an approval that cannot be relayed falls back to the Codex warning without answering the daemon', async () => {
  const d = await startAdapter([thread('t1', { status: active })]);
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    const link = (adapter as any).threads.get('t1').hub;
    const send = link.send.bind(link);
    link.send = (m: any) => {
      if (m.type === 'permission_request') throw new Error('boom');
      return send(m);
    };
    d.serverRequest(99, 'item/commandExecution/requestApproval', approvalParams);
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Codex is waiting'));
    assert.equal(n.level, 'warning');
    assert.equal(n.message, 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.');
    assert.equal((adapter as any).approvals.size, 0);
    assert.equal(d.responses.length, 0);
  } finally {
    dash.ws.close();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: FAIL — the first new test times out waiting for `Reply not relayed`; the third times out waiting for `Codex is waiting` (the exception is only logged by `RpcClient.guarded`).

- [ ] **Step 3: Implement**

In `src/codex/adapter.ts`:

1. In `syncSubscription`, replace

```ts
    } catch (err) {
      logger.debug(`subscription sync for ${threadId} deferred: ${(err as Error).message}`);
    }
```

with

```ts
    } catch (err) {
      logger.debug(`subscription sync for ${threadId} deferred: ${(err as Error).message}`);
      // A turn started in the Codex window has no other way to reach claude-alarm, so its reply is lost unless a later resume succeeds.
      if (t.wantSubscribed && !t.subscribed && t.thread.status.type === 'active') t.unrelayed = true;
    }
```

2. In `onServerRequest`, replace

```ts
        this.notify(t.thread.id, 'Codex is waiting', 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.', 'warning');
```

with

```ts
        this.waitingInCodex(t.thread.id);
```

3. In `onServerRequest`, replace everything from `const requestId = randomUUID();` to the end of the method with:

```ts
    const requestId = randomUUID();
    try {
      this.approvals.set(requestId, { threadId: t.thread.id, rpcId, turnId: params.turnId, choices: view.choices, answered: false });
      t.hub.send({
        type: 'permission_request',
        sessionId: codexSessionId(t.thread.id),
        requestId,
        toolName: view.toolName,
        description: view.description,
        inputPreview: view.inputPreview,
        timestamp: Date.now(),
        choices: view.choices.map((c, i) => ({ id: String(i), label: c.label })),
      });
    } catch (err) {
      this.approvals.delete(requestId);
      logger.warn(`Codex ${method} could not be relayed: ${(err as Error).message}`);
      // No reply to the daemon: the same request is open in the Codex window, and an error reply could cancel it there.
      this.waitingInCodex(t.thread.id);
    }
  }

  private waitingInCodex(threadId: string): void {
    this.notify(threadId, 'Codex is waiting', 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.', 'warning');
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: PASS, including the existing `'a new conversation is subscribed on the active broadcast and its reply is relayed without a warning'` and `'a malformed approval request falls back to the Codex warning'`. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts
git commit -m "fix(codex): warn when a turn started in Codex cannot be followed, and when an approval cannot be relayed"
```

---

### Task 7: Telegram selection prompts and expired buttons

**Files:**
- Modify: `src/hub/telegram.ts` (`pendingMessages` → `selections`, `handleIncomingMessage` selection parts, `handleCallbackQuery`, `handleChoiceCallback`, `handleSessionSelectCallback`, new `expire` and `removeButtons`)
- Test: `test/telegram-session-select.test.ts` (rewrite), `test/telegram-choices.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: session buttons carry `sel:<8 hex>:<index>`; `TelegramBot` gains private `expire(query)` and `removeButtons(chatId, messageId)` (Task 8 does not use them).

- [ ] **Step 1: Write the failing tests**

Replace the whole of `test/telegram-session-select.test.ts` with:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function setup(t: any, initial: ReturnType<typeof s>[]) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    calls.push({ api: String(url).split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  const state = { sessions: initial };
  bot.getSessions = () => state.sessions;
  const delivered: string[] = [];
  bot.onMessageToSession = (id, content) => { delivered.push(`${id}:${content}`); };
  return { bot, state, delivered, calls };
}

const say = (bot: TelegramBot, text: string, id = 1) =>
  (bot as any).handleIncomingMessage({ message_id: id, chat: { id: 111 }, text });

const press = (bot: TelegramBot, data: string) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: 111 }, message_id: 5, text: '' } });

const prompts = (calls: Array<{ api: string; body: any }>): string[][] =>
  calls
    .filter((c) => c.api === 'sendMessage' && c.body?.reply_markup)
    .map((c) => c.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data));

const expiredAndCleared = (calls: Array<{ api: string; body: any }>) => {
  assert.equal(calls.filter((c) => c.api === 'answerCallbackQuery').pop()!.body.text, 'Expired');
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageReplyMarkup').pop()!.body, {
    chat_id: 111,
    message_id: 5,
    reply_markup: { inline_keyboard: [] },
  });
};

test('a session button keeps pointing at the session listed when it was sent', async (t) => {
  const { bot, state, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await press(bot, prompts(calls)[0][0]);
  assert.deepEqual(delivered, ['a:hello']);
});

test('the /s_ command resolves against the same snapshot', async (t) => {
  const { bot, state, delivered } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('codex:new'), s('a'), s('b')];
  await say(bot, '/s_2', 2);
  assert.deepEqual(delivered, ['b:hello']);
});

test('a button for a session that has gone away delivers nothing', async (t) => {
  const { bot, state, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  state.sessions = [s('b')];
  await press(bot, prompts(calls)[0][0]);
  assert.deepEqual(delivered, []);
  assert.equal(calls.filter((c) => c.api === 'answerCallbackQuery').pop()!.body.text, 'Session not found');
});

test('with two prompts open, each prompt sends its own message', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'first', 1);
  await say(bot, 'second', 2);
  const [p1, p2] = prompts(calls);
  await press(bot, p1[1]);
  await press(bot, p2[0]);
  assert.deepEqual(delivered, ['b:first', 'a:second']);
});

test('the /s_ command uses the newest prompt', async (t) => {
  const { bot, delivered } = setup(t, [s('a'), s('b')]);
  await say(bot, 'first', 1);
  await say(bot, 'second', 2);
  await say(bot, '/s_1', 3);
  assert.deepEqual(delivered, ['a:second']);
});

test('session buttons fit in 64 bytes', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  for (const data of prompts(calls)[0]) {
    assert.match(data, /^sel:[0-9a-f]{8}:\d+$/);
    assert.ok(Buffer.byteLength(data) <= 64);
  }
});

test('a prompt that was already used expires and loses its buttons', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await say(bot, 'hello');
  const [p1] = prompts(calls);
  await press(bot, p1[0]);
  await press(bot, p1[1]);
  assert.deepEqual(delivered, ['a:hello']);
  expiredAndCleared(calls);
});

test('a session button from before the update expires and loses its buttons', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  await press(bot, 'sess:0:111');
  assert.deepEqual(delivered, []);
  expiredAndCleared(calls);
});

test('only the 20 newest prompts are kept', async (t) => {
  const { bot, delivered, calls } = setup(t, [s('a'), s('b')]);
  for (let i = 1; i <= 21; i++) await say(bot, `m${i}`, i);
  const all = prompts(calls);
  await press(bot, all[0][0]);
  expiredAndCleared(calls);
  await press(bot, all[20][0]);
  assert.deepEqual(delivered, ['a:m21']);
});
```

In `test/telegram-choices.test.ts`, replace the test `'an unknown token answers Expired'` with:

```ts
test('an unknown token answers Expired and removes the buttons', async (t) => {
  const { bot, calls, verdicts } = setup(t);
  await press(bot, 'pc:deadbeef');
  assert.deepEqual(verdicts, []);
  assert.equal(calls.find((c) => c.api === 'answerCallbackQuery')!.body.text, 'Expired');
  assert.deepEqual(calls.find((c) => c.api === 'editMessageReplyMarkup')!.body, {
    chat_id: 111,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-session-select.test.ts test/telegram-choices.test.ts`
Expected: FAIL — buttons still carry `sess:`; the two-prompt test delivers `second` twice; no `editMessageReplyMarkup` call.

- [ ] **Step 3: Implement**

In `src/hub/telegram.ts`:

1. Below `const MAX_CHOICE_MESSAGES = 200;` add:

```ts
const MAX_SELECTIONS = 20;
```

and below the `ChoiceMessage` interface add:

```ts
interface PendingSelection {
  text?: string;
  photoFileId?: string;
  caption?: string;
  sessionIds: string[];
}
```

2. Replace

```ts
  // Pending messages for session selection
  private pendingMessages = new Map<number, { text?: string; photoFileId?: string; caption?: string; sessionIds: string[] }>(); // chatId -> pending
```

with

```ts
  // Keyed by prompt, not by chat: buttons from an older prompt must still send that prompt's message.
  private selections = new Map<string, PendingSelection>();
```

3. In `handleIncomingMessage`, replace the whole `/s_` block

```ts
    // Check if it's a session selection command: /s_<index>
    if (text) {
      const selectMatch = text.match(/^\/s_(\d+)$/);
      if (selectMatch) {
        const pending = this.pendingMessages.get(msg.chat.id);
        if (pending) {
          this.pendingMessages.delete(msg.chat.id);
```

with

```ts
    if (text) {
      const selectMatch = text.match(/^\/s_(\d+)$/);
      const latest = [...this.selections.keys()].pop();
      if (selectMatch && latest !== undefined) {
        const pending = this.selections.get(latest);
        if (pending) {
          this.selections.delete(latest);
```

(the rest of that block is unchanged).

4. Replace the "Multiple sessions" part, from `// Multiple sessions — ask user to pick with inline buttons` down to and including the `const buttons = …` statement, with:

```ts
    const selectionId = randomUUID().replace(/-/g, '').slice(0, 8);
    const sessionIds = sessions.map((s) => s.id);
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      this.selections.set(selectionId, { photoFileId: largest.file_id, caption: text, sessionIds });
    } else {
      this.selections.set(selectionId, { text, sessionIds });
    }
    while (this.selections.size > MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value as string);
    const buttons = sessions.map((s, i) => ({
      text: this.getLabel(s),
      callback_data: `sel:${selectionId}:${i}`,
    }));
```

5. In `handleChoiceCallback`, replace

```ts
    if (!choice) {
      await this.answerCallbackQuery(query.id, 'Expired');
      return;
    }
```

with

```ts
    if (!choice) {
      await this.expire(query);
      return;
    }
```

6. In `handleCallbackQuery`, replace

```ts
    if (query.data.startsWith('sess:')) {
      await this.handleSessionSelectCallback(query);
      return;
    }
```

with

```ts
    if (query.data.startsWith('sel:')) {
      await this.handleSessionSelectCallback(query);
      return;
    }

    if (query.data.startsWith('sess:')) {
      await this.expire(query);
      return;
    }
```

7. Replace the beginning of `handleSessionSelectCallback`, from its first line through `this.pendingMessages.delete(chatId);`, with:

```ts
  private async handleSessionSelectCallback(query: TelegramCallbackQuery): Promise<void> {
    const [, selectionId, idxStr] = query.data!.split(':');
    const pending = this.selections.get(selectionId);
    if (!pending) {
      await this.expire(query);
      return;
    }
    const session = this.pendingSession(pending, parseInt(idxStr, 10));
    if (!session) {
      await this.answerCallbackQuery(query.id, 'Session not found');
      return;
    }
    this.selections.delete(selectionId);
```

(the delivery, `answerCallbackQuery` and `editMessageText` lines after it are unchanged).

8. Add after `answerCallbackQuery`:

```ts
  private async expire(query: TelegramCallbackQuery): Promise<void> {
    await this.answerCallbackQuery(query.id, 'Expired');
    if (query.message) await this.removeButtons(query.message.chat.id, query.message.message_id);
  }

  private async removeButtons(chatId: number | string, messageId: number): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageReplyMarkup error: ${(err as Error).message}`);
    }
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-session-select.test.ts test/telegram-choices.test.ts test/telegram-callback.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors, and `grep -n pendingMessages src/hub/telegram.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram.ts test/telegram-session-select.test.ts test/telegram-choices.test.ts
git commit -m "fix(telegram): each session prompt sends its own message, and expired buttons are removed"
```

---

### Task 8: Telegram length limit and photo failures

**Files:**
- Modify: `src/hub/telegram.ts` (constants, new exported `visibleLength`, `sendNotification`, new `fitNotification`, `handleIncomingMessage` photo check, `deliverPhotoToSessionByFileId`, new `photoNotDelivered`)
- Test: `test/telegram-limits.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function visibleLength(html: string): number` from `src/hub/telegram.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram-limits.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, visibleLength } from '../src/hub/telegram.js';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });
const MB10 = 10 * 1024 * 1024;

function setup(t: any, sessions = [s('a')], opts: { getFile?: unknown; download?: () => Response } = {}) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/getFile')) {
      calls.push({ api: 'getFile', body: undefined });
      return new Response(JSON.stringify(opts.getFile ?? { ok: true, result: { file_path: 'photos/p.jpg' } }));
    }
    if (u.includes('/file/bot')) {
      calls.push({ api: 'download', body: undefined });
      return opts.download ? opts.download() : new Response(new Uint8Array(10));
    }
    calls.push({ api: u.split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  bot.getSessions = () => sessions;
  const images: string[] = [];
  bot.onImageToSession = (id, _path, mime) => { images.push(`${id}:${mime}`); };
  return { bot, calls, images };
}

const photo = (size?: number) => ({
  message_id: 1,
  chat: { id: 111 },
  photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1, ...(size === undefined ? {} : { file_size: size }) }],
});

const sent = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body.text);

// --- length

test('escapes count as one character and tags not at all', () => {
  assert.equal(visibleLength('<b>a&amp;b</b>&lt;'), 4);
});

test('a short notification is sent unchanged', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', 'hello');
  assert.deepEqual(sent(calls), ['<b>Title</b>\nhello']);
});

test('a notification longer than Telegram allows is cut to 4000 visible characters', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', 'x'.repeat(10_000));
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.ok(visibleLength(text) > 3900);
  assert.ok(text.endsWith('\n…(truncated)'));
});

test('a cut never splits an emoji', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', '😀'.repeat(5000));
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
});

test('a cut inside a code block still leaves balanced tags', async (t) => {
  const { bot, calls } = setup(t);
  await bot.sendNotification('a', 'A', 'Title', `\`\`\`\n${'y'.repeat(9000)}\n\`\`\``);
  const [text] = sent(calls);
  assert.ok(visibleLength(text) <= 4000);
  assert.equal(text.split('<pre>').length, text.split('</pre>').length);
});

// --- photos

test('a photo over 10 MB is refused before a prompt is sent or anything is downloaded', async (t) => {
  const { bot, calls, images } = setup(t, [s('a'), s('b')]);
  await (bot as any).handleIncomingMessage(photo(MB10 + 1));
  assert.deepEqual(calls.map((c) => c.api), ['sendMessage']);
  assert.equal(calls[0].body.text, 'Photo not delivered: it is larger than 10 MB');
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.deepEqual(images, []);
});

test('a photo Telegram does not return is reported', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { getFile: { ok: false } });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: Telegram did not return the file']);
  assert.deepEqual(images, []);
});

test('a failed download is reported', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { download: () => new Response('gone', { status: 404 }) });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: the download failed']);
  assert.deepEqual(images, []);
});

test('a downloaded photo over 10 MB is reported and not delivered', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')], { download: () => new Response(new Uint8Array(MB10 + 1)) });
  await (bot as any).handleIncomingMessage(photo());
  assert.deepEqual(sent(calls), ['Photo not delivered: it is larger than 10 MB']);
  assert.deepEqual(images, []);
});

test('a photo within the limit is delivered without a message', async (t) => {
  const { bot, calls, images } = setup(t, [s('a')]);
  await (bot as any).handleIncomingMessage(photo(1000));
  assert.deepEqual(images, ['a:image/jpeg']);
  assert.deepEqual(sent(calls), []);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-limits.test.ts`
Expected: FAIL — `visibleLength` is not exported; long notifications are sent whole; photo failures send nothing.

- [ ] **Step 3: Implement**

In `src/hub/telegram.ts`:

1. Below `const MAX_SELECTIONS = 20;` add:

```ts
const MAX_VISIBLE_CHARS = 4000;
const TRUNCATED = '…(truncated)';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Telegram's 4096 limit counts the text left after parsing entities: tags are free and each escape is one character.
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt);/g, '&').length;
}
```

2. In `sendNotification`, replace `const text = \`<b>${this.escHtml(title)}</b>\n${this.mdToHtml(message)}\`;` with `const text = this.fitNotification(title, message);` and add after `sendNotification`:

```ts
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
  }
```

3. In `handleIncomingMessage`, directly after the line `if (!text && !hasPhoto) return;` add:

```ts
    if (hasPhoto) {
      const size = msg.photo![msg.photo!.length - 1].file_size;
      if (size !== undefined && size > MAX_PHOTO_BYTES) {
        this.photoNotDelivered('it is larger than 10 MB');
        return;
      }
    }
```

4. Replace the body of `deliverPhotoToSessionByFileId` with:

```ts
    try {
      const fileRes = await fetch(`${this.apiUrl}/getFile?file_id=${fileId}`);
      const fileData = fileRes.ok ? ((await fileRes.json()) as { ok: boolean; result?: { file_path: string } }) : undefined;
      if (!fileData?.ok || !fileData.result) {
        this.photoNotDelivered('Telegram did not return the file');
        return;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileData.result.file_path}`;
      const imgRes = await fetch(downloadUrl);
      if (!imgRes.ok) {
        this.photoNotDelivered('the download failed');
        return;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length > MAX_PHOTO_BYTES) {
        this.photoNotDelivered('it is larger than 10 MB');
        return;
      }

      const ext = fileData.result.file_path.split('.').pop() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      logger.info(`Telegram photo saved: ${filename} (${buffer.length} bytes)`);

      if (this.onImageToSession) {
        this.onImageToSession(sessionId, filePath, mimeType, caption);
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5 * 60 * 1000).unref();
    } catch (err) {
      logger.warn(`Telegram photo download failed: ${(err as Error).message}`);
      this.photoNotDelivered('the download failed');
    }
```

5. Add after `deliverPhotoToSessionByFileId`:

```ts
  private photoNotDelivered(reason: string): void {
    logger.warn(`Telegram photo not delivered: ${reason}`);
    void this.sendMessage(`Photo not delivered: ${reason}`);
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/telegram-limits.test.ts test/telegram-session-select.test.ts test/telegram-choices.test.ts`
Expected: PASS, and the test process exits promptly (the 5-minute cleanup timer is unref'd). Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram.ts test/telegram-limits.test.ts
git commit -m "fix(telegram): cut long notifications to fit, and say why a photo was not delivered"
```

---

### Task 9: Dashboard upload rejections

**Files:**
- Modify: `src/shared/types.ts` (`ChannelMessage`), `src/hub/server.ts` (`handleImageUpload` and its call site), `src/dashboard/index.html` (new `showUploadRejected` after `showMentionError`, new `case 'upload_rejected'` in the dashboard message switch)
- Test: `test/hub-upload-rejected.test.ts`, `test/dashboard-upload-rejected.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ChannelMessage` gains `{ type: 'upload_rejected'; sessionId: string; reason: string }`.

- [ ] **Step 1: Write the failing tests**

Create `test/hub-upload-rejected.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import { until } from './helpers/fake-codex-daemon.js';

const PORT = 7989;
const TOKEN = 'upload-test';
let hub: HubServer;

before(async () => {
  hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
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

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const upload = (dash: { ws: WebSocket }, sessionId: string, mimeType = 'image/png', imageData = png) =>
  dash.ws.send(JSON.stringify({ type: 'image_upload', sessionId, imageData, mimeType }));
const rejection = (dash: { inbox: any[] }, sessionId: string) =>
  until(() => dash.inbox.find((m) => m.type === 'upload_rejected' && m.sessionId === sessionId));

test('an image for a session that is not connected is rejected with a reason', async () => {
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'nobody');
    assert.deepEqual(await rejection(dash, 'nobody'), { type: 'upload_rejected', sessionId: 'nobody', reason: 'the session is not connected' });
  } finally { dash.ws.close(); }
});

test('an image for a session on another PC is rejected', async () => {
  const ch = await channel('up-remote');
  const dash = await open('/ws/dashboard');
  try {
    (hub as any).localChannels.delete('up-remote');
    upload(dash, 'up-remote');
    assert.equal((await rejection(dash, 'up-remote')).reason, "this session is on another PC; images can only go to sessions on the hub's PC");
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('an unsupported image type is rejected and nothing reaches the session', async () => {
  const ch = await channel('up-type');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-type', 'image/bmp');
    assert.equal((await rejection(dash, 'up-type')).reason, 'only PNG, JPEG, GIF and WebP images are supported');
    await settle();
    assert.ok(!ch.inbox.some((m) => m.type === 'image_to_session'));
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('an image over 10 MB is rejected', async () => {
  const ch = await channel('up-size');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-size', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'));
    assert.equal((await rejection(dash, 'up-size')).reason, 'the image is larger than 10 MB');
    assert.ok(!ch.inbox.some((m) => m.type === 'image_to_session'));
  } finally { dash.ws.close(); ch.ws.close(); }
});

test('a rejection goes only to the dashboard that sent the image', async () => {
  const sender = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  try {
    upload(sender, 'nobody-2');
    await rejection(sender, 'nobody-2');
    await settle();
    assert.ok(!other.inbox.some((m) => m.type === 'upload_rejected'));
  } finally { sender.ws.close(); other.ws.close(); }
});

test('an accepted image still reaches the session and is not rejected', async () => {
  const ch = await channel('up-ok');
  const dash = await open('/ws/dashboard');
  try {
    upload(dash, 'up-ok');
    await until(() => ch.inbox.find((m) => m.type === 'image_to_session'));
    assert.ok(!dash.inbox.some((m) => m.type === 'upload_rejected'));
  } finally { dash.ws.close(); ch.ws.close(); }
});
```

Create `test/dashboard-upload-rejected.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// The dashboard is a single inline-script HTML file; evaluate showUploadRejected in a sandbox.
function load(selectedSession: string) {
  const start = html.indexOf('  function showUploadRejected(msg) {');
  const end = html.indexOf('  let mentionState = ');
  assert.ok(start > 0 && end > start, 'showUploadRejected anchors not found');
  const errors: string[] = [];
  let renders = 0;
  const ctx: Record<string, any> = {
    state: { selectedSession, notifications: [] },
    showMentionError: (m: string) => errors.push(m),
    renderNotifications: () => { renders++; },
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, errors, renders: () => renders };
}

test('the dashboard handles upload_rejected messages', () => {
  assert.match(html, /case 'upload_rejected':\s*showUploadRejected\(msg\);\s*break;/);
});

test('a rejection for the open session shows under the input and in the notifications', () => {
  const { ctx, errors, renders } = load('s1');
  ctx.showUploadRejected({ type: 'upload_rejected', sessionId: 's1', reason: 'the image is larger than 10 MB' });
  assert.deepEqual(errors, ['Image not delivered: the image is larger than 10 MB']);
  const [n] = ctx.state.notifications;
  assert.equal(n.sessionId, 's1');
  assert.equal(n.title, 'Image not delivered');
  assert.equal(n.message, 'the image is larger than 10 MB');
  assert.equal(n.level, 'warning');
  assert.equal(typeof n.time, 'number');
  assert.equal(renders(), 1);
});

test('a rejection for another session only goes to the notifications', () => {
  const { ctx, errors } = load('s2');
  ctx.showUploadRejected({ type: 'upload_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, []);
  assert.equal(ctx.state.notifications.length, 1);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-upload-rejected.test.ts test/dashboard-upload-rejected.test.ts`
Expected: FAIL — no `upload_rejected` arrives (the `until` waits time out after 4 s), and the dashboard anchors are not found.

- [ ] **Step 3: Implement**

1. In `src/shared/types.ts`, add to `ChannelMessage` after the `image_to_session` member:

```ts
  | { type: 'upload_rejected'; sessionId: string; reason: string }
```

2. In `src/hub/server.ts`, change the dashboard handler call `this.handleImageUpload(msg);` to `this.handleImageUpload(ws, msg);`, and replace `handleImageUpload` from its signature down to and including the size check (`if (buffer.length > 10 * 1024 * 1024) { … }`) with:

```ts
  private handleImageUpload(ws: WebSocket, msg: ChannelMessage & { type: 'image_upload' }): void {
    const { sessionId, imageData, mimeType, originalName, content } = msg;
    const reject = (reason: string) => {
      logger.warn(`Image upload rejected for ${sessionId}: ${reason}`);
      const rejected: ChannelMessage = { type: 'upload_rejected', sessionId, reason };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(rejected));
    };

    const channelWs = this.channelSockets.get(sessionId);
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      reject('the session is not connected');
      return;
    }
    if (!this.localChannels.has(sessionId)) {
      reject("this session is on another PC; images can only go to sessions on the hub's PC");
      return;
    }

    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) {
      reject('only PNG, JPEG, GIF and WebP images are supported');
      return;
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      reject('the image is larger than 10 MB');
      return;
    }
```

(everything after the size check — saving to `UPLOADS_DIR`, forwarding `image_to_session`, the cleanup timer — is unchanged).

3. In `src/dashboard/index.html`, add directly after the `showMentionError` function (before `  let mentionState = `):

```js
  function showUploadRejected(msg) {
    if (state.selectedSession === msg.sessionId) showMentionError(`Image not delivered: ${msg.reason}`);
    state.notifications.unshift({ sessionId: msg.sessionId, title: 'Image not delivered', message: msg.reason, level: 'warning', time: Date.now() });
    renderNotifications();
  }

```

and in the dashboard WebSocket message `switch`, directly before `      case 'notification':`, add:

```js
      case 'upload_rejected':
        showUploadRejected(msg);
        break;
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-upload-rejected.test.ts test/dashboard-upload-rejected.test.ts test/hub-message-source.test.ts test/dashboard-images.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/hub/server.ts src/dashboard/index.html test/hub-upload-rejected.test.ts test/dashboard-upload-rejected.test.ts
git commit -m "fix(dashboard): say why an image upload was not delivered"
```

---

### Task 10: README and a real run of the lock

**Files:**
- Modify: `README.md:80`, `README.md` Codex section (after the line that starts `- If Codex runs on another PC`)

**Interfaces:**
- Consumes: everything above, built.
- Produces: nothing.

- [ ] **Step 1: Update the README**

Replace line 80:

```markdown
| `claude-alarm codex start` / `stop` / `status` | Run the Codex adapter on its own, e.g. when Codex runs on another PC. `start` tells you whether the adapter reached Codex and whether the hub answers at the configured address |
```

with

```markdown
| `claude-alarm codex start` / `stop` / `status` | Run the Codex adapter on its own, e.g. when Codex runs on another PC. `start` tells you whether the adapter reached Codex and whether the hub answers at the configured address; `stop` and `status` ask the running adapter itself |
```

After the bullet that starts `- If Codex runs on another PC, run \`claude-alarm codex start\` there.` add:

```markdown
- Only one Codex adapter runs per user. A second one finds the first and stops (`codex start` says `already running`); an adapter the hub starts waits instead and takes over when the other one stops. `claude-alarm codex stop` stops the adapter that is running now, so if the hub's adapter was waiting it takes over at once; to turn Codex off, use `codex disable` and restart the hub. claude-alarm 1.2.0 and earlier tracked the adapter in `~/.claude-alarm/codex.pid`; that file is no longer used, and `codex status` points it out if it names a running process.
```

- [ ] **Step 2: Build and run the whole suite**

Run: `npm run build` then `npm test`
Expected: build succeeds; all tests pass.

- [ ] **Step 3: Real run with the built CLI (isolated HOME, port 7991)**

Before starting, send the user a claude-alarm `notify` saying an isolated hub on port 7991 with a Codex adapter will run for a few minutes; it uses a non-existent `codex.command`, so it does not touch the real Codex daemon.

In Git Bash, with a fresh isolated home:

```bash
H=$(mktemp -d); mkdir -p "$H/.claude-alarm"
cat > "$H/.claude-alarm/config.json" <<'EOF'
{ "hub": { "host": "127.0.0.1", "port": 7991, "token": "real-run" },
  "notifications": { "desktop": false, "sound": false }, "webhooks": [],
  "codex": { "enabled": true, "command": "C:/nonexistent/codex.exe" } }
EOF
export HOME="$H" USERPROFILE="$(cygpath -w "$H")"
unset CLAUDE_ALARM_HUB_HOST CLAUDE_ALARM_HUB_PORT CLAUDE_ALARM_HUB_TOKEN
```

Then, recording each output:

1. `node dist/cli.js codex start` → `Codex adapter started (PID: A)` plus the daemon and hub lines (the hub is not running yet, so the hub line warns).
2. `node dist/cli.js codex start` again → `Codex adapter is already running (PID: A)`.
3. `node dist/cli.js codex status` → `Codex adapter: running (PID: A)`.
4. Start the hub in the background: `node dist/cli.js hub start -d` → it starts. Its supervised adapter must wait: `node dist/cli.js codex status` still says `running (PID: A)` a few seconds later (if the hub log `$H/.claude-alarm/hub.log` carries adapter output, it shows `Another Codex adapter is running (PID: A); this one takes over when it stops`).
5. `node dist/cli.js codex stop` → `Codex adapter stopped (PID: A)`.
6. Within ~35 s, `node dist/cli.js codex status` → `Codex adapter: running (PID: B)` with B ≠ A (the hub's adapter took over).
7. Plant an old-style PID file naming a live unrelated process this run starts itself. It writes its own Windows PID, because Git Bash's `$!` is not the Windows PID: `node -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)" "$(cygpath -w "$H/.claude-alarm/codex.pid")" & JOB=$!`, then `P=$(cat "$H/.claude-alarm/codex.pid")`. `node dist/cli.js codex stop` → `Codex adapter stopped (PID: B)`; P is untouched (`node -e "process.kill(Number(process.argv[1]), 0)" $P` exits 0). The hub's supervisor does not restart B (it exited 0). `node dist/cli.js codex status` → `Codex adapter: not running`, then `Note: … names a running process (PID: P)`, then `Start with hub: enabled`.
8. Clean up only what this run started: `node dist/cli.js hub stop`; `kill $JOB`. Check that A, B and P are gone with `node -e "for (const p of process.argv.slice(1)) { try { process.kill(Number(p), 0); console.log(p, 'alive'); } catch { console.log(p, 'gone'); } }" A B $P` (A and B replaced by their numbers). Never kill by image name.

Write the outputs into the task report. Any step that differs from the expected output is a finding.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: one Codex adapter per user, and codex stop/status ask the running adapter"
```
