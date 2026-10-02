# `codex start` Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude-alarm codex start` reports whether the adapter it started survived, reached the Codex daemon, and can reach the hub — instead of printing "started" unconditionally.

**Architecture:** The adapter reports the result of its first daemon connection through a new `onFirstConnect` option; `src/codex/main.ts` forwards it to the parent over an IPC channel when one exists. The CLI spawns the adapter with an IPC slot and runs `startAdapter()` from the new `src/codex/start-check.ts`, which waits for that report (or exit, or 10 s), checks the hub's `/api/status` itself, and prints one line each. A shared `resolveAdapterHub()` gives the CLI and the adapter the same hub address, which also fixes `main.ts:31` for `''`, `::` and IPv6 hosts.

**Tech Stack:** TypeScript (ESM), Node built-ins (`child_process`, `http`, `net`, global `fetch`), `node:test` + `tsx`, tsup.

**Spec:** `docs/superpowers/specs/2026-10-02-codex-start-check-design.md`

## Global Constraints

- No new dependencies. Node built-ins only.
- IPC message type is exactly `'codex-first-connect'`; the message is `{ type: 'codex-first-connect', ...FirstConnect }`.
- Waits: adapter report `10_000` ms (`ADAPTER_REPORT_TIMEOUT_MS`), hub check `3000` ms (`HUB_CHECK_TIMEOUT_MS`), one hub request only.
- All user-facing strings are English and must match the spec table (3-2) character for character; Task 3 holds them.
- Comments: none, except a one-line English "why" where the code alone would mislead.
- Tests run with `npm test` (`node --import tsx --import ./test/isolate-home.ts --test …`). Every new test file starts with `import './isolate-home.js';`. Never use port 7900; prefer port 0. Kill only processes the test itself started (by `ChildProcess` handle), never by image name.
- Platform: Windows is the primary target; code must also run on POSIX.
- `HubClient`, `src/channel/*`, `src/hub/*` are not changed.

## Review Focus

1. The adapter exits **after** sending its report while the hub check is still pending → the CLI must print `exited during startup` (exit 1), never `started`. Test: Task 3 `startAdapter` "exit after report wins".
2. The started adapter exits because another adapter already owns `codex.pid` (two `codex start` at once) → the CLI must not delete the other adapter's PID file and must print `already running`. Test: Task 3 `startAdapter` "PID file owned by another live adapter".
3. `onFirstConnect` throws → the daemon connection must stay up (success) or retries must continue (failure). Test: Task 2.
4. Hub host/port/token supplied through `CLAUDE_ALARM_HUB_*` → the remediation names the variable, not `config.json`. Test: Task 3 `hubLine`.
5. Something other than a claude-alarm hub answers 200 on the port → `not-hub`, not `reachable`. Test: Task 3 `checkHub`.

---

### Task 1: Shared hub address for the adapter

**Files:**
- Create: `src/codex/hub-target.ts`
- Modify: `src/codex/main.ts:1-36`
- Test: `test/codex-hub-target.test.ts`

**Interfaces:**
- Consumes: `hubUrlHost(host: string): string` from `src/shared/hub-url.ts`; `AppConfig` from `src/shared/types.ts`.
- Produces:
  ```ts
  export interface AdapterHub {
    host: string;
    port: number;
    token?: string;
    fromEnv: { host: boolean; port: boolean; token: boolean };
  }
  export function resolveAdapterHub(config: AppConfig, env?: NodeJS.ProcessEnv): AdapterHub;
  ```

- [ ] **Step 1: Write the failing test** — `test/codex-hub-target.test.ts`

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapterHub } from '../src/codex/hub-target.js';
import type { AppConfig } from '../src/shared/types.js';

// null, not undefined, means "no token": passing undefined would select the default.
function config(host: string, port = 7900, token: string | null = 'cfg-token'): AppConfig {
  return { hub: { host, port, token: token ?? undefined }, notifications: { desktop: false, sound: false }, webhooks: [] };
}

test('config hosts are turned into URL hosts', () => {
  assert.equal(resolveAdapterHub(config('0.0.0.0'), {}).host, '127.0.0.1');
  assert.equal(resolveAdapterHub(config(''), {}).host, '127.0.0.1');
  assert.equal(resolveAdapterHub(config('::'), {}).host, '[::1]');
  assert.equal(resolveAdapterHub(config('fe80::1'), {}).host, '[fe80::1]');
  assert.equal(resolveAdapterHub(config('192.168.0.10'), {}).host, '192.168.0.10');
  assert.equal(resolveAdapterHub(config('hub.local'), {}).host, 'hub.local');
});

test('without environment overrides everything comes from the config', () => {
  assert.deepEqual(resolveAdapterHub(config('192.168.0.10', 7901, 'cfg-token'), {}), {
    host: '192.168.0.10',
    port: 7901,
    token: 'cfg-token',
    fromEnv: { host: false, port: false, token: false },
  });
});

test('environment variables win over the config', () => {
  const env = { CLAUDE_ALARM_HUB_HOST: '::1', CLAUDE_ALARM_HUB_PORT: '7902', CLAUDE_ALARM_HUB_TOKEN: 'env-token' };
  assert.deepEqual(resolveAdapterHub(config('192.168.0.10'), env), {
    host: '[::1]',
    port: 7902,
    token: 'env-token',
    fromEnv: { host: true, port: true, token: true },
  });
});

test('each override is reported on its own', () => {
  const hub = resolveAdapterHub(config('192.168.0.10', 7901), { CLAUDE_ALARM_HUB_PORT: '7903' });
  assert.equal(hub.host, '192.168.0.10');
  assert.equal(hub.port, 7903);
  assert.equal(hub.token, 'cfg-token');
  assert.deepEqual(hub.fromEnv, { host: false, port: true, token: false });
});

test('a config without a token stays without one', () => {
  assert.equal(resolveAdapterHub(config('127.0.0.1', 7900, null), {}).token, undefined);
});

test('every resolved host makes a valid URL', () => {
  for (const host of ['0.0.0.0', '', '::', '::1', 'fe80::1', '192.168.0.10', 'hub.local']) {
    const hub = resolveAdapterHub(config(host), {});
    assert.doesNotThrow(() => new URL(`http://${hub.host}:${hub.port}/api/status`), host);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-hub-target.test.ts`
Expected: FAIL — cannot find module `../src/codex/hub-target.js`.

- [ ] **Step 3: Write the implementation** — `src/codex/hub-target.ts`

```ts
import { hubUrlHost } from '../shared/hub-url.js';
import type { AppConfig } from '../shared/types.js';

export interface AdapterHub {
  host: string;
  port: number;
  token?: string;
  fromEnv: { host: boolean; port: boolean; token: boolean };
}

export function resolveAdapterHub(config: AppConfig, env: NodeJS.ProcessEnv = process.env): AdapterHub {
  const envHost = env.CLAUDE_ALARM_HUB_HOST;
  const envPort = env.CLAUDE_ALARM_HUB_PORT;
  const envToken = env.CLAUDE_ALARM_HUB_TOKEN;
  return {
    host: hubUrlHost(envHost ?? config.hub.host),
    port: envPort ? parseInt(envPort, 10) : config.hub.port,
    token: envToken ?? config.hub.token,
    fromEnv: { host: envHost !== undefined, port: !!envPort, token: envToken !== undefined },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-hub-target.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Use it in `src/codex/main.ts`**

Replace the imports and lines 31–35. The file becomes (lines 1–36; the rest is unchanged):

```ts
import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { CODEX_PID_FILE } from '../shared/constants.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import { logger } from '../shared/logger.js';
import { CodexAdapter } from './adapter.js';
import { resolveAdapterHub } from './hub-target.js';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

installCrashGuard('codex adapter');
// Once the hub is gone its pipes break; without listeners every log line would become an uncaught EPIPE.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const config = loadConfig();

const existing = fs.existsSync(CODEX_PID_FILE) ? parseInt(fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim(), 10) : NaN;
if (!Number.isNaN(existing) && existing !== process.pid && isRunning(existing)) {
  logger.info(`Codex adapter already running (PID: ${existing})`);
  process.exit(0);
}
fs.writeFileSync(CODEX_PID_FILE, String(process.pid), 'utf-8');
logStartup('Codex adapter');

const { host, port, token } = resolveAdapterHub(config);

const adapter = new CodexAdapter({ command: config.codex?.command ?? 'codex', hub: { host, port, token } });
adapter.start();
```

(`DEFAULT_HUB_HOST` is no longer imported.)

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npm test` — Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/codex/hub-target.ts src/codex/main.ts test/codex-hub-target.test.ts
git commit -m "fix(codex): resolve the adapter's hub address with hubUrlHost so empty, :: and IPv6 hosts work"
```

---

### Task 2: The adapter reports its first daemon connection

**Files:**
- Modify: `src/codex/adapter.ts:21-30` (options, new type), `:56-68` (field), `:83-118` (`connect()`), new private method after `scheduleRetry()`
- Modify: `src/codex/main.ts` (the `new CodexAdapter(…)` call from Task 1)
- Test: `test/codex-adapter.test.ts` (append), `test/codex-main-ipc.test.ts` (new)

**Interfaces:**
- Consumes: `resolveAdapterHub` (Task 1, already used by `main.ts`).
- Produces (exported from `src/codex/adapter.ts`):
  ```ts
  export type FirstConnect =
    | { connected: true; userAgent?: string }
    | { connected: false; error: string; notFound: boolean };
  // CodexAdapterOptions gains:
  onFirstConnect?: (outcome: FirstConnect) => void;
  ```
  and the IPC message `{ type: 'codex-first-connect', ...FirstConnect }` sent by `main.ts`.

- [ ] **Step 1: Write the failing adapter tests** — append to `test/codex-adapter.test.ts`

Change the adapter import line to:

```ts
import { CodexAdapter, type FirstConnect } from '../src/codex/adapter.js';
```

Append:

```ts
function firstConnectDaemon(threads: any[] = []): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  return d.start().then(() => {
    d.handle('thread/loaded/list', () => ({ data: threads.map((t) => t.id), nextCursor: null }));
    d.handle('thread/read', (p) => ({ thread: threads.find((x) => x.id === p.threadId) }));
    d.handle('thread/resume', () => ({}));
    d.handle('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
    return d;
  });
}

test('the first daemon connection is reported once, with the daemon version', async () => {
  const d = await firstConnectDaemon();
  const outcomes: FirstConnect[] = [];
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200,
    onFirstConnect: (o) => outcomes.push(o),
  });
  adapter.start();
  await until(() => outcomes.length > 0);
  d.dropClient();
  await until(() => d.connections === 2, 5000);
  await until(() => d.calls('thread/loaded/list').length >= 2);
  assert.deepEqual(outcomes, [{ connected: true, userAgent: 'fake-codex/0' }]);
});

test('a missing Codex binary is reported once as not found', async () => {
  const outcomes: FirstConnect[] = [];
  const counter = { attempts: 0 };
  adapter = new CodexAdapter({
    command: MISSING, hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => {
      counter.attempts++;
      return spawn(MISSING, [], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => counter.attempts >= 3, 3000);
  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.ok(!outcome.connected);
  assert.equal(outcome.notFound, true);
  assert.match(outcome.error, /ENOENT/);
});

test('a proxy that exits at once is reported as not connected, not as not found', async () => {
  const outcomes: FirstConnect[] = [];
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => {
      attempts++;
      return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 5000);
  assert.deepEqual(outcomes, [{ connected: false, error: 'codex proxy exited (code 3)', notFound: false }]);
});

test('a throwing first-connect observer does not break a healthy connection', async () => {
  const d = await firstConnectDaemon([thread('t1')]);
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, spawnFn: d.spawnFn, reconnectMinMs: 50, reconnectMaxMs: 200,
    onFirstConnect: () => { throw new Error('observer failed'); },
  });
  adapter.start();
  await session('codex:t1');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(d.connections, 1);
});

test('a throwing first-connect observer does not stop the retries', async () => {
  let attempts = 0;
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: () => { throw new Error('observer failed'); },
    spawnFn: () => {
      attempts++;
      return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
    },
  });
  adapter.start();
  await until(() => attempts >= 3, 5000);
});

test('a stopped adapter reports nothing', async () => {
  const outcomes: FirstConnect[] = [];
  adapter = new CodexAdapter({
    command: 'codex', hub: HUB, reconnectMinMs: 20, reconnectMaxMs: 40,
    onFirstConnect: (o) => outcomes.push(o),
    spawnFn: () => spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 300)'], { stdio: 'pipe' }),
  });
  adapter.start();
  adapter.stop();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(outcomes, []);
});
```

Note: `firstConnectDaemon` sets the module-level `daemon`, so the existing `afterEach` stops it.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: the new tests FAIL (TypeScript accepts the unknown option at runtime, so `outcomes` stays empty and `until` times out with "condition not met in time"; `deepEqual` on `[]` fails for the proxy-exit test). The two "throwing observer" tests and "a stopped adapter reports nothing" may already pass — that is expected; they guard the implementation.

- [ ] **Step 3: Implement in `src/codex/adapter.ts`**

Add the type above `CodexAdapterOptions` and the option inside it:

```ts
export type FirstConnect =
  | { connected: true; userAgent?: string }
  | { connected: false; error: string; notFound: boolean };

export interface CodexAdapterOptions {
  command: string;
  hub: { host: string; port: number; token?: string };
  spawnFn?: SpawnFn;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  idleReleaseMs?: number;
  noticeTimeoutMs?: number;
  onFirstConnect?: (outcome: FirstConnect) => void;
}
```

Add a field next to `notFoundNotice`:

```ts
  private firstConnectReported = false;
```

In `connect()`, report right after the `Connected to Codex daemon` log line, and in the `catch` right after the `noticeNotFound()` line. The method becomes:

```ts
  private async connect(): Promise<void> {
    let rpc: RpcClient | undefined;
    try {
      const conn = await connectProxy(this.opts.command, this.opts.spawnFn);
      if (this.stopped) {
        conn.close();
        return;
      }
      const live = new RpcClient(conn.ws);
      rpc = live;
      live.on('notification', (method: string, params: any) => this.onNotification(method, params));
      live.on('request', (id: RpcId, method: string, params: any) => this.onServerRequest(id, method, params));
      live.on('close', () => {
        if (this.rpc === live) this.onDaemonLost();
      });
      this.conn = conn;
      this.rpc = live;
      const init = await live.request<{ userAgent?: string }>('initialize', {
        clientInfo: { name: 'claude-alarm', version: CHANNEL_SERVER_VERSION },
      });
      live.notify('initialized');
      logger.info(`Connected to Codex daemon (${init.userAgent ?? 'unknown version'})`);
      this.reportFirstConnect({ connected: true, ...(init.userAgent ? { userAgent: init.userAgent } : {}) });
      await this.discover();
      this.delay = this.opts.reconnectMinMs ?? 2000;
    } catch (err) {
      logger.warn(`Codex daemon connection failed: ${(err as Error).message}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.noticeNotFound();
      this.reportFirstConnect({
        connected: false,
        error: (err as Error).message,
        notFound: (err as NodeJS.ErrnoException).code === 'ENOENT',
      });
      if (rpc && this.rpc === rpc) {
        this.rpc = undefined;
        this.conn?.close();
        this.conn = undefined;
      }
      for (const id of [...this.threads.keys()]) this.drop(id);
      this.scheduleRetry();
    }
  }
```

Add the method right after `scheduleRetry()`:

```ts
  private reportFirstConnect(outcome: FirstConnect): void {
    if (this.firstConnectReported || this.stopped) return;
    this.firstConnectReported = true;
    try {
      this.opts.onFirstConnect?.(outcome);
    } catch (err) {
      // Inside connect(), a throw here would be taken for a daemon failure and drop a healthy connection.
      logger.debug(`First-connect observer failed: ${(err as Error).message}`);
    }
  }
```

- [ ] **Step 4: Run the adapter tests to verify they pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: PASS (all, old and new).

- [ ] **Step 5: Write the failing IPC test** — `test/codex-main-ipc.test.ts`

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startStandaloneAdapter(): Promise<ChildProcess> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-main-ipc-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: await closedPort(), token: 'ipc-test' },
    notifications: { desktop: false, sound: false },
    webhooks: [],
    codex: { command: path.join(home, 'no-such-codex.exe') },
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_ALARM_HUB_HOST;
  delete env.CLAUDE_ALARM_HUB_PORT;
  delete env.CLAUDE_ALARM_HUB_TOKEN;
  return spawn(process.execPath, ['--import', 'tsx', path.join('src', 'codex', 'main.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function firstMessage(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no IPC message within 20s')), 20_000);
    child.once('message', (m) => { clearTimeout(timer); resolve(m); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`adapter exited (code ${code})`)); });
  });
}

test('a standalone adapter reports its first connection to the parent over IPC', async () => {
  const child = await startStandaloneAdapter();
  try {
    const message = await firstMessage(child);
    assert.equal(message.type, 'codex-first-connect');
    assert.equal(message.connected, false);
    assert.equal(message.notFound, true);
    assert.match(message.error, /ENOENT/);
  } finally {
    child.kill();
  }
});

test('the adapter keeps running after the parent closes the IPC channel', async () => {
  const child = await startStandaloneAdapter();
  try {
    await firstMessage(child);
    child.disconnect();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-main-ipc.test.ts`
Expected: FAIL — "no IPC message within 20s" (main.ts does not send yet).

- [ ] **Step 7: Send the report from `src/codex/main.ts`**

Replace the `new CodexAdapter(…)` line from Task 1 with:

```ts
const adapter = new CodexAdapter({
  command: config.codex?.command ?? 'codex',
  hub: { host, port, token },
  onFirstConnect: (outcome) => {
    if (!process.send || !process.connected) return;
    // With a callback, a channel that closes between the check and the send reports here instead of throwing.
    process.send({ type: 'codex-first-connect', ...outcome }, undefined, undefined, (err: Error | null) => {
      if (err) logger.debug(`First-connect report not delivered: ${err.message}`);
    });
  },
});
```

Do not add a `disconnect` handler: the adapter must keep running when the parent goes away.

- [ ] **Step 8: Run the IPC test, typecheck, full suite**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-main-ipc.test.ts` — Expected: PASS (2 tests).
Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npm test` — Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/codex/adapter.ts src/codex/main.ts test/codex-adapter.test.ts test/codex-main-ipc.test.ts
git commit -m "feat(codex): report the adapter's first daemon connection, and send it over IPC when started by the CLI"
```

---

### Task 3: `start-check` — wait, check the hub, decide what to print

**Files:**
- Create: `src/codex/start-check.ts`
- Test: `test/codex-start-check.test.ts`

**Interfaces:**
- Consumes: `FirstConnect` (Task 2, `src/codex/adapter.ts`), `AdapterHub` (Task 1, `src/codex/hub-target.ts`).
- Produces (all exported from `src/codex/start-check.ts`):
  ```ts
  export const ADAPTER_REPORT_TIMEOUT_MS = 10_000;
  export const HUB_CHECK_TIMEOUT_MS = 3000;
  export const RESTART_HINT: string;
  export type AdapterReport =
    | { kind: 'report'; outcome: FirstConnect }
    | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; error?: Error }
    | { kind: 'timeout' };
  export type HubCheck =
    | { kind: 'ok' } | { kind: 'unauthorized' } | { kind: 'not-hub'; status: number } | { kind: 'unreachable'; reason: string };
  export interface Line { text: string; warning: boolean }
  export function waitForAdapterReport(child: ChildProcess, timeoutMs?: number): Promise<AdapterReport>;
  export function hubUrl(hub: AdapterHub): string;
  export function checkHub(hub: AdapterHub, timeoutMs?: number): Promise<HubCheck>;
  export function daemonLine(report: Exclude<AdapterReport, { kind: 'exited' }>, command: string, logFile: string): Line;
  export function hubLine(check: HubCheck, hub: AdapterHub): Line;
  export interface StartDeps {
    hub: AdapterHub;
    command: string;
    logFile: string;
    spawnAdapter: () => ChildProcess;
    readPid: () => number | undefined;
    isRunning: (pid: number) => boolean;
    removePidFile: () => void;
    out: (line: string) => void;
    err: (line: string) => void;
    reportTimeoutMs?: number;
    hubTimeoutMs?: number;
  }
  export function startAdapter(deps: StartDeps): Promise<number>; // the exit code
  ```

`startAdapter` is the whole `codex start` flow from spec 3-1 (steps 2–7) with every side effect injected, so the CLI (Task 4) only wires real `spawn`, the PID file and `console`. It goes beyond the spec's helper list only to make the CLI flow testable; it changes no behaviour the spec fixes. It prints the restart hint after the "already running" lines too when the hub line is a warning — fixing the config still needs a restart there.

- [ ] **Step 1: Write the failing tests** — `test/codex-start-check.test.ts`

```ts
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
```

Note on "a PID file owned by another live adapter…": the fake starts with no PID file, so the "already running" pre-check passes and `startAdapter` spawns synchronously before its first `await`. Then another adapter's PID appears while ours starts, and our child exits 0 as `main.ts` does when it finds that adapter.

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-start-check.test.ts`
Expected: FAIL — cannot find module `../src/codex/start-check.js`.

- [ ] **Step 3: Write the implementation** — `src/codex/start-check.ts`

```ts
import type { ChildProcess } from 'node:child_process';
import type { FirstConnect } from './adapter.js';
import type { AdapterHub } from './hub-target.js';

export const ADAPTER_REPORT_TIMEOUT_MS = 10_000;
export const HUB_CHECK_TIMEOUT_MS = 3000;
export const RESTART_HINT = 'After fixing this, restart the adapter: claude-alarm codex stop, then claude-alarm codex start';

const CONFIG_PATH = '~/.claude-alarm/config.json';
const NOT_CHECKED: Line = { text: 'Codex daemon: not checked (the adapter was already running)', warning: false };

export type AdapterReport =
  | { kind: 'report'; outcome: FirstConnect }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; error?: Error }
  | { kind: 'timeout' };

export type HubCheck =
  | { kind: 'ok' }
  | { kind: 'unauthorized' }
  | { kind: 'not-hub'; status: number }
  | { kind: 'unreachable'; reason: string };

export interface Line {
  text: string;
  warning: boolean;
}

function toOutcome(msg: { connected?: unknown; userAgent?: unknown; error?: unknown; notFound?: unknown }): FirstConnect {
  if (msg.connected === true) return typeof msg.userAgent === 'string' ? { connected: true, userAgent: msg.userAgent } : { connected: true };
  return { connected: false, error: String(msg.error ?? ''), notFound: msg.notFound === true };
}

export function waitForAdapterReport(child: ChildProcess, timeoutMs = ADAPTER_REPORT_TIMEOUT_MS): Promise<AdapterReport> {
  return new Promise((resolve) => {
    const finish = (result: AdapterReport) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(result);
    };
    const onMessage = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'codex-first-connect') {
        finish({ kind: 'report', outcome: toOutcome(msg as Record<string, unknown>) });
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({ kind: 'exited', code, signal });
    const onError = (error: Error) => finish({ kind: 'exited', code: null, signal: null, error });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

export function hubUrl(hub: AdapterHub): string {
  return `http://${hub.host}:${hub.port}`;
}

export async function checkHub(hub: AdapterHub, timeoutMs = HUB_CHECK_TIMEOUT_MS): Promise<HubCheck> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${hubUrl(hub)}/api/status`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: unknown } };
    return { kind: 'unreachable', reason: typeof e.cause?.code === 'string' ? e.cause.code : e.name };
  }
  if (res.status === 200) {
    try {
      const body = (await res.json()) as { running?: unknown } | null;
      if (body?.running === true) return { kind: 'ok' };
    } catch {}
    return { kind: 'not-hub', status: 200 };
  }
  await res.body?.cancel().catch(() => {});
  return res.status === 401 ? { kind: 'unauthorized' } : { kind: 'not-hub', status: res.status };
}

export function daemonLine(report: Exclude<AdapterReport, { kind: 'exited' }>, command: string, logFile: string): Line {
  if (report.kind === 'timeout') {
    return { text: `Codex daemon: no answer within ${ADAPTER_REPORT_TIMEOUT_MS / 1000}s. The adapter keeps trying. See ${logFile}`, warning: true };
  }
  const o = report.outcome;
  if (o.connected) return { text: `Codex daemon: connected (${o.userAgent ?? 'unknown version'})`, warning: false };
  if (o.notFound) {
    return { text: `Codex daemon: "${command}" not found. Install Codex or set "codex.command" in ${CONFIG_PATH}, and run the restart from a new terminal.`, warning: true };
  }
  return { text: `Codex daemon: not connected (${o.error}). Is Codex running? The adapter keeps retrying.`, warning: true };
}

function addressSource(hub: AdapterHub): string {
  const host = hub.fromEnv.host ? 'CLAUDE_ALARM_HUB_HOST' : 'hub.host';
  const port = hub.fromEnv.port ? 'CLAUDE_ALARM_HUB_PORT' : 'hub.port';
  const fromConfig = !hub.fromEnv.host || !hub.fromEnv.port;
  return `${host} and ${port}${fromConfig ? ` in ${CONFIG_PATH}` : ''}`;
}

function tokenSource(hub: AdapterHub): string {
  return hub.fromEnv.token ? 'CLAUDE_ALARM_HUB_TOKEN' : `hub.token in ${CONFIG_PATH}`;
}

export function hubLine(check: HubCheck, hub: AdapterHub): Line {
  const url = hubUrl(hub);
  switch (check.kind) {
    case 'ok':
      return { text: `Hub: reachable at ${url}`, warning: false };
    case 'unauthorized':
      return { text: `Hub: ${url} rejected the token (401). Check ${tokenSource(hub)}.`, warning: true };
    case 'not-hub':
      return { text: `Hub: ${url} answered ${check.status} but is not a claude-alarm hub. Check ${addressSource(hub)}.`, warning: true };
    case 'unreachable':
      return { text: `Hub: not reachable at ${url} (${check.reason}). Check ${addressSource(hub)} and that the hub is running.`, warning: true };
  }
}

export interface StartDeps {
  hub: AdapterHub;
  command: string;
  logFile: string;
  spawnAdapter: () => ChildProcess;
  readPid: () => number | undefined;
  isRunning: (pid: number) => boolean;
  removePidFile: () => void;
  out: (line: string) => void;
  err: (line: string) => void;
  reportTimeoutMs?: number;
  hubTimeoutMs?: number;
}

function printChecks(d: StartDeps, daemon: Line, hub: Line): void {
  d.out(`  ${daemon.text}`);
  d.out(`  ${hub.text}`);
  if (daemon.warning || hub.warning) d.out(`  ${RESTART_HINT}`);
}

function printAlreadyRunning(d: StartDeps, pid: number, hub: HubCheck): void {
  d.out(`Codex adapter is already running (PID: ${pid})`);
  printChecks(d, NOT_CHECKED, hubLine(hub, d.hub));
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export async function startAdapter(d: StartDeps): Promise<number> {
  const existing = d.readPid();
  if (existing !== undefined && d.isRunning(existing)) {
    printAlreadyRunning(d, existing, await checkHub(d.hub, d.hubTimeoutMs));
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
  const owner = d.readPid();
  if (owner !== undefined && owner === child.pid) d.removePidFile();
  else if (owner !== undefined && d.isRunning(owner)) {
    printAlreadyRunning(d, owner, hub);
    return 0;
  }
  const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`;
  d.err(`Codex adapter exited during startup (${how}). See ${d.logFile}`);
  return 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-start-check.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npm test` — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/codex/start-check.ts test/codex-start-check.test.ts
git commit -m "feat(codex): decide what codex start prints from the adapter's report, its exit and a hub check"
```

---

### Task 4: Wire `codex start` to it, and document it

**Files:**
- Modify: `src/cli.ts:1-12` (imports), `:366-381` (`codexStart`), `:446` (call site)
- Modify: `README.md:80`, `README.md:195`

**Interfaces:**
- Consumes: `startAdapter(deps: StartDeps): Promise<number>` (Task 3, `src/codex/start-check.ts`); `resolveAdapterHub(config)` (Task 1); existing `readCodexPid()`, `isProcessRunning()`, `loadConfig`, `ensureConfigDir`, `CODEX_PID_FILE`, `CODEX_LOG_FILE` in `src/cli.ts`.
- Produces: nothing new.

- [ ] **Step 1: Replace `codexStart()` in `src/cli.ts`**

Add to the imports:

```ts
import { resolveAdapterHub } from './codex/hub-target.js';
import { startAdapter } from './codex/start-check.js';
```

Replace the whole `codexStart` function (lines 366–381) with:

```ts
async function codexStart() {
  // Before spawning: on a fresh PC this creates and saves the token, so the adapter reads the same one.
  const config = loadConfig();
  ensureConfigDir();
  const code = await startAdapter({
    hub: resolveAdapterHub(config),
    command: config.codex?.command ?? 'codex',
    logFile: CODEX_LOG_FILE,
    readPid: readCodexPid,
    isRunning: isProcessRunning,
    removePidFile: () => {
      try { fs.unlinkSync(CODEX_PID_FILE); } catch {}
    },
    spawnAdapter: () => {
      const logFd = fs.openSync(CODEX_LOG_FILE, 'a');
      return spawn(process.execPath, [path.join(__dirname, 'codex', 'main.js')], {
        detached: true,
        stdio: ['ignore', logFd, logFd, 'ipc'],
        windowsHide: true,
        env: { ...process.env },
      });
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}
```

In `main()`, change the dispatch line `else if (sub === 'start') codexStart();` to:

```ts
    else if (sub === 'start') await codexStart();
```

- [ ] **Step 2: Update `README.md`**

Line 80 becomes:

```markdown
| `claude-alarm codex start` / `stop` / `status` | Run the Codex adapter on its own, e.g. when Codex runs on another PC. `start` tells you whether the adapter reached Codex and the hub |
```

Line 195 becomes:

```markdown
- If Codex runs on another PC, run `claude-alarm codex start` there. It reads the hub address and token from that PC's `~/.claude-alarm/config.json` (`hub.host`, `hub.port`, `hub.token`) or from `CLAUDE_ALARM_HUB_HOST`, `CLAUDE_ALARM_HUB_PORT` and `CLAUDE_ALARM_HUB_TOKEN`; the remote-hub answers you give `claude-alarm init` go only into that project's `.mcp.json` and do not apply here. `codex start` says whether it reached Codex and the hub. Keep claude-alarm at the same version on both PCs; an older hub cannot show Codex's choices.
```

- [ ] **Step 3: Typecheck, full suite, build**

Run: `npx tsc --noEmit` — Expected: no errors.
Run: `npm test` — Expected: all pass.
Run: `npm run build` — Expected: completes; `dist/cli.js` and `dist/codex/main.js` exist.

- [ ] **Step 4: Smoke-run the built CLI without Codex or a hub** (isolated HOME, no real daemon, nothing listening)

Write this script to a `.mjs` file outside the repository (it uses top-level `await`) and run it with the repository root as the working directory (`node <file>.mjs`):

```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const server = net.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-codex-start-'));
fs.mkdirSync(path.join(home, '.claude-alarm'));
fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
  hub: { host: '127.0.0.1', port, token: 'smoke' },
  notifications: { desktop: false, sound: false },
  webhooks: [],
  codex: { command: path.join(home, 'no-such-codex.exe') },
}));
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const k of ['CLAUDE_ALARM_HUB_HOST', 'CLAUDE_ALARM_HUB_PORT', 'CLAUDE_ALARM_HUB_TOKEN']) delete env[k];
const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { env, encoding: 'utf8' });

const start = run('codex', 'start');
console.log('start exit', start.status, '\n' + start.stdout + start.stderr);
const again = run('codex', 'start');
console.log('again exit', again.status, '\n' + again.stdout + again.stderr);
const stop = run('codex', 'stop');
console.log('stop exit', stop.status, stop.stdout + stop.stderr);
```

Expected:
- `start exit 0`, lines: `Codex adapter started (PID: N). Logs: <home>\.claude-alarm\codex.log`, `  Codex daemon: "<home>\no-such-codex.exe" not found. …`, `  Hub: not reachable at http://127.0.0.1:<port> (ECONNREFUSED). Check hub.host and hub.port in ~/.claude-alarm/config.json and that the hub is running.`, `  After fixing this, restart the adapter: …`
- `again exit 0`, lines: `Codex adapter is already running (PID: N)`, `  Codex daemon: not checked (the adapter was already running)`, the same Hub line, the restart hint
- `stop exit 0`, `Codex adapter stopped (PID: N)`

`codex stop` ends the adapter this script started (by the PID in the isolated `codex.pid`). Do not kill any other process.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts README.md
git commit -m "fix(cli): codex start reports whether the adapter survived and reached Codex and the hub"
```

---

### Task 5: Real checks against the built CLI

Verification only; no code changes unless a check fails (then fix in the owning task's file and re-run that task's tests).

**Files:** none (scripts live in a temp/scratch folder, not the repository).

**Interfaces:**
- Consumes: the built `dist/cli.js` from Task 4.

Environment rules for every step: `HOME` and `USERPROFILE` point to a fresh temp folder; the hub port is not 7900 (use 7989); notifications `desktop: false`, `webhooks: []`, no `telegram`; stop only processes started here, by PID (`codex stop` / `hub stop` with the isolated HOME, or the spawned handle). Before step 1 (the only step that reaches the real Codex daemon), send a heads-up with claude-alarm `notify`.

- [ ] **Step 1: Normal start** — isolated hub on 7989 (`hub start -d` with the isolated HOME, `codex.enabled` false), `codex.command` unset (real Codex), then `codex start`
  Expected: exit 0; `Codex adapter started (PID: N)`, `  Codex daemon: connected (<userAgent>)`, `  Hub: reachable at http://127.0.0.1:7989`; no restart hint. Then `codex stop`.
- [ ] **Step 2: Hub down** — stop the isolated hub, `codex start`
  Expected: `  Hub: not reachable at http://127.0.0.1:7989 (ECONNREFUSED). …` and the restart hint; exit 0. `codex stop`.
- [ ] **Step 3: Wrong token** — hub running, config token changed for the `codex start` run only (a second isolated HOME with the same port and a different token)
  Expected: `  Hub: http://127.0.0.1:7989 rejected the token (401). Check hub.token in ~/.claude-alarm/config.json.`; exit 0. `codex stop`.
- [ ] **Step 4: Codex not found** — `codex.command` set to a missing file
  Expected: `  Codex daemon: "<path>" not found. …`; exit 0. `codex stop`.
- [ ] **Step 5: Two starts at once** — start two `codex start` processes concurrently with the same isolated HOME
  Expected: exactly one adapter keeps running (`codex status` shows one PID, and that PID is alive); one run prints `started`, the other prints `Codex adapter is already running (PID: <that PID>)` with exit 0; neither prints `started` for a process that is gone. `codex stop`.
  If both runs print `started` and two adapters stay alive, that is the existing check-then-write gap in `src/codex/main.ts:23-28` (outside this plan): record it as a finding with both PIDs, stop both adapters by PID, and do not fix it here. Repeat the step up to 3 times and report how often each outcome occurred.
- [ ] **Step 6: No console window** — with an adapter started by `codex start` running, read its window handle: `powershell -NoProfile -Command "(Get-Process -Id <PID>).MainWindowHandle"`
  Expected: `0`. `codex stop`.
- [ ] **Step 7: Clean up** — stop the isolated hub (`hub stop` with that HOME); confirm no process started in this task is still alive (check each recorded PID with `process.kill(pid, 0)`).

Record each step's command output in the task report.
