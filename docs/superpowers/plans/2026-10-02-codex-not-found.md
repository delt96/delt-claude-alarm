# Codex Not Found Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows에서 `codex`가 PATH에 없어도 표준 설치 위치에서 찾아 붙고, 그래도 없으면 어댑터가 Hub에 `Codex not found` 알림을 한 번 보낸다.

**Architecture:** `src/codex/transport.ts`에 `findCodex()`(PATH → Windows 표준 위치)를 두고 `resolveCommand`와 `init`이 쓴다. `src/codex/adapter.ts`는 데몬 연결이 `ENOENT`로 실패하면 기존 `POST /api/notify`로 알림을 보내며, 성공할 때까지(동시에 하나만) 재시도 때마다 다시 시도한다.

**Tech Stack:** TypeScript ESM, `node:test` + `tsx`, 기존 Hub HTTP API(`/api/notify`).

**Spec:** `docs/superpowers/specs/2026-10-02-codex-not-found-design.md`

## Global Constraints

- 찾는 순서(정확히 이대로): ① `findOnPath(command, platform, env)` ② `platform === 'win32'`일 때만 `<LOCALAPPDATA>\Programs\OpenAI\Codex\bin\<command>.exe` ③ `<APPDATA>\npm\<command>.cmd`. 환경 변수가 없으면 그 위치는 건너뛴다. PATH가 항상 먼저.
- `resolveCommand`의 기존 조건(Windows가 아니거나, 경로 구분자가 있거나, 확장자가 있으면 그대로)은 바꾸지 않는다. 찾은 파일이 `.cmd`면 `shell: true`.
- 알림 요청: `POST http://<opts.hub.host>:<opts.hub.port>/api/notify`, 헤더 `Content-Type: application/json`, 토큰이 있으면 `Authorization: Bearer <token>`, 본문 `{ title, message, level: 'warning' }`, 요청당 최대 5000ms.
- 알림 문구(영어, 정확히 이대로):
  - title: `Codex not found`
  - message: `The Codex adapter cannot find "<command>". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.` (`<command>`는 `opts.command`)
- 알림 조건: 연결 실패 오류의 `code === 'ENOENT'`일 때만. 2xx 응답이면 그 어댑터 인스턴스에서 다시 보내지 않음. 연결 실패·2xx 아님이면 다음 `ENOENT` 때 다시. 전송 중이면 새로 보내지 않음. 재시도 예약을 기다리게 하지 않음. 전송 실패는 `logger.debug`만.
- 기존 콘솔 경고 `Codex daemon connection failed: …`는 그대로.
- 새 의존성 없음.
- 주석 규칙: 기본 없음. 외부 제약·함정·반직관적 결정만 영어 한 줄. 섹션 구분선·코드 재진술 주석 금지.
- 포트: 단위 테스트의 기록 서버는 포트 0. 실측 Hub는 7989. 7900(사용자 실제 Hub)과 7990–7998(기존 테스트)은 쓰지 않는다.
- Hub를 띄우는 모든 실행은 임시 HOME(`HOME`과 `USERPROFILE`을 같은 임시 폴더로). 실제 `~/.claude-alarm`을 건드리지 않는다.
- 프로세스는 자기가 띄운 PID만 끝낸다. 이미지 이름(`node.exe`, `codex.exe` 등)으로 일괄 종료 금지.
- 테스트 실행: 단일 파일 `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`, 전체 `npm test`, 타입 검사 `npx tsc --noEmit`, 빌드 `npm run build`.

## Review Focus

1. **재시도가 알림 전송보다 빠를 때**(Hub 응답이 느림, 재시도 20ms 간격): 알림은 한 번만 가야 한다. → Task 2 "while the notice is still being sent" 테스트.
2. **Hub가 알림을 받지 못했을 때**(500 응답): 포기하지 않고 다음 `ENOENT` 때 다시 보내고, 성공한 뒤로는 멈춰야 한다. → Task 2 "retried until the hub accepts it" 테스트.
3. **codex는 있지만 데몬에 못 붙을 때**(proxy가 바로 종료): `Codex not found`라고 잘못 알리면 안 된다. → Task 2 "other connection failures" 테스트.
4. **PATH의 codex(예: npm `.cmd`)와 표준 위치의 `codex.exe`가 둘 다 있을 때**: 사용자가 PATH로 고른 것이 이겨야 한다. → Task 1 "codex on PATH wins" 테스트.
5. **`LOCALAPPDATA`·`APPDATA`가 없는 환경**(서비스 계정 등): 오류 없이 지금처럼 동작해야 한다. → Task 1 "codex is nowhere" 테스트.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/codex/transport.ts` | `findCodex()` 추가, `resolveCommand`가 사용 | 수정 |
| `src/cli.ts` | `init`의 Codex 설치 판단이 `findCodex` 사용 | 수정 (7행 import, 324행) |
| `src/codex/adapter.ts` | `ENOENT`면 `/api/notify`로 한 번 알림 | 수정 (`connect()` catch + 새 메서드) |
| `README.md` | Codex 안내 186–187행 보강 | 수정 |
| `test/codex-transport.test.ts` | `findCodex`·`resolveCommand` 테스트 | 수정 |
| `test/codex-adapter.test.ts` | 알림 테스트 + 기록 서버 도우미 | 수정 |

작업 위치: 브랜치 `fix/codex-not-found`, 저장소 본 폴더(worktree 없음).

---

### Task 1: PATH에 없으면 Windows 표준 설치 위치에서 codex를 찾는다

**Files:**
- Modify: `src/codex/transport.ts:15-39`
- Modify: `src/cli.ts:7`, `src/cli.ts:324`
- Test: `test/codex-transport.test.ts`

**Interfaces:**
- Consumes: 기존 `findOnPath(command, platform, env): string | undefined`
- Produces: `export function findCodex(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined` (`src/codex/transport.ts`)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/codex-transport.test.ts` — import 줄을 바꾼다:

```ts
import { connectProxy, findCodex, findOnPath, resolveCommand, type SpawnFn } from '../src/codex/transport.js';
```

파일 끝에 추가:

```ts
function winInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-find-'));
  const env = { PATH: path.join(root, 'path'), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') };
  const put = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };
  return {
    env,
    put,
    standalone: path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    npm: path.join(env.APPDATA, 'npm', 'codex.cmd'),
    onPath: (name: string) => path.join(env.PATH, name),
  };
}

test('findCodex looks in the standalone install when codex is not on PATH', () => {
  const w = winInstall();
  w.put(w.standalone);
  assert.equal(findCodex('codex', 'win32', w.env), w.standalone);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: w.standalone, shell: false });
});

test('findCodex falls back to the npm global shim, which runs through a shell', () => {
  const w = winInstall();
  w.put(w.npm);
  assert.equal(findCodex('codex', 'win32', w.env), w.npm);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: w.npm, shell: true });
});

test('findCodex prefers the standalone install over the npm shim', () => {
  const w = winInstall();
  w.put(w.standalone);
  w.put(w.npm);
  assert.equal(findCodex('codex', 'win32', w.env), w.standalone);
});

test('codex on PATH wins over the standard install locations', () => {
  const w = winInstall();
  w.put(w.standalone);
  const shim = w.put(w.onPath('codex.cmd'));
  assert.equal(findCodex('codex', 'win32', w.env), shim);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: shim, shell: true });
});

test('codex is nowhere: findCodex returns undefined and resolveCommand keeps the bare name', () => {
  const w = winInstall();
  assert.equal(findCodex('codex', 'win32', w.env), undefined);
  assert.deepEqual(resolveCommand('codex', 'win32', w.env), { file: 'codex', shell: false });
  assert.equal(findCodex('codex', 'win32', { PATH: '' }), undefined);
});

test('findCodex looks only on PATH outside Windows', () => {
  const w = winInstall();
  w.put(w.standalone);
  w.put(w.npm);
  assert.equal(findCodex('codex', 'linux', w.env), undefined);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts`
Expected: FAIL — `findCodex`가 export되지 않아 `SyntaxError: The requested module '../src/codex/transport.js' does not provide an export named 'findCodex'`

- [ ] **Step 3: 구현**

`src/codex/transport.ts` — `resolveCommand` 안의 한 줄

```ts
  const file = findOnPath(command, platform, env);
```

을

```ts
  const file = findCodex(command, platform, env);
```

으로 바꾸고, `findOnPath` 함수 바로 아래에 추가:

```ts
// A terminal opened before Codex was installed keeps its old PATH, so also look where the installers put codex.
export function findCodex(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const onPath = findOnPath(command, platform, env);
  if (onPath || platform !== 'win32') return onPath;
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', `${command}.exe`),
    env.APPDATA && path.join(env.APPDATA, 'npm', `${command}.cmd`),
  ];
  return candidates.find((file): file is string => !!file && fs.existsSync(file));
}
```

`src/cli.ts` 7행:

```ts
import { findOnPath } from './codex/transport.js';
```

→

```ts
import { findCodex } from './codex/transport.js';
```

`src/cli.ts` 324행:

```ts
    if (shouldOfferCodex(config, findOnPath('codex') !== undefined)) {
```

→

```ts
    if (shouldOfferCodex(config, findCodex('codex') !== undefined)) {
```

(`findOnPath`는 `cli.ts`에서 이 한 곳만 썼다 — `grep -n findOnPath src/cli.ts`로 다른 사용이 없는지 확인한다.)

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-transport.test.ts`
Expected: PASS (기존 테스트 + 새 6개)

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/codex/transport.ts src/cli.ts test/codex-transport.test.ts
git commit -m "feat(codex): find codex in the standard Windows install locations when it is not on PATH"
```

---

### Task 2: codex를 못 찾으면 Hub에 알림을 한 번 보낸다

**Files:**
- Modify: `src/codex/adapter.ts` (클래스 필드, `connect()`의 catch 105–114행, 새 private 메서드)
- Modify: `README.md:186-187`
- Test: `test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: 없음(Task 1과 독립 — 이 작업의 테스트는 `spawnFn`을 주입하므로 `findCodex`를 거치지 않는다)
- Produces: 없음(내부 동작)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/codex-adapter.test.ts` — 위쪽 import에 추가(`import { spawn } from 'node:child_process';` 아래):

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
```

`test('a missing Codex binary is retried without crashing', …)` 테스트 바로 아래에 추가:

```ts
interface Recorded { method?: string; url?: string; auth?: string; body: unknown }

async function recordingHub(opts: { statuses?: number[]; delayMs?: number } = {}) {
  const statuses = [...(opts.statuses ?? [])];
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(data || 'null') });
      const status = statuses.shift() ?? 200;
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, opts.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    hub: { host: '127.0.0.1', port, token: TOKEN },
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const MISSING = 'claude-alarm-no-such-codex-binary';
const NOT_FOUND_NOTICE = {
  title: 'Codex not found',
  message: `The Codex adapter cannot find "${MISSING}". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.`,
  level: 'warning',
};

function missingCodexAdapter(hub: { host: string; port: number; token?: string }, counter: { attempts: number }): CodexAdapter {
  return new CodexAdapter({
    command: MISSING,
    hub,
    reconnectMinMs: 20,
    reconnectMaxMs: 40,
    spawnFn: () => {
      counter.attempts++;
      return spawn(MISSING, [], { stdio: 'pipe' });
    },
  });
}

test('a missing Codex binary is reported to the hub once', async () => {
  const rec = await recordingHub();
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 1);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 1);
    assert.deepEqual(rec.requests[0], { method: 'POST', url: '/api/notify', auth: `Bearer ${TOKEN}`, body: NOT_FOUND_NOTICE });
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('the not-found notice is retried until the hub accepts it', async () => {
  const rec = await recordingHub({ statuses: [500, 200] });
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 2);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 2);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('no second notice is sent while the notice is still being sent', async () => {
  const rec = await recordingHub({ delayMs: 400 });
  const counter = { attempts: 0 };
  try {
    adapter = missingCodexAdapter(rec.hub, counter);
    adapter.start();
    await until(() => rec.requests.length >= 1);
    const seen = counter.attempts;
    await until(() => counter.attempts >= seen + 3);
    assert.equal(rec.requests.length, 1);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});

test('other connection failures do not send the not-found notice', async () => {
  const rec = await recordingHub();
  let attempts = 0;
  try {
    adapter = new CodexAdapter({
      command: 'codex',
      hub: rec.hub,
      reconnectMinMs: 20,
      reconnectMaxMs: 40,
      spawnFn: () => {
        attempts++;
        return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'pipe' });
      },
    });
    adapter.start();
    await until(() => attempts >= 3, 5000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rec.requests.length, 0);
  } finally {
    adapter?.stop();
    await rec.close();
  }
});
```

(재시도 간격은 20–40ms라 `until`의 기본 4초 안에 충분히 반복된다. "still being sent" 테스트에서는 첫 응답이 400ms 걸리는 동안 재시도가 여러 번 일어난다.)

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: FAIL — 새 테스트 중 앞의 세 개가 `condition not met in time`(알림 요청이 오지 않음). 네 번째("other connection failures")는 지금도 통과한다(알림을 보내지 않는 것이 기대값). 기존 테스트는 통과.

- [ ] **Step 3: 구현**

`src/codex/adapter.ts` — 클래스 필드(`private delay: number;` 바로 아래)에 추가:

```ts
  private notFoundNotice: 'unsent' | 'sending' | 'sent' = 'unsent';
```

`connect()`의 catch 블록 첫 줄

```ts
      logger.warn(`Codex daemon connection failed: ${(err as Error).message}`);
```

바로 아래에 추가:

```ts
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.noticeNotFound();
```

`scheduleRetry()` 메서드 바로 아래에 새 메서드 추가:

```ts
  private noticeNotFound(): void {
    if (this.notFoundNotice !== 'unsent') return;
    this.notFoundNotice = 'sending';
    const { host, port, token } = this.opts.hub;
    fetch(`http://${host}:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        title: 'Codex not found',
        message: `The Codex adapter cannot find "${this.opts.command}". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.`,
        level: 'warning',
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        this.notFoundNotice = res.ok ? 'sent' : 'unsent';
        if (!res.ok) logger.debug(`Codex not-found notice was refused (${res.status})`);
      })
      .catch((err) => {
        this.notFoundNotice = 'unsent';
        logger.debug(`Codex not-found notice failed: ${(err as Error).message}`);
      });
  }
```

`README.md` 186–187행:

```markdown
- Requires the Codex CLI with its app-server daemon (`codex app-server daemon version` shows `running`). Set `"codex": { "command": "C:/path/to/codex.exe" }` in `~/.claude-alarm/config.json` if `codex` is not on `PATH`.
- If the hub console keeps printing `Codex daemon connection failed: spawn codex ENOENT`, the hub's terminal cannot find `codex`. A terminal opened before Codex was installed still has the old `PATH`, so open a new terminal or set `codex.command`.
```

를 다음으로 바꾼다:

```markdown
- Requires the Codex CLI with its app-server daemon (`codex app-server daemon version` shows `running`). On Windows, when `codex` is not on `PATH`, the adapter also looks in the standard install locations (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, then `%APPDATA%\npm\codex.cmd`). Anywhere else, set `"codex": { "command": "C:/path/to/codex.exe" }` in `~/.claude-alarm/config.json`.
- If `codex` cannot be found at all, the hub sends one `Codex not found` notification (desktop and webhooks) and the console keeps printing `Codex daemon connection failed: spawn codex ENOENT`. A terminal opened before Codex was installed still has the old `PATH`, so open a new terminal and restart the hub, or set `codex.command`.
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-adapter.test.ts`
Expected: PASS (기존 + 새 4개)

Run: `npx tsc --noEmit`
Expected: 오류 없음

Run: `npm test`
Expected: 전체 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/codex/adapter.ts README.md test/codex-adapter.test.ts
git commit -m "feat(codex): notify once through the hub when the codex command cannot be found"
```

---

### Task 3: 격리 환경에서 실제 Hub·데몬으로 확인

빌드한 CLI로 임시 HOME·포트 7989의 Hub를 Codex를 켠 채 전경으로 띄워, ① PATH에 codex가 없을 때 표준 위치로 실제 데몬에 붙는지 ② 표준 위치도 없을 때 웹훅으로 알림이 정확히 한 번 오는지 확인한다. 코드 변경은 없다. 실패가 나오면 고치지 말고 출력 전체를 보고한다.

이 확인은 사용자의 실제 Codex 데몬에 붙는다(①). 어댑터는 데몬에 로드된 대화를 이 격리 Hub에 세션으로 올리고, 작업 중인 대화는 구독한다 — 사용자 실제 Hub와 같은 동작이다. 실행 전에 claude-alarm `notify`로 사용자에게 미리 알린다. 승인 요청이 오면 답하지 않는다.

**Files:**
- Create (커밋하지 않음): 저장소 밖 임시 폴더의 `verify-codex-not-found.mjs`

**Interfaces:**
- Consumes: Task 1·2의 빌드 결과(`dist/cli.js`, `dist/codex/main.js`), 알림 문구 `Codex not found`, 로그 `Connected to Codex daemon`, `Codex daemon connection failed`
- Produces: 확인 결과(PASS/FAIL 목록)

- [ ] **Step 1: 빌드**

Run: `npm run build`
Expected: 성공

- [ ] **Step 2: 확인 스크립트 작성**

OS 임시 폴더(Claude라면 scratchpad)에 `verify-codex-not-found.mjs`를 Write 도구로 쓴다:

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(process.argv[2] ?? '.');
const cli = path.join(repo, 'dist', 'cli.js');
const PORT = 7989;
const results = [];

function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}`);
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

function withoutCodexOnPath(pathValue) {
  return pathValue.split(path.delimiter).filter((dir) => dir && !['codex.exe', 'codex.cmd', 'codex'].some((n) => fs.existsSync(path.join(dir, n)))).join(path.delimiter);
}

const webhookBodies = [];
const webhook = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => { webhookBodies.push(JSON.parse(data)); res.end('ok'); });
});
await new Promise((r) => webhook.listen(0, '127.0.0.1', r));
const webhookUrl = `http://127.0.0.1:${webhook.address().port}/hook`;

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-codex-verify-'));
  fs.mkdirSync(path.join(home, '.claude-alarm'));
  fs.writeFileSync(path.join(home, '.claude-alarm', 'config.json'), JSON.stringify({
    hub: { host: '127.0.0.1', port: PORT, token: 'verify-tok' },
    notifications: { desktop: false, sound: false },
    webhooks: [{ url: webhookUrl }],
    codex: { enabled: true },
  }));
  return home;
}

async function runHub(home, extraEnv) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: withoutCodexOnPath(process.env.PATH ?? process.env.Path ?? ''), ...extraEnv };
  delete env.Path;
  const hub = spawn(process.execPath, [cli, 'hub', 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  hub.stdout.on('data', (d) => { out += d; });
  hub.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => hub.once('exit', r));
  return {
    output: () => out,
    async stop() {
      hub.kill();
      await exit;
      const pidFile = path.join(home, '.claude-alarm', 'codex.pid');
      return waitUntil(() => !fs.existsSync(pidFile), 8000);
    },
  };
}

if (!(await portFree())) {
  console.log(`FAIL port ${PORT} is already in use — stop whatever holds it (do not kill by image name) and rerun`);
  process.exit(1);
}
check('the test PATH no longer finds codex', !withoutCodexOnPath(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, 'codex.exe'))));

// 1. codex not on PATH, standalone install present → adapter reaches the real daemon
const run1 = await runHub(makeHome(), {});
const connected = await waitUntil(() => run1.output().includes('Connected to Codex daemon'), 30_000);
check('adapter connects to the daemon through the standard install location', connected, run1.output().split('\n').filter((l) => /codex|Codex/.test(l)).slice(-6).join('\n'));
check('no ENOENT failure in run 1', !run1.output().includes('ENOENT'), run1.output().split('\n').filter((l) => l.includes('ENOENT')).slice(0, 3).join('\n'));
check('no not-found notice in run 1', !webhookBodies.some((b) => b.title === 'Codex not found'), JSON.stringify(webhookBodies));
check('run 1 adapter exits with the hub (codex.pid removed)', await run1.stop());
check('port free after run 1', await waitUntil(portFree, 5000));

// 2. codex nowhere → one notice through the webhook
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-codex-empty-'));
webhookBodies.length = 0;
const run2 = await runHub(makeHome(), { LOCALAPPDATA: empty, APPDATA: empty });
const failures = () => (run2.output().match(/Codex daemon connection failed: .*ENOENT/g) ?? []).length;
const firstNotice = await waitUntil(() => webhookBodies.some((b) => b.title === 'Codex not found'), 15_000);
check('a Codex not found notice reaches the webhook', firstNotice, JSON.stringify(webhookBodies));
const seen = failures();
const moreFailures = await waitUntil(() => failures() >= seen + 2, 20_000);
check(`the adapter keeps retrying (${failures()} ENOENT failures)`, moreFailures, run2.output().split('\n').filter((l) => l.includes('ENOENT')).slice(-3).join('\n'));
const notices = webhookBodies.filter((b) => b.title === 'Codex not found');
check(`exactly one notice despite the retries (${notices.length})`, notices.length === 1, JSON.stringify(notices));
check('notice text and level', notices[0]?.level === 'warning' && notices[0]?.message === 'The Codex adapter cannot find "codex". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.', JSON.stringify(notices[0]));
check('run 2 adapter exits with the hub (codex.pid removed)', await run2.stop());
check('port free after run 2', await waitUntil(portFree, 5000));

webhook.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: 실행**

사용자에게 claude-alarm `notify`로 "격리 Hub(7989)가 실제 Codex 데몬에 잠시 붙습니다"라고 먼저 알린다. 그다음:

Run: `node <임시 폴더>/verify-codex-not-found.mjs C:/workspace/claude-alarm`
Expected: 모든 줄 PASS, 마지막 줄 `12/12 passed`, 종료 코드 0

스크립트는 자기가 띄운 Hub만 끝낸다(`hub.kill()`). 어댑터는 Hub의 stdin이 닫히면 스스로 끝나고 `codex.pid`를 지운다. 스크립트가 중간에 죽어 7989에 Hub가 남으면 그 Hub의 PID(`/api/status`, 헤더 `Authorization: Bearer verify-tok`의 `pid`)만 `taskkill //PID <pid> //F`로 끝낸다. `codex.exe`를 이미지 이름으로 끝내지 않는다 — 사용자의 Codex 데몬과 앱이 죽는다.

- [ ] **Step 4: 보고**

PASS/FAIL 목록 전체와 `node -v`, `codex app-server daemon version` 출력을 보고한다. 커밋할 파일은 없다.
