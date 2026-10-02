import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { AdapterHub } from '../src/codex/hub-target.js';
import {
  RESTART_HINT,
  checkHub,
  daemonLine,
  hubLine,
  startAdapter,
  waitForAdapterReport,
  type StartDeps,
} from '../src/codex/start-check.js';

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  connected = true;
  disconnected = 0;
  unrefed = 0;
  disconnect() { this.connected = false; this.disconnected++; }
  unref() { this.unrefed++; }
}
const asChild = (c: FakeChild) => c as unknown as ChildProcess;

const LOG = 'C:\\home\\.claude-alarm\\codex.log';

function hubAt(port: number, extra: Partial<AdapterHub> = {}): AdapterHub {
  return { host: '127.0.0.1', port, token: 'tok', fromEnv: { host: false, port: false, token: false }, ...extra };
}

async function serve(handler: http.RequestListener): Promise<{ hub: AdapterHub; seen: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    hub: hubAt(port),
    seen,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const statusOk: http.RequestListener = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ running: true, pid: 1, port: 1, sessions: 0, uptime: 1 }));
};

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// --- waitForAdapterReport

test('a first-connect message is the report; other messages are ignored', async () => {
  const child = new FakeChild();
  const waiting = waitForAdapterReport(asChild(child), 1000);
  child.emit('message', { type: 'something-else' });
  child.emit('message', { type: 'codex-first-connect', connected: true, userAgent: 'codex/1' });
  assert.deepEqual(await waiting, { kind: 'report', outcome: { connected: true, userAgent: 'codex/1' } });
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('a failed first connection is passed through', async () => {
  const child = new FakeChild();
  const waiting = waitForAdapterReport(asChild(child), 1000);
  child.emit('message', { type: 'codex-first-connect', connected: false, error: 'codex proxy exited (code 1)', notFound: false });
  assert.deepEqual(await waiting, { kind: 'report', outcome: { connected: false, error: 'codex proxy exited (code 1)', notFound: false } });
});

test('an exit before the report ends the wait', async () => {
  const child = new FakeChild();
  const waiting = waitForAdapterReport(asChild(child), 1000);
  child.emit('exit', 1, null);
  assert.deepEqual(await waiting, { kind: 'exited', code: 1, signal: null });
});

test('a spawn error ends the wait', async () => {
  const child = new FakeChild();
  const waiting = waitForAdapterReport(asChild(child), 1000);
  const error = new Error('spawn EACCES');
  child.emit('error', error);
  assert.deepEqual(await waiting, { kind: 'exited', code: null, signal: null, error });
});

test('no report in time is a timeout, and the listeners are removed', async () => {
  const child = new FakeChild();
  assert.deepEqual(await waitForAdapterReport(asChild(child), 50), { kind: 'timeout' });
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

// --- checkHub

test('a claude-alarm hub answers ok, and the token is sent', async () => {
  const s = await serve(statusOk);
  try {
    assert.deepEqual(await checkHub(s.hub), { kind: 'ok' });
    assert.equal(s.seen[0].authorization, 'Bearer tok');
  } finally { await s.close(); }
});

test('a rejected token is unauthorized', async () => {
  const s = await serve((_req, res) => { res.writeHead(401); res.end('{"error":"Unauthorized"}'); });
  try { assert.deepEqual(await checkHub(s.hub), { kind: 'unauthorized' }); } finally { await s.close(); }
});

test('a 200 that is not a hub status is not-hub', async () => {
  const s = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  try { assert.deepEqual(await checkHub(s.hub), { kind: 'not-hub', status: 200 }); } finally { await s.close(); }
});

test('a 200 that is not JSON is not-hub', async () => {
  const s = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); });
  try { assert.deepEqual(await checkHub(s.hub), { kind: 'not-hub', status: 200 }); } finally { await s.close(); }
});

test('another status is not-hub with that status', async () => {
  const s = await serve((_req, res) => { res.writeHead(500); res.end(); });
  try { assert.deepEqual(await checkHub(s.hub), { kind: 'not-hub', status: 500 }); } finally { await s.close(); }
});

test('a closed port is unreachable with the error code', async () => {
  assert.deepEqual(await checkHub(hubAt(await closedPort())), { kind: 'unreachable', reason: 'ECONNREFUSED' });
});

test('a hub that does not answer in time is unreachable with TimeoutError', async () => {
  const s = await serve((_req, res) => { setTimeout(() => statusOk(_req, res), 500); });
  try { assert.deepEqual(await checkHub(s.hub, 100), { kind: 'unreachable', reason: 'TimeoutError' }); } finally { await s.close(); }
});

// --- daemonLine / hubLine

test('daemon lines', () => {
  assert.deepEqual(daemonLine({ kind: 'report', outcome: { connected: true, userAgent: 'codex_app_server/0.160.0' } }, 'codex', LOG),
    { text: 'Codex daemon: connected (codex_app_server/0.160.0)', warning: false });
  assert.deepEqual(daemonLine({ kind: 'report', outcome: { connected: true } }, 'codex', LOG),
    { text: 'Codex daemon: connected (unknown version)', warning: false });
  assert.deepEqual(daemonLine({ kind: 'report', outcome: { connected: false, error: 'spawn codex ENOENT', notFound: true } }, 'codex', LOG),
    { text: 'Codex daemon: "codex" not found. Install Codex or set "codex.command" in ~/.claude-alarm/config.json, and run the restart from a new terminal.', warning: true });
  assert.deepEqual(daemonLine({ kind: 'report', outcome: { connected: false, error: 'codex proxy exited (code 1)', notFound: false } }, 'codex', LOG),
    { text: 'Codex daemon: not connected (codex proxy exited (code 1)). Is Codex running? The adapter keeps retrying.', warning: true });
  assert.deepEqual(daemonLine({ kind: 'timeout' }, 'codex', LOG),
    { text: `Codex daemon: no answer within 10s. The adapter keeps trying. See ${LOG}`, warning: true });
});

test('hub lines name the config file when the values come from it', () => {
  const hub = hubAt(7900, { host: '192.168.0.10' });
  assert.deepEqual(hubLine({ kind: 'ok' }, hub), { text: 'Hub: reachable at http://192.168.0.10:7900', warning: false });
  assert.deepEqual(hubLine({ kind: 'unauthorized' }, hub),
    { text: 'Hub: http://192.168.0.10:7900 rejected the token (401). Check hub.token in ~/.claude-alarm/config.json.', warning: true });
  assert.deepEqual(hubLine({ kind: 'not-hub', status: 200 }, hub),
    { text: 'Hub: http://192.168.0.10:7900 answered 200 but is not a claude-alarm hub. Check hub.host and hub.port in ~/.claude-alarm/config.json.', warning: true });
  assert.deepEqual(hubLine({ kind: 'unreachable', reason: 'ECONNREFUSED' }, hub),
    { text: 'Hub: not reachable at http://192.168.0.10:7900 (ECONNREFUSED). Check hub.host and hub.port in ~/.claude-alarm/config.json and that the hub is running.', warning: true });
});

test('hub lines name the environment variables that supplied the values', () => {
  const both = hubAt(7900, { fromEnv: { host: true, port: true, token: true } });
  assert.equal(hubLine({ kind: 'unauthorized' }, both).text, 'Hub: http://127.0.0.1:7900 rejected the token (401). Check CLAUDE_ALARM_HUB_TOKEN.');
  assert.equal(hubLine({ kind: 'unreachable', reason: 'ECONNREFUSED' }, both).text,
    'Hub: not reachable at http://127.0.0.1:7900 (ECONNREFUSED). Check CLAUDE_ALARM_HUB_HOST and CLAUDE_ALARM_HUB_PORT and that the hub is running.');
  const hostOnly = hubAt(7900, { fromEnv: { host: true, port: false, token: false } });
  assert.equal(hubLine({ kind: 'not-hub', status: 404 }, hostOnly).text,
    'Hub: http://127.0.0.1:7900 answered 404 but is not a claude-alarm hub. Check CLAUDE_ALARM_HUB_HOST and hub.port in ~/.claude-alarm/config.json.');
});

test('an IPv6 hub is shown with brackets', () => {
  assert.equal(hubLine({ kind: 'ok' }, hubAt(7900, { host: '[::1]' })).text, 'Hub: reachable at http://[::1]:7900');
});

// --- startAdapter

function deps(over: Partial<StartDeps> & { child?: FakeChild; pidFile?: { pid?: number } } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const pidFile = over.pidFile ?? {};
  let spawned = 0;
  const d: StartDeps = {
    hub: hubAt(1),
    command: 'codex',
    logFile: LOG,
    spawnAdapter: () => { spawned++; return asChild(over.child ?? new FakeChild()); },
    readPid: () => pidFile.pid,
    isRunning: () => false,
    removePidFile: () => { pidFile.pid = undefined; },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    reportTimeoutMs: 1000,
    hubTimeoutMs: 1000,
    ...over,
  };
  return { d, out, err, pidFile, spawnedCount: () => spawned };
}

test('a started adapter that reached Codex and the hub prints three lines and exits 0', async () => {
  const s = await serve(statusOk);
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub, pidFile: { pid: 4242 } });
  try {
    const running = startAdapter(t.d);
    setTimeout(() => child.emit('message', { type: 'codex-first-connect', connected: true, userAgent: 'codex/1' }), 20);
    assert.equal(await running, 0);
    assert.deepEqual(t.out, [
      `Codex adapter started (PID: 4242). Logs: ${LOG}`,
      '  Codex daemon: connected (codex/1)',
      `  Hub: reachable at http://127.0.0.1:${s.hub.port}`,
    ]);
    assert.deepEqual(t.err, []);
    assert.equal(child.disconnected, 1);
    assert.equal(child.unrefed, 1);
    assert.equal(t.pidFile.pid, 4242);
  } finally { await s.close(); }
});

test('warnings are followed by the restart hint', async () => {
  const child = new FakeChild();
  const t = deps({ child, hub: hubAt(await closedPort()) });
  const running = startAdapter(t.d);
  setTimeout(() => child.emit('message', { type: 'codex-first-connect', connected: false, error: 'codex proxy exited (code 1)', notFound: false }), 20);
  assert.equal(await running, 0);
  assert.equal(t.out.length, 4);
  assert.match(t.out[1], /^ {2}Codex daemon: not connected/);
  assert.match(t.out[2], /^ {2}Hub: not reachable at .*\(ECONNREFUSED\)/);
  assert.equal(t.out[3], `  ${RESTART_HINT}`);
  assert.equal(RESTART_HINT, 'After fixing this, restart the adapter: claude-alarm codex stop, then claude-alarm codex start');
});

test('no report within the limit is a warning, and the adapter is left running', async () => {
  const s = await serve(statusOk);
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub, reportTimeoutMs: 50 });
  try {
    assert.equal(await startAdapter(t.d), 0);
    assert.equal(t.out[1], `  Codex daemon: no answer within 10s. The adapter keeps trying. See ${LOG}`);
    assert.equal(t.out[3], `  ${RESTART_HINT}`);
  } finally { await s.close(); }
});

test('an exit after the report wins over the report', async () => {
  const s = await serve((req, res) => { setTimeout(() => statusOk(req, res), 200); });
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub, pidFile: { pid: 4242 } });
  try {
    const running = startAdapter(t.d);
    setTimeout(() => child.emit('message', { type: 'codex-first-connect', connected: true }), 20);
    setTimeout(() => { child.connected = false; child.emit('exit', 1, null); }, 80);
    assert.equal(await running, 1);
    assert.deepEqual(t.out, []);
    assert.deepEqual(t.err, [`Codex adapter exited during startup (code 1). See ${LOG}`]);
    assert.equal(t.pidFile.pid, undefined);
    assert.equal(child.disconnected, 0);
  } finally { await s.close(); }
});

test('an exit by signal is described by the signal', async () => {
  const child = new FakeChild();
  const t = deps({ child, hub: hubAt(await closedPort()) });
  const running = startAdapter(t.d);
  setTimeout(() => child.emit('exit', null, 'SIGTERM'), 20);
  assert.equal(await running, 1);
  assert.deepEqual(t.err, [`Codex adapter exited during startup (signal SIGTERM). See ${LOG}`]);
});

test('a PID file owned by another live adapter is kept, and the start reports it as already running', async () => {
  const s = await serve(statusOk);
  const child = new FakeChild();
  const t = deps({ child, hub: s.hub, pidFile: {}, isRunning: (pid) => pid === 9999 });
  try {
    const running = startAdapter(t.d);
    t.pidFile.pid = 9999;
    setTimeout(() => child.emit('exit', 0, null), 20);
    assert.equal(await running, 0);
    assert.equal(t.pidFile.pid, 9999);
    assert.deepEqual(t.out, [
      'Codex adapter is already running (PID: 9999)',
      '  Codex daemon: not checked (the adapter was already running)',
      `  Hub: reachable at http://127.0.0.1:${s.hub.port}`,
    ]);
    assert.deepEqual(t.err, []);
  } finally { await s.close(); }
});

test('a spawn error is a failed start', async () => {
  const child = new FakeChild();
  child.pid = undefined;
  const t = deps({ child, hub: hubAt(await closedPort()) });
  const running = startAdapter(t.d);
  setTimeout(() => child.emit('error', new Error('spawn EACCES')), 20);
  assert.equal(await running, 1);
  assert.deepEqual(t.err, ['Codex adapter failed to start: spawn EACCES']);
});

test('a running adapter is not started again, but the hub is still checked', async () => {
  const s = await serve(statusOk);
  const t = deps({ hub: s.hub, pidFile: { pid: 777 }, isRunning: (pid) => pid === 777 });
  try {
    assert.equal(await startAdapter(t.d), 0);
    assert.equal(t.spawnedCount(), 0);
    assert.deepEqual(t.out, [
      'Codex adapter is already running (PID: 777)',
      '  Codex daemon: not checked (the adapter was already running)',
      `  Hub: reachable at http://127.0.0.1:${s.hub.port}`,
    ]);
  } finally { await s.close(); }
});

test('a running adapter with an unreachable hub also gets the restart hint', async () => {
  const t = deps({ hub: hubAt(await closedPort()), pidFile: { pid: 777 }, isRunning: (pid) => pid === 777 });
  assert.equal(await startAdapter(t.d), 0);
  assert.equal(t.out.length, 4);
  assert.equal(t.out[3], `  ${RESTART_HINT}`);
});
