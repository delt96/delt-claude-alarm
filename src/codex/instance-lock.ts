import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const CONTROL_PROTOCOL = 1;
export const STALE_GUARD_MS = 10_000;
export const STOP_PROOF_LABEL = 'claude-alarm codex stop';
const MAX_LINE_BYTES = 4096;
const REQUEST_IDLE_MS = 2000;
const MAX_SOCKET_PATH_BYTES = 103;

export function stopProof(token: string): string {
  return crypto.createHmac('sha256', token).update(STOP_PROOF_LABEL).digest('hex');
}

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
  const answer = await ask(endpoint, { type: 'stop', proof: stopProof(token) }, timeoutMs);
  if (!('reply' in answer)) return answer;
  const reply = answer.reply as { type?: unknown; pid?: unknown; error?: unknown } | null;
  if (reply?.type === 'stopping' && Number.isInteger(reply.pid)) return { state: 'stopping', pid: reply.pid as number };
  if (reply?.type === 'error' && reply.error === 'unauthorized') return { state: 'unauthorized' };
  return { state: 'unknown', error: 'unexpected reply' };
}

const line = (message: object) => `${JSON.stringify(message)}\n`;

function controlServer(owner: LockOwner): net.Server {
  const expectedProof = Buffer.from(stopProof(owner.token));
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
      let request: { type?: unknown; proof?: unknown } | null = null;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {}
      if (request?.type === 'status') {
        socket.end(line({ type: 'status', protocol: CONTROL_PROTOCOL, pid: owner.pid }));
      } else if (request?.type === 'stop') {
        const proof = typeof request.proof === 'string' ? Buffer.from(request.proof) : undefined;
        if (owner.token !== '' && proof && proof.length === expectedProof.length && crypto.timingSafeEqual(proof, expectedProof)) {
          socket.end(line({ type: 'stopping', pid: owner.pid }), () => owner.onStop());
        } else {
          socket.end(line({ type: 'error', error: 'unauthorized' }));
        }
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
