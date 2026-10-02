# Hub Start Daemon on Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows에서 `claude-alarm hub start -d`가 실제로 Hub를 띄우고, 뜨지 않으면 "started" 대신 오류와 종료 코드 1을 낸다.

**Architecture:** `src/hub/server.ts` 끝의 직접 실행 판별을 경로 구분자를 무시하는 `isEntryScript()`로 바꾼다(Windows Node는 `argv[1]`을 백슬래시 경로로 준다). `hub start -d`는 자식을 띄운 뒤 `waitForHub()`로 `/api/status`가 자식 PID로 답할 때까지 최대 5초 기다리고, 실패하면 자식을 끝내고 PID 파일을 지운다.

**Tech Stack:** TypeScript ESM, tsup 번들(`dist/cli.js`가 `server.ts`를 번들에 포함), `node:test` + `tsx`.

**Spec:** 저장소 스펙 없음(bounded 작업, 설계는 채팅에서 승인). 설계·원인 기록: Obsidian `Projects/claude_alarm/docs/tasks/2026-10-02-hub-start-d-windows-버그.md`.

## Global Constraints

- 직접 실행 판별에 `import.meta.url === pathToFileURL(process.argv[1]).href`를 쓰지 않는다. `dist/cli.js`가 `server.ts`를 번들하므로 CLI 프로세스 안에서도 참이 되어 Hub가 둘 뜬다.
- 직접 실행 접미사(정확히 이대로): `['/hub/server.js', '/hub/server.ts']` — 앞의 `/`까지 포함해 `myhub/server.js` 같은 경로를 거른다.
- 기동 확인: `http://<displayHost>:<port>/api/status`, 헤더 `Authorization: Bearer <token>`(토큰이 있을 때), 간격 200ms, 최대 5000ms, 요청 하나당 최대 1000ms. 응답이 200이고 JSON `pid`가 띄운 자식 PID와 같을 때만 성공.
- 사용자에게 보이는 문구(영어, 정확히 이대로):
  - 성공: 기존 4줄 그대로(`Hub started as daemon (PID: <pid>)`, `Dashboard: …`, `Token: …`, `Logs: …`)
  - 자식이 먼저 끝남: `Hub exited during startup. See <LOG_FILE>`
  - 시간 초과: `Hub did not answer at http://<displayHost>:<port> within 5s and was stopped. See <LOG_FILE>`
  - 두 실패 모두 stderr(`console.error`), 종료 코드 1, PID 파일 삭제.
- 새 의존성 없음.
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선·코드 재진술 주석 금지.
- 포트: 단위 테스트는 포트 0(임의). 직접 실행 테스트는 7990. 실측은 7989. 7900(사용자 실제 Hub)과 7991–7998(기존 테스트)은 쓰지 않는다.
- Hub를 띄우는 모든 실행은 임시 HOME(`HOME`과 `USERPROFILE`을 같은 임시 폴더로). 실제 `~/.claude-alarm`을 건드리지 않는다.
- 프로세스는 자기가 띄운 PID만 끝낸다. 이미지 이름(`node.exe` 등)으로 일괄 종료 금지 — 사용자 Hub와 모든 Claude 세션의 MCP가 죽는다.
- 테스트 실행: 단일 파일 `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`, 전체 `npm test`, 타입 검사 `npx tsc --noEmit`, 빌드 `npm run build`.

## Review Focus

1. **같은 포트에 이미 다른 Hub가 떠 있음**(다른 HOME의 Hub, 사용자 실제 Hub): `/api/status` 응답은 오지만 PID가 다르므로 성공이 아니다. 자식은 포트 충돌로 죽으므로 5초를 다 기다리지 않고 `Hub exited during startup`으로 끝나야 한다. → Task 2 "another process answering on the port" 테스트 + Task 3 포트 점유 실측.
2. **연결만 받고 응답하지 않는 서버**: 요청 하나에 매달려 5초를 크게 넘기면 안 된다. → Task 2 "never responds" 테스트.
3. **토큰이 맞지 않아 401**: 준비 완료로 치면 안 된다. → Task 2 "wrong token" 테스트.
4. **느리게 뜨는 Hub**(처음 몇 번은 연결 거부·503): 포기하지 않고 기다려야 한다. → Task 2 "answers only after a few tries" 테스트.
5. **CLI 번들 안에서 직접 실행 블록이 도는 것**: 전경 `hub start`가 Hub를 둘 띄우면 안 된다. → Task 1 `dist\cli.js` 거짓 테스트 + Task 3 전경 실측.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/entry.ts` | `argv[1]`이 주어진 스크립트인지(구분자 무시) | 생성 |
| `src/hub/server.ts` | 끝의 직접 실행 조건을 `isEntryScript`로 | 수정 (915–919행) |
| `src/hub/readiness.ts` | `waitForHub()` — `/api/status`가 기대 PID로 답할 때까지 대기 | 생성 |
| `src/cli.ts` | `hub start -d`가 기동을 확인하고 실패를 알림 | 수정 (88–109행) |
| `test/entry-script.test.ts` | `isEntryScript` 단위 테스트 | 생성 |
| `test/hub-readiness.test.ts` | `waitForHub` 테스트 + `server.ts` 직접 실행 회귀 테스트 | 생성 |

작업 위치: 브랜치 `fix/hub-daemon-windows`, 저장소 본 폴더(단계 A–C와 같은 방식, worktree 없음).

---

### Task 1: 직접 실행 판별이 Windows 경로를 알아본다

**Files:**
- Create: `src/shared/entry.ts`
- Modify: `src/hub/server.ts:915-919` (+ import 한 줄)
- Test: `test/entry-script.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `export function isEntryScript(argv1: string | undefined, suffixes: string[]): boolean` (`src/shared/entry.ts`)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/entry-script.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEntryScript } from '../src/shared/entry.js';

const HUB = ['/hub/server.js', '/hub/server.ts'];

test('matches the hub script whether the path uses backslashes or slashes', () => {
  assert.equal(isEntryScript('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\hub\\server.js', HUB), true);
  assert.equal(isEntryScript('C:/repo/dist/hub/server.js', HUB), true);
  assert.equal(isEntryScript('/usr/lib/node_modules/@delt/claude-alarm/dist/hub/server.js', HUB), true);
  assert.equal(isEntryScript('C:\\repo\\src\\hub\\server.ts', HUB), true);
});

test('does not match the CLI or library bundles that include the hub module', () => {
  assert.equal(isEntryScript('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\cli.js', HUB), false);
  assert.equal(isEntryScript('/repo/dist/index.js', HUB), false);
  assert.equal(isEntryScript('C:\\repo\\test\\hub-auth.test.ts', HUB), false);
});

test('needs the whole directory name before the script', () => {
  assert.equal(isEntryScript('C:\\x\\myhub\\server.js', HUB), false);
  assert.equal(isEntryScript('/x/myhub/server.js', HUB), false);
});

test('no script path is never the entry', () => {
  assert.equal(isEntryScript(undefined, HUB), false);
  assert.equal(isEntryScript('', HUB), false);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/entry-script.test.ts`
Expected: FAIL — `Cannot find module` … `src/shared/entry.js` (파일이 아직 없음)

- [ ] **Step 3: 구현**

`src/shared/entry.ts`:

```ts
export function isEntryScript(argv1: string | undefined, suffixes: string[]): boolean {
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/g, '/');
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}
```

`src/hub/server.ts` — import 목록의 `import { permissionKey } from '../shared/permission-key.js';` 바로 아래에 추가:

```ts
import { isEntryScript } from '../shared/entry.js';
```

`src/hub/server.ts` 915–919행:

```ts
// Direct execution support
if (process.argv[1] && (
  process.argv[1].endsWith('hub/server.js') ||
  process.argv[1].endsWith('hub/server.ts')
)) {
```

를 다음으로 바꾼다(블록 본문 920–933행은 그대로):

```ts
// Not import.meta.url: dist/cli.js bundles this module, so that check would also pass inside the CLI and start a second hub.
if (isEntryScript(process.argv[1], ['/hub/server.js', '/hub/server.ts'])) {
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/entry-script.test.ts`
Expected: PASS (4 tests)

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/shared/entry.ts src/hub/server.ts test/entry-script.test.ts
git commit -m "fix(hub): recognise the hub script on Windows, where argv[1] uses backslashes"
```

---

### Task 2: `hub start -d`가 Hub가 실제로 떴는지 확인한다

**Files:**
- Create: `src/hub/readiness.ts`
- Modify: `src/cli.ts:88-109` (+ import 한 줄)
- Test: `test/hub-readiness.test.ts`

**Interfaces:**
- Consumes: Task 1의 `isEntryScript` — 직접 호출하지 않지만, 마지막 테스트("the hub module run directly…")는 Task 1이 고친 `server.ts` 직접 실행에 의존한다
- Produces (`src/hub/readiness.ts`):
  - `export type HubStartup = 'ready' | 'exited' | 'timeout';`
  - `export const HUB_START_TIMEOUT_MS = 5000;`
  - `export interface WaitForHubOptions { url: string; token?: string; pid: number; isAlive: () => boolean; timeoutMs?: number; intervalMs?: number; }`
  - `export async function waitForHub(opts: WaitForHubOptions): Promise<HubStartup>`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/hub-readiness.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { waitForHub } from '../src/hub/readiness.js';

const alive = () => true;

function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api/status`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('ready when the hub answers with the pid that was started', async () => {
  const hub = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: 'Unauthorized' });
    json(res, 200, { running: true, pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, token: 'tok', pid: 4242, isAlive: alive, timeoutMs: 2000, intervalMs: 50 }), 'ready');
  } finally {
    await hub.close();
  }
});

test('a hub that answers only after a few tries is still ready', async () => {
  let calls = 0;
  const hub = await serve((_req, res) => {
    calls += 1;
    if (calls < 3) return json(res, 503, {});
    json(res, 200, { pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: alive, timeoutMs: 2000, intervalMs: 50 }), 'ready');
    assert.ok(calls >= 3);
  } finally {
    await hub.close();
  }
});

test('another process answering on the port is not the hub that was started', async () => {
  const hub = await serve((_req, res) => json(res, 200, { pid: 999 }));
  try {
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  } finally {
    await hub.close();
  }
});

test('a wrong token never counts as ready', async () => {
  const hub = await serve((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: 'Unauthorized' });
    json(res, 200, { pid: 4242 });
  });
  try {
    assert.equal(await waitForHub({ url: hub.url, token: 'nope', pid: 4242, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  } finally {
    await hub.close();
  }
});

test('nothing listening times out after the given time', async () => {
  const hub = await serve((_req, res) => json(res, 200, {}));
  const url = hub.url;
  await hub.close();
  const started = Date.now();
  assert.equal(await waitForHub({ url, pid: 1, isAlive: alive, timeoutMs: 400, intervalMs: 50 }), 'timeout');
  assert.ok(Date.now() - started >= 350);
});

test('a server that never responds still times out on schedule', async () => {
  const hub = await serve(() => {});
  try {
    const started = Date.now();
    assert.equal(await waitForHub({ url: hub.url, pid: 1, isAlive: alive, timeoutMs: 500, intervalMs: 50 }), 'timeout');
    assert.ok(Date.now() - started < 1500);
  } finally {
    await hub.close();
  }
});

test('stops waiting as soon as the process has exited', async () => {
  const hub = await serve((_req, res) => json(res, 200, { pid: 999 }));
  try {
    let checks = 0;
    const started = Date.now();
    assert.equal(await waitForHub({ url: hub.url, pid: 4242, isAlive: () => ++checks < 3, timeoutMs: 5000, intervalMs: 50 }), 'exited');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await hub.close();
  }
});

test('the hub module run directly starts a hub that answers with its own pid', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-direct-hub-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: 7990, token: 'direct-tok' },
    notifications: { desktop: false, sound: false },
    webhooks: [],
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'hub', 'server.ts')], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'ignore',
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  try {
    const startup = await waitForHub({
      url: 'http://127.0.0.1:7990/api/status',
      token: 'direct-tok',
      pid: child.pid!,
      isAlive: () => !exited,
      timeoutMs: 15_000,
    });
    assert.equal(startup, 'ready');
  } finally {
    if (!exited) child.kill();
    await exit;
  }
});
```

마지막 테스트가 이 버그의 회귀 테스트다. `path.join('src', 'hub', 'server.ts')`를 Node가 절대 경로로 바꿔 `argv[1]`에 넣으므로 Windows에서는 백슬래시 경로가 된다. Task 1 이전 코드였다면 자식이 Hub를 띄우지 않고 끝나 `'exited'`가 나온다.

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-readiness.test.ts`
Expected: FAIL — `Cannot find module` … `src/hub/readiness.js`

- [ ] **Step 3: `waitForHub` 구현**

`src/hub/readiness.ts`:

```ts
export type HubStartup = 'ready' | 'exited' | 'timeout';

export const HUB_START_TIMEOUT_MS = 5000;

export interface WaitForHubOptions {
  url: string;
  token?: string;
  pid: number;
  isAlive: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function waitForHub(opts: WaitForHubOptions): Promise<HubStartup> {
  const timeoutMs = opts.timeoutMs ?? HUB_START_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  for (;;) {
    if (!opts.isAlive()) return 'exited';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    try {
      const res = await fetch(opts.url, { headers, signal: AbortSignal.timeout(Math.min(remaining, 1000)) });
      if (res.ok) {
        const body = await res.json() as { pid?: unknown };
        if (body.pid === opts.pid) return 'ready';
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-readiness.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: `hub start -d`에 연결**

`src/cli.ts` — import 목록의 `import { installCrashGuard, logStartup } from './shared/crash-guard.js';` 바로 아래에 추가:

```ts
import { waitForHub, HUB_START_TIMEOUT_MS } from './hub/readiness.js';
```

`src/cli.ts` 88–109행(`if (daemon) {`부터 `} else {` 직전까지):

```ts
  if (daemon) {
    ensureConfigDir();
    const logFd = fs.openSync(LOG_FILE, 'a');
    const hubScript = path.join(__dirname, 'hub', 'server.js');

    const child = spawn(process.execPath, [hubScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });

    if (child.pid) {
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8');
      child.unref();
      console.log(`Hub started as daemon (PID: ${child.pid})`);
      console.log(`Dashboard: ${loginLink(displayHost, port, config.hub.token)}`);
      console.log(`Token: ${config.hub.token}`);
      console.log(`Logs: ${LOG_FILE}`);
    } else {
      console.error('Failed to start hub daemon');
      process.exit(1);
    }
  } else {
```

를 다음으로 바꾼다:

```ts
  if (daemon) {
    ensureConfigDir();
    const logFd = fs.openSync(LOG_FILE, 'a');
    const hubScript = path.join(__dirname, 'hub', 'server.js');

    const child = spawn(process.execPath, [hubScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });

    const pid = child.pid;
    if (!pid) {
      console.error('Failed to start hub daemon');
      process.exit(1);
    }
    fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.unref();

    const startup = await waitForHub({
      url: `http://${displayHost}:${port}/api/status`,
      token: config.hub.token,
      pid,
      isAlive: () => !exited,
    });
    if (startup !== 'ready') {
      if (!exited) child.kill();
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      console.error(startup === 'exited'
        ? `Hub exited during startup. See ${LOG_FILE}`
        : `Hub did not answer at http://${displayHost}:${port} within ${HUB_START_TIMEOUT_MS / 1000}s and was stopped. See ${LOG_FILE}`);
      process.exit(1);
    }

    console.log(`Hub started as daemon (PID: ${pid})`);
    console.log(`Dashboard: ${loginLink(displayHost, port, config.hub.token)}`);
    console.log(`Token: ${config.hub.token}`);
    console.log(`Logs: ${LOG_FILE}`);
  } else {
```

`displayHost`는 `hubStart` 위쪽(72행)에 이미 있다(`0.0.0.0`이면 `127.0.0.1`). `process.exit`의 반환형이 `never`라 `if (!pid)` 뒤에서 `pid`는 `number`로 좁혀진다.

- [ ] **Step 6: 전체 확인**

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `npm test`
Expected: 전체 PASS(기존 테스트 + 새 테스트 12개)

Run: `npm run build`
Expected: 성공, `dist/cli.js`·`dist/hub/server.js` 생성

- [ ] **Step 7: 커밋**

```bash
git add src/hub/readiness.ts src/cli.ts test/hub-readiness.test.ts
git commit -m "fix(cli): report hub start -d failures instead of claiming the daemon started"
```

---

### Task 3: 격리 환경에서 실제 CLI로 확인

빌드한 `dist/cli.js`를 임시 HOME·포트 7989로 실제 실행한다. 코드 변경은 없다. 실패가 나오면 고치지 말고 출력 전체를 보고한다.

**Files:**
- Create (커밋하지 않음): 작업 공간 밖 임시 폴더의 `verify-hub-daemon.mjs`

**Interfaces:**
- Consumes: Task 2까지의 빌드 결과 `dist/cli.js`, 문구 `Hub started as daemon (PID: <pid>)`, `Hub exited during startup. See <LOG_FILE>`
- Produces: 확인 결과(PASS/FAIL 목록)

- [ ] **Step 1: 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 2: 확인 스크립트 작성**

OS 임시 폴더(Claude라면 scratchpad)에 `verify-hub-daemon.mjs`를 Write 도구로 쓴다(Bash heredoc은 백슬래시를 바꾼다):

```js
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '.');
const cli = path.join(repo, 'dist', 'cli.js');
const PORT = 7989;
const TOKEN = 'verify-tok';
const results = [];

function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-verify-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: PORT, token: TOKEN },
    notifications: { desktop: false, sound: false },
    webhooks: [],
  }));
  return home;
}

const envFor = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });

function run(home, ...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { env: envFor(home), encoding: 'utf-8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function status() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function portFree() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const readLog = (home) => {
  const f = path.join(home, '.claude-alarm', 'hub.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
};

if (!(await portFree())) {
  console.log(`FAIL port ${PORT} is already in use — stop whatever holds it (do not kill by image name) and rerun`);
  process.exit(1);
}

// 1. start -d → status → stop
const home1 = makeHome();
const pidFile1 = path.join(home1, '.claude-alarm', 'hub.pid');
let r = run(home1, 'hub', 'start', '-d');
const m = r.out.match(/Hub started as daemon \(PID: (\d+)\)/);
check('start -d exits 0 and reports a PID', r.code === 0 && !!m, r.out);
const pid = m ? Number(m[1]) : NaN;
const s1 = await status();
check('/api/status answers with that PID', s1?.pid === pid, JSON.stringify(s1));
check('hub.pid holds that PID', fs.existsSync(pidFile1) && fs.readFileSync(pidFile1, 'utf-8').trim() === String(pid));
check('hub.log shows the daemon entry ran', readLog(home1).includes(`Hub daemon started (pid ${pid})`), readLog(home1).slice(-400));
r = run(home1, 'hub', 'status');
check('hub status reports it running', r.out.includes(`Hub: running (PID: ${pid})`), r.out);
r = run(home1, 'hub', 'stop');
check('hub stop stops it', r.code === 0 && r.out.includes(`Hub stopped (PID: ${pid})`), r.out);
check('port is free again after stop', await waitUntil(portFree, 5000));

// 2. port already taken → exit 1, no PID file
const blocker = http.createServer();
await new Promise((res) => blocker.listen(PORT, '127.0.0.1', res));
const home2 = makeHome();
const t0 = Date.now();
r = run(home2, 'hub', 'start', '-d');
const took = Date.now() - t0;
check('start -d with the port taken exits 1', r.code === 1, r.out);
check('…says the hub exited during startup', r.out.includes('Hub exited during startup. See '), r.out);
check('…does not claim it started', !r.out.includes('Hub started as daemon'), r.out);
check('…leaves no hub.pid', !fs.existsSync(path.join(home2, '.claude-alarm', 'hub.pid')));
check(`…returns before the 5s limit (${took}ms)`, took < 5000);
await new Promise((res) => blocker.close(res));

// 3. foreground start runs exactly one hub (the import.meta.url trap)
const home3 = makeHome();
const fg = spawn(process.execPath, [cli, 'hub', 'start'], { env: envFor(home3), stdio: ['ignore', 'pipe', 'pipe'] });
let fgOut = '';
fg.stdout.on('data', (d) => { fgOut += d; });
fg.stderr.on('data', (d) => { fgOut += d; });
const fgExit = new Promise((res) => fg.once('exit', res));
const up = await waitUntil(async () => (await status()) !== null, 15_000);
const s3 = await status();
check('foreground hub answers with the CLI process PID', up && s3?.pid === fg.pid, JSON.stringify(s3));
await new Promise((r2) => setTimeout(r2, 1000));
check('foreground process is still running', fg.exitCode === null, fgOut);
const listening = (fgOut.match(/Hub server listening/g) ?? []).length;
check(`exactly one "Hub server listening" line (${listening})`, listening === 1, fgOut);
const log3 = readLog(home3);
check('hub.log has the foreground entry and no daemon entry', log3.includes('Hub foreground started') && !log3.includes('Hub daemon started'), log3.slice(-400));
fg.kill();
await fgExit;
check('port is free after stopping the foreground hub', await waitUntil(portFree, 5000));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: 실행**

Run: `node <임시 폴더>/verify-hub-daemon.mjs C:/workspace/claude-alarm`
Expected: 모든 줄 PASS, 마지막 줄 `17/17 passed`, 종료 코드 0

스크립트는 자기가 띄운 자식만 끝낸다. 1번의 데몬은 `hub stop`(PID 파일의 PID)으로, 3번의 전경 Hub는 `fg.kill()`로 끝난다. 스크립트가 중간에 죽어 7989에 Hub가 남으면 그 Hub의 PID(`/api/status`의 `pid`)만 `taskkill //PID <pid> //F`로 끝낸다.

- [ ] **Step 4: 보고**

PASS/FAIL 목록 전체와 Windows·Node 버전(`node -v`)을 보고한다. 커밋할 파일은 없다.
