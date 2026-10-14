# 사용량 한도 표시 (Claude·Codex 5시간·주간) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 상단에 Claude와 Codex의 5시간·주간 한도 사용률을 한 줄로 보여 준다.

**Architecture:** Claude 값은 Claude Code가 statusLine 명령의 stdin으로 넘기는 `rate_limits`를 별도 진입점 `dist/statusline.js`가 받아 `~/.claude-alarm/limits-claude.json`에 쓴다. Codex 값은 Hub가 `~/.codex/sessions`의 최근 rollout 파일 끝에서 읽는다. Hub는 30초마다와 대시보드 연결 때 두 값을 읽어, 바뀌었을 때만 `usage_limits` 메시지로 대시보드에 보낸다.

**Tech Stack:** TypeScript(ESM, `.js` import 접미사), Node `node:test` + `tsx`, `ws`, tsup 번들, 빌드 없는 단일 HTML 대시보드(`vm` 샌드박스로 시험)

**Spec:** Obsidian `Projects/claude_alarm/docs/tasks/2026-10-14-사용량-한도-표시-설계.md` (이 계획이 달라진 점은 아래 "설계 문서와 달라진 점")

## 설계 문서와 달라진 점 (계획 작성 중 실측, 2026-10-14)

1. **statusLine 등록 명령**: `claude-alarm statusline` → `node "<패키지>/dist/statusline.js"`(절대 경로, `/` 구분자). 실측: 전역 `claude-alarm` 명령은 `.cmd` 경유로 356~416ms, `node dist/cli.js`도 317~347ms(번들 전체를 읽음), 빈 `node`는 약 75ms. statusLine은 화면 갱신마다 실행되므로 가벼운 별도 진입점을 쓴다. 여전히 npm 패키지 안의 파일이고, 버전을 올려도 전역 설치 경로는 같다. npx 캐시 경로(`_npx`)면 설치를 거부한다
2. **기존 statusLine 감싸기 없음**: Windows에서 Claude Code가 statusLine을 어떤 셸로 실행하는지 확인하지 않았다(우리가 `cmd.exe`로 돌리면 bash용 명령이 깨진다). 지금 사용자 설정에는 statusLine이 없다. 그래서 기존 statusLine이 있으면 설치를 거부하고, `--replace`일 때만 원래 값을 `~/.claude-alarm/statusline-original.json`에 저장한 뒤 바꾼다. `uninstall`은 이 값으로 되돌린다. 원래 값은 `config.json`이 아니라 따로 저장한다(`loadConfig`가 토큰을 만드는 부수 효과가 있어서)
3. **파일 쓰기 조건**: "값이 같으면 안 씀" → "값이 다르거나, 같아도 마지막 기록이 60초보다 오래됐으면 씀". 같은 값이 계속 이어져도 `updatedAt`("n분 전 기준")이 갱신되게 하고, 쓰기는 분당 1회 이하로 묶는다
4. **표시 문구**: 대시보드 UI가 모두 영어라 `주` 대신 Claude Code 필드 이름을 따라 `7d`로 쓴다. statusLine 줄도 같다: `5h 42% · 7d 18%`
5. **Codex 줄 고르기**: 실제 rollout 파일의 마지막 `rate_limits`는 `limit_id: "premium"`이고 창 값이 null이었다. `limit_id`가 `"codex"`(또는 없음)이고 창 값이 있는 마지막 줄을 쓴다

## Global Constraints

- 시험 실행: 전체 `npm test`, 파일 하나는 `node --import tsx --import ./test/isolate-home.ts --test test/<file>.test.ts`. 시험 파일 첫 import는 `import './isolate-home.js';`(HOME 격리)
- 5시간 창 = `window_minutes` 300, 주간 창 = 10080(Codex). Claude는 `rate_limits.five_hour`·`seven_day`의 `used_percentage`·`resets_at`
- 사용률은 0~100으로 자른다. `resets_at`은 숫자(1e12 미만이면 초, 이상이면 ms)와 ISO 문자열을 모두 받아 ms로 바꾼다
- 비공개 형식(Claude statusLine 입력, Codex rollout)이 바뀌면 예외 없이 null로 떨어진다
- Claude 한도 파일: `~/.claude-alarm/limits-claude.json`, 내용 `{ fiveHour?, sevenDay?, updatedAt }`(`resetsAt`은 ms 또는 null)
- Hub 갱신 주기 30초. 값이 바뀔 때만 방송
- 주석: 기본 없음. 코드로 알 수 없는 것(비공개 형식 의존, 순서 함정)만 영어로
- 실제 Hub 실행은 HOME 격리(임시 HOME, 다른 포트). `node.exe` 일괄 종료 금지 — 띄운 PID만 종료
- 사용자 `~/.claude/settings.json`은 시험에서 건드리지 않는다. 실제 설치는 마지막 작업에서 사용자 확인 후

## Review Focus

- Codex rollout 파일의 마지막 `rate_limits`가 다른 `limit_id`(실측 `"premium"`, 창 null): 그 앞의 `"codex"` 줄을 읽어야 한다 → Task 2 시험
- 어제 시작해 아직 쓰고 있는 Codex 대화(어제 날짜 폴더의 파일이 가장 최근 수정): 오늘 폴더의 더 오래된 파일보다 우선해야 한다 → Task 2 시험
- 사용자가 이미 쓰고 있는 statusLine: 묻지 않고 덮어쓰면 안 되고, `uninstall`은 원래 값을 그대로 돌려놓아야 한다 → Task 4 시험
- 깨진 `settings.json`(사용자가 손으로 고치다 쉼표 하나 틀림): 어떤 파일도 쓰지 않고 실패해야 한다 → Task 4 시험
- 휴대폰 너비 대시보드: 한도 줄이 헤더를 두 줄로 늘리면 `.container`의 `calc(100vh - 97px)`가 어긋난다 — 한 줄 유지, 넘치면 말줄임 → Task 6 CSS·시험

---

### Task 1: Claude 한도 파싱과 파일 읽기·쓰기

**Files:**
- Modify: `src/shared/types.ts` (공용 타입 추가, `ChannelMessage`에 한 줄)
- Modify: `src/shared/constants.ts` (경로 상수 두 개)
- Create: `src/shared/usage-limits.ts`
- Test: `test/usage-limits.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `interface LimitWindow { usedPercent: number; resetsAt: number | null }`, `interface AgentLimits { fiveHour?: LimitWindow; sevenDay?: LimitWindow; updatedAt: number }`, `interface UsageLimits { claude: AgentLimits | null; codex: AgentLimits | null }`, `type LimitWindows = Omit<AgentLimits, 'updatedAt'>`, `ChannelMessage`에 `| { type: 'usage_limits'; limits: UsageLimits }`
  - `constants.ts`: `CLAUDE_LIMITS_FILE`, `STATUSLINE_ORIGINAL_FILE`
  - `usage-limits.ts`: `isRecord(v): v is Record<string, unknown>`, `clampPercent(n: number): number`, `toEpochMs(v: unknown): number | null`, `parseClaudeRateLimits(input: unknown): LimitWindows | null`, `readLimitsFile(file: string): AgentLimits | null`, `writeLimitsFile(file: string, limits: LimitWindows, now?: number): boolean`, `formatLimitsLine(limits: LimitWindows): string`

- [ ] **Step 1: 타입과 상수 추가**

`src/shared/types.ts`의 `AppConfig` 위에:

```ts
export interface LimitWindow {
  usedPercent: number;
  resetsAt: number | null;
}

export interface AgentLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  updatedAt: number;
}

export type LimitWindows = Omit<AgentLimits, 'updatedAt'>;

export interface UsageLimits {
  claude: AgentLimits | null;
  codex: AgentLimits | null;
}
```

`ChannelMessage` 유니온의 `| { type: 'codex_close'; sessionId: string }` 아래에:

```ts
  | { type: 'usage_limits'; limits: UsageLimits }
```

`src/shared/constants.ts`의 `CODEX_LOG_FILE` 아래에:

```ts
export const CLAUDE_LIMITS_FILE = path.join(CONFIG_DIR, 'limits-claude.json');
export const STATUSLINE_ORIGINAL_FILE = path.join(CONFIG_DIR, 'statusline-original.json');
```

- [ ] **Step 2: 실패하는 시험 작성**

`test/usage-limits.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toEpochMs,
  parseClaudeRateLimits,
  readLimitsFile,
  writeLimitsFile,
  formatLimitsLine,
} from '../src/shared/usage-limits.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));

test('toEpochMs takes seconds, milliseconds and ISO strings', () => {
  assert.equal(toEpochMs(1791962056), 1791962056000);
  assert.equal(toEpochMs(1791962056000), 1791962056000);
  assert.equal(toEpochMs('2026-10-14T05:00:00.000Z'), Date.parse('2026-10-14T05:00:00.000Z'));
  for (const bad of [null, undefined, 0, -1, Number.NaN, 'soon', {}]) assert.equal(toEpochMs(bad), null, String(bad));
});

test('parseClaudeRateLimits reads both windows from statusLine input', () => {
  const input = {
    model: { id: 'x' },
    rate_limits: {
      five_hour: { used_percentage: 42.4, resets_at: 1791962056 },
      seven_day: { used_percentage: 18, resets_at: '2026-10-20T00:00:00Z' },
    },
  };
  assert.deepEqual(parseClaudeRateLimits(input), {
    fiveHour: { usedPercent: 42.4, resetsAt: 1791962056000 },
    sevenDay: { usedPercent: 18, resetsAt: Date.parse('2026-10-20T00:00:00Z') },
  });
});

test('parseClaudeRateLimits keeps one window, clamps and drops broken input', () => {
  assert.deepEqual(parseClaudeRateLimits({ rate_limits: { seven_day: { used_percentage: 130 } } }), {
    sevenDay: { usedPercent: 100, resetsAt: null },
  });
  for (const bad of [null, 'x', {}, { rate_limits: null }, { rate_limits: { five_hour: { used_percentage: '4' } } }, { rate_limits: { spend_limit: { used_percentage: 3 } } }]) {
    assert.equal(parseClaudeRateLimits(bad), null, JSON.stringify(bad));
  }
});

test('writeLimitsFile writes, skips unchanged values for 60s, then refreshes', () => {
  const file = path.join(tmp(), 'nested', 'limits-claude.json');
  const limits = { fiveHour: { usedPercent: 42, resetsAt: 1000 } };
  assert.equal(writeLimitsFile(file, limits, 10_000), true);
  assert.deepEqual(readLimitsFile(file), { ...limits, updatedAt: 10_000 });
  assert.equal(writeLimitsFile(file, limits, 69_999), false);
  assert.equal(readLimitsFile(file)?.updatedAt, 10_000);
  assert.equal(writeLimitsFile(file, { fiveHour: { usedPercent: 43, resetsAt: 1000 } }, 20_000), true);
  assert.equal(readLimitsFile(file)?.fiveHour?.usedPercent, 43);
  assert.equal(writeLimitsFile(file, { fiveHour: { usedPercent: 43, resetsAt: 1000 } }, 80_000), true);
  assert.equal(readLimitsFile(file)?.updatedAt, 80_000);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['limits-claude.json']);
});

test('readLimitsFile returns null for missing or malformed files', () => {
  const dir = tmp();
  assert.equal(readLimitsFile(path.join(dir, 'none.json')), null);
  const bad = path.join(dir, 'bad.json');
  for (const text of ['{', '[]', '{"fiveHour":{"usedPercent":1,"resetsAt":null}}', '{"updatedAt":1,"fiveHour":{"usedPercent":"1"}}']) {
    fs.writeFileSync(bad, text);
    assert.equal(readLimitsFile(bad), null, text);
  }
});

test('formatLimitsLine rounds and skips missing windows', () => {
  assert.equal(formatLimitsLine({ fiveHour: { usedPercent: 42.4, resetsAt: null }, sevenDay: { usedPercent: 17.6, resetsAt: null } }), '5h 42% · 7d 18%');
  assert.equal(formatLimitsLine({ sevenDay: { usedPercent: 5, resetsAt: null } }), '7d 5%');
  assert.equal(formatLimitsLine({}), '');
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/usage-limits.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/usage-limits.js'`

- [ ] **Step 4: 구현**

`src/shared/usage-limits.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { AgentLimits, LimitWindow, LimitWindows } from './types.js';

const REFRESH_MS = 60_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clampPercent(n: number): number {
  return Math.min(Math.max(n, 0), 100);
}

export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function inputWindow(value: unknown): LimitWindow | undefined {
  if (!isRecord(value) || typeof value.used_percentage !== 'number' || !Number.isFinite(value.used_percentage)) return undefined;
  return { usedPercent: clampPercent(value.used_percentage), resetsAt: toEpochMs(value.resets_at) };
}

// Claude Code passes rate_limits on statusLine stdin only for subscription accounts (seen in 2.1.299).
export function parseClaudeRateLimits(input: unknown): LimitWindows | null {
  if (!isRecord(input) || !isRecord(input.rate_limits)) return null;
  const fiveHour = inputWindow(input.rate_limits.five_hour);
  const sevenDay = inputWindow(input.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
}

function storedWindow(value: unknown): LimitWindow | undefined | false {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.usedPercent !== 'number') return false;
  if (value.resetsAt !== null && typeof value.resetsAt !== 'number') return false;
  return { usedPercent: value.usedPercent, resetsAt: value.resetsAt };
}

export function readLimitsFile(file: string): AgentLimits | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.updatedAt !== 'number') return null;
  const fiveHour = storedWindow(value.fiveHour);
  const sevenDay = storedWindow(value.sevenDay);
  if (fiveHour === false || sevenDay === false) return null;
  return { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }), updatedAt: value.updatedAt };
}

const windowsKey = (limits: LimitWindows) => JSON.stringify([limits.fiveHour ?? null, limits.sevenDay ?? null]);

export function writeLimitsFile(file: string, limits: LimitWindows, now: number = Date.now()): boolean {
  const previous = readLimitsFile(file);
  if (previous && now - previous.updatedAt < REFRESH_MS && windowsKey(previous) === windowsKey(limits)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...limits, updatedAt: now }));
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return true;
}

export function formatLimitsLine(limits: LimitWindows): string {
  const parts: string[] = [];
  if (limits.fiveHour) parts.push(`5h ${Math.round(limits.fiveHour.usedPercent)}%`);
  if (limits.sevenDay) parts.push(`7d ${Math.round(limits.sevenDay.usedPercent)}%`);
  return parts.join(' · ');
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/usage-limits.test.ts`
Expected: PASS (6개). 그다음 `npx tsc --noEmit` — 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/shared/constants.ts src/shared/usage-limits.ts test/usage-limits.test.ts
git commit -m "feat(limits): parse Claude rate limits from statusLine input and keep them in a file"
```

---

### Task 2: Codex rollout 파일에서 한도 읽기

**Files:**
- Create: `src/hub/codex-limits.ts`
- Test: `test/codex-limits.test.ts`

**Interfaces:**
- Consumes: `isRecord`, `clampPercent`, `toEpochMs`(Task 1 `src/shared/usage-limits.ts`), `AgentLimits`, `LimitWindows`, `LimitWindow`(Task 1 `types.ts`)
- Produces: `codexHome(env?: NodeJS.ProcessEnv): string`, `parseCodexRateLimits(entry: unknown): LimitWindows | null`, `readCodexLimits(home?: string): AgentLimits | null`

- [ ] **Step 1: 실패하는 시험 작성**

`test/codex-limits.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexHome, parseCodexRateLimits, readCodexLimits } from '../src/hub/codex-limits.js';

const codexLine = (fivePct: number, weekPct: number, timestamp = '2026-10-14T03:40:00.000Z') =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: fivePct, window_minutes: 300, resets_at: 1791962056 },
        secondary: { used_percent: weekPct, window_minutes: 10080, resets_at: 1792480091 },
      },
    },
  });

const premiumLine = JSON.stringify({
  timestamp: '2026-10-14T03:41:09.022Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null } },
});

function rollout(home: string, day: string, name: string, lines: string[], mtimeMs: number): string {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));

test('codexHome honours CODEX_HOME', () => {
  assert.equal(codexHome({ CODEX_HOME: 'C:\\x' }), 'C:\\x');
  assert.equal(codexHome({}), path.join(os.homedir(), '.codex'));
});

test('parseCodexRateLimits picks windows by length, not order', () => {
  const swapped = JSON.parse(codexLine(99, 35));
  const { primary, secondary } = swapped.payload.rate_limits;
  swapped.payload.rate_limits.primary = secondary;
  swapped.payload.rate_limits.secondary = primary;
  assert.deepEqual(parseCodexRateLimits(swapped), {
    fiveHour: { usedPercent: 99, resetsAt: 1791962056000 },
    sevenDay: { usedPercent: 35, resetsAt: 1792480091000 },
  });
});

test('parseCodexRateLimits ignores other limits and other lines', () => {
  assert.equal(parseCodexRateLimits(JSON.parse(premiumLine)), null);
  const odd = JSON.parse(codexLine(10, 20));
  odd.payload.rate_limits.primary.window_minutes = 60;
  odd.payload.rate_limits.secondary = null;
  assert.equal(parseCodexRateLimits(odd), null);
  const noId = JSON.parse(codexLine(10, 20));
  delete noId.payload.rate_limits.limit_id;
  assert.equal(parseCodexRateLimits(noId)?.fiveHour?.usedPercent, 10);
  for (const bad of [null, {}, { type: 'event_msg', payload: { type: 'agent_message' } }]) assert.equal(parseCodexRateLimits(bad), null);
});

test('readCodexLimits reads the last codex line before a trailing premium line', () => {
  const home = tmpHome();
  rollout(home, '2026/10/14', 'a', [codexLine(50, 30, '2026-10-14T03:00:00.000Z'), codexLine(99, 35), premiumLine, '{broken'], 2_000_000_000_000);
  assert.deepEqual(readCodexLimits(home), {
    fiveHour: { usedPercent: 99, resetsAt: 1791962056000 },
    sevenDay: { usedPercent: 35, resetsAt: 1792480091000 },
    updatedAt: Date.parse('2026-10-14T03:40:00.000Z'),
  });
});

test('readCodexLimits prefers the most recently written file across recent days', () => {
  const home = tmpHome();
  rollout(home, '2026/10/14', 'today-old', [codexLine(10, 10)], 1_000_000_000_000);
  rollout(home, '2026/10/13', 'yesterday-live', [codexLine(77, 40)], 1_000_000_500_000);
  assert.equal(readCodexLimits(home)?.fiveHour?.usedPercent, 77);
});

test('readCodexLimits falls back to an older file when the newest has no limits', () => {
  const home = tmpHome();
  rollout(home, '2026/10/14', 'new', [premiumLine], 1_000_000_500_000);
  rollout(home, '2026/10/14', 'old', [codexLine(12, 34)], 1_000_000_000_000);
  assert.equal(readCodexLimits(home)?.sevenDay?.usedPercent, 34);
});

test('readCodexLimits returns null without sessions', () => {
  assert.equal(readCodexLimits(tmpHome()), null);
  assert.equal(readCodexLimits(path.join(tmpHome(), 'missing')), null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-limits.test.ts`
Expected: FAIL — `Cannot find module '../src/hub/codex-limits.js'`

- [ ] **Step 3: 구현**

`src/hub/codex-limits.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentLimits, LimitWindow, LimitWindows } from '../shared/types.js';
import { clampPercent, isRecord, toEpochMs } from '../shared/usage-limits.js';

// Codex rollout files are undocumented (codex-cli 0.159.3): event_msg/token_count lines carry rate_limits,
// and a trailing line for another limit_id (e.g. "premium") can have null windows.
const TAIL_BYTES = 256 * 1024;
const DAY_DIRS = 3;
const MAX_FILES = 5;
const FIVE_HOURS_MIN = 300;
const SEVEN_DAYS_MIN = 10080;

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function parseCodexRateLimits(entry: unknown): LimitWindows | null {
  if (!isRecord(entry) || entry.type !== 'event_msg' || !isRecord(entry.payload)) return null;
  if (entry.payload.type !== 'token_count' || !isRecord(entry.payload.rate_limits)) return null;
  const limits = entry.payload.rate_limits;
  if (limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== 'codex') return null;
  const out: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } = {};
  for (const w of [limits.primary, limits.secondary]) {
    if (!isRecord(w) || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
    const win = { usedPercent: clampPercent(w.used_percent), resetsAt: toEpochMs(w.resets_at) };
    if (w.window_minutes === FIVE_HOURS_MIN) out.fiveHour = win;
    else if (w.window_minutes === SEVEN_DAYS_MIN) out.sevenDay = win;
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

function numericDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function recentDayDirs(sessionsDir: string): string[] {
  const days: string[] = [];
  for (const year of numericDirs(sessionsDir)) {
    for (const month of numericDirs(year)) {
      for (const day of numericDirs(month)) {
        days.push(day);
        if (days.length === DAY_DIRS) return days;
      }
    }
  }
  return days;
}

function recentRollouts(sessionsDir: string): Array<{ file: string; mtimeMs: number }> {
  const files: Array<{ file: string; mtimeMs: number }> = [];
  for (const day of recentDayDirs(sessionsDir)) {
    let names: string[];
    try {
      names = fs.readdirSync(day).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(day, name);
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

function tailLines(file: string): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function lastLimits(file: string, mtimeMs: number): AgentLimits | null {
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const windows = parseCodexRateLimits(entry);
    if (!windows) continue;
    const stamp = isRecord(entry) ? toEpochMs(entry.timestamp) : null;
    return { ...windows, updatedAt: stamp ?? mtimeMs };
  }
  return null;
}

export function readCodexLimits(home: string = codexHome()): AgentLimits | null {
  try {
    for (const { file, mtimeMs } of recentRollouts(path.join(home, 'sessions'))) {
      const limits = lastLimits(file, mtimeMs);
      if (limits) return limits;
    }
  } catch {}
  return null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/codex-limits.test.ts`
Expected: PASS (7개)

- [ ] **Step 5: 실제 파일로 한 번 확인 (읽기만)**

Run: `npx tsx -e "import('./src/hub/codex-limits.ts').then(m => console.log(JSON.stringify(m.readCodexLimits())))"`
Expected: `fiveHour`·`sevenDay`가 든 JSON(이 PC의 실제 Codex 사용량). `null`이면 원인(형식 변경, `limit_id`)을 보고하고 멈춘다

- [ ] **Step 6: 커밋**

```bash
git add src/hub/codex-limits.ts test/codex-limits.test.ts
git commit -m "feat(limits): read Codex 5-hour and weekly limits from the latest rollout files"
```

---

### Task 3: statusLine 진입점 `dist/statusline.js`

**Files:**
- Create: `src/statusline/run.ts`
- Create: `src/statusline/main.ts`
- Modify: `tsup.config.ts` (실행 진입점에 `statusline` 추가)
- Test: `test/statusline-run.test.ts`

**Interfaces:**
- Consumes: `parseClaudeRateLimits`, `writeLimitsFile`, `formatLimitsLine`(Task 1), `CLAUDE_LIMITS_FILE`(Task 1)
- Produces: `runStatusLine(raw: string, limitsFile: string, now?: number): string`, 빌드 결과 `dist/statusline.js`

- [ ] **Step 1: 실패하는 시험 작성**

`test/statusline-run.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStatusLine } from '../src/statusline/run.js';
import { readLimitsFile } from '../src/shared/usage-limits.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), 'limits-claude.json');

test('runStatusLine prints the line and stores the limits', () => {
  const f = file();
  const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1791962056 }, seven_day: { used_percentage: 18, resets_at: 1792480091 } } });
  assert.equal(runStatusLine(raw, f, 5000), '5h 42% · 7d 18%');
  assert.deepEqual(readLimitsFile(f), {
    fiveHour: { usedPercent: 42, resetsAt: 1791962056000 },
    sevenDay: { usedPercent: 18, resetsAt: 1792480091000 },
    updatedAt: 5000,
  });
});

test('runStatusLine prints nothing and writes nothing without limits', () => {
  const f = file();
  for (const raw of ['', 'not json', '{}', JSON.stringify({ rate_limits: null })]) {
    assert.equal(runStatusLine(raw, f), '', raw);
  }
  assert.equal(fs.existsSync(f), false);
});

test('runStatusLine still prints when the file cannot be written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, '');
  const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7 } } });
  assert.equal(runStatusLine(raw, path.join(blocker, 'limits.json')), '5h 7%');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/statusline-run.test.ts`
Expected: FAIL — `Cannot find module '../src/statusline/run.js'`

- [ ] **Step 3: 구현**

`src/statusline/run.ts`:

```ts
import { formatLimitsLine, parseClaudeRateLimits, writeLimitsFile } from '../shared/usage-limits.js';

export function runStatusLine(raw: string, limitsFile: string, now: number = Date.now()): string {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return '';
  }
  const limits = parseClaudeRateLimits(input);
  if (!limits) return '';
  try {
    writeLimitsFile(limitsFile, limits, now);
  } catch {}
  return formatLimitsLine(limits);
}
```

`src/statusline/main.ts`:

```ts
import { CLAUDE_LIMITS_FILE } from '../shared/constants.js';
import { runStatusLine } from './run.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(runStatusLine(Buffer.concat(chunks).toString('utf8'), CLAUDE_LIMITS_FILE));
});
```

`tsup.config.ts`의 두 번째 설정(`// CLI + Channel server`) `entry`에 한 줄 추가:

```ts
    entry: {
      'cli': 'src/cli.ts',
      'channel/server': 'src/channel/server.ts',
      'statusline': 'src/statusline/main.ts',
    },
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/statusline-run.test.ts`
Expected: PASS (3개)

- [ ] **Step 5: 빌드하고 시작 시간 재기**

Run(Git Bash):
```bash
npm run build
echo '{"rate_limits":{"five_hour":{"used_percentage":42}}}' | HOME=$(mktemp -d) USERPROFILE=$(mktemp -d) node dist/statusline.js; echo
for i in 1 2 3; do s=$(date +%s%N); echo '{}' | node dist/statusline.js; e=$(date +%s%N); echo $(( (e-s)/1000000 ))ms; done
```
Expected: 첫 줄 `5h 42%`. 시간은 150ms 이하(빈 `node` 약 75ms 기준). 넘으면 숫자를 보고한다(`dist/statusline.js`가 `ws`·`zod` 등을 끌어오지 않는지 `grep -c "from \"ws\"" dist/statusline.js`로 확인)

- [ ] **Step 6: 커밋**

```bash
git add src/statusline/run.ts src/statusline/main.ts tsup.config.ts test/statusline-run.test.ts
git commit -m "feat(statusline): light statusline entry that prints and stores Claude rate limits"
```

---

### Task 4: `claude-alarm statusline install` / `uninstall`

**Files:**
- Create: `src/statusline/install.ts`
- Modify: `src/cli.ts` (명령 분기, 사용법 문구)
- Test: `test/statusline-install.test.ts`

**Interfaces:**
- Consumes: `isRecord`(Task 1), `STATUSLINE_ORIGINAL_FILE`(Task 1), `claudeConfigDir`(기존 `src/channel/peer-name.ts`), 빌드 결과 `dist/statusline.js`(Task 3)
- Produces: `statusLineCommand(scriptPath: string): string`, `isOurStatusLine(value: unknown): boolean`, `installStatusLine(opts): InstallResult`, `uninstallStatusLine(opts): UninstallResult`

- [ ] **Step 1: 실패하는 시험 작성**

`test/statusline-install.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installStatusLine, uninstallStatusLine, statusLineCommand, isOurStatusLine } from '../src/statusline/install.js';

const SCRIPT = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js';
const OURS = 'node "C:/Users/u/AppData/Roaming/npm/node_modules/@delt/claude-alarm/dist/statusline.js"';

function setup(settings?: unknown | string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-install-'));
  const settingsFile = path.join(dir, 'claude', 'settings.json');
  const originalFile = path.join(dir, 'alarm', 'statusline-original.json');
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  return { settingsFile, originalFile, read };
}

test('statusLineCommand uses forward slashes and quotes the path', () => {
  assert.equal(statusLineCommand(SCRIPT), OURS);
  assert.equal(isOurStatusLine({ type: 'command', command: OURS }), true);
  assert.equal(isOurStatusLine({ type: 'command', command: 'node "C:/workspace/claude-alarm/dist/statusline.js"' }), true);
  assert.equal(isOurStatusLine({ type: 'command', command: 'bash ~/.claude/statusline.sh' }), false);
});

test('install adds the statusLine and keeps other settings', () => {
  const s = setup({ model: 'opus', hooks: { Stop: [] } });
  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT }), { ok: true, action: 'installed' });
  assert.deepEqual(s.read(), { model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command', command: OURS } });
});

test('install creates settings.json when it does not exist', () => {
  const s = setup();
  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT }), { ok: true, action: 'installed' });
  assert.deepEqual(s.read(), { statusLine: { type: 'command', command: OURS } });
});

test('install refuses to replace another statusLine unless asked, and uninstall restores it', () => {
  const theirs = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 1 };
  const s = setup({ statusLine: theirs });
  const refused = installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, 'occupied');
  assert.deepEqual(s.read().statusLine, theirs);
  assert.equal(fs.existsSync(s.originalFile), false);

  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT, replace: true }), { ok: true, action: 'replaced' });
  assert.deepEqual(s.read().statusLine, { type: 'command', command: OURS });

  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'restored' });
  assert.deepEqual(s.read().statusLine, theirs);
  assert.equal(fs.existsSync(s.originalFile), false);
});

test('reinstalling ours updates the path and keeps the saved original', () => {
  const theirs = { type: 'command', command: 'x' };
  const s = setup({ statusLine: theirs });
  installStatusLine({ ...s, scriptPath: SCRIPT, replace: true });
  const moved = 'D:\\npm\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js';
  assert.deepEqual(installStatusLine({ ...s, scriptPath: moved }), { ok: true, action: 'updated' });
  assert.equal(s.read().statusLine.command, 'node "D:/npm/node_modules/@delt/claude-alarm/dist/statusline.js"');
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'restored' });
  assert.deepEqual(s.read().statusLine, theirs);
});

test('uninstall removes ours when there was nothing before, and leaves others alone', () => {
  const s = setup({ model: 'opus' });
  installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'removed' });
  assert.deepEqual(s.read(), { model: 'opus' });
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'absent' });

  const other = setup({ statusLine: { type: 'command', command: 'x' } });
  const result = uninstallStatusLine(other);
  assert.equal(!result.ok && result.reason, 'not-ours');
  assert.deepEqual(other.read().statusLine, { type: 'command', command: 'x' });
});

test('a broken settings.json is never written', () => {
  const s = setup('{ "model": "opus", }');
  const result = installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.equal(!result.ok && result.reason, 'bad-settings');
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), '{ "model": "opus", }');
  const un = uninstallStatusLine(s);
  assert.equal(!un.ok && un.reason, 'bad-settings');
  assert.equal(fs.existsSync(s.originalFile), false);
});

test('install refuses an npx cache path', () => {
  const s = setup({});
  const result = installStatusLine({ ...s, scriptPath: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js' });
  assert.equal(!result.ok && result.reason, 'npx');
  assert.deepEqual(s.read(), {});
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/statusline-install.test.ts`
Expected: FAIL — `Cannot find module '../src/statusline/install.js'`

- [ ] **Step 3: 구현**

`src/statusline/install.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../shared/usage-limits.js';

export type InstallResult =
  | { ok: true; action: 'installed' | 'updated' | 'replaced' }
  | { ok: false; reason: 'npx' | 'bad-settings' | 'occupied'; detail?: string };

export type UninstallResult =
  | { ok: true; action: 'restored' | 'removed' | 'absent' }
  | { ok: false; reason: 'bad-settings' | 'not-ours'; detail?: string };

interface Files {
  settingsFile: string;
  originalFile: string;
}

const OURS = /claude-alarm\/dist\/statusline\.js/;

export function statusLineCommand(scriptPath: string): string {
  return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

export function isOurStatusLine(value: unknown): boolean {
  return isRecord(value) && typeof value.command === 'string' && OURS.test(value.command.replace(/\\/g, '/'));
}

function readJson(file: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (!fs.existsSync(file)) return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function installStatusLine(opts: Files & { scriptPath: string; replace?: boolean }): InstallResult {
  if (/[\\/]_npx[\\/]/.test(opts.scriptPath)) return { ok: false, reason: 'npx' };
  const read = readJson(opts.settingsFile);
  if (!read.ok) return { ok: false, reason: 'bad-settings' };
  const settings = read.value ?? {};
  const current = settings.statusLine;
  const command = statusLineCommand(opts.scriptPath);
  let action: 'installed' | 'updated' | 'replaced' = 'installed';
  let next: Record<string, unknown> = { type: 'command', command };
  if (current !== undefined) {
    if (isOurStatusLine(current)) {
      action = 'updated';
      next = { ...(current as Record<string, unknown>), type: 'command', command };
    } else if (!opts.replace) {
      return { ok: false, reason: 'occupied', detail: JSON.stringify(current) };
    } else {
      writeJson(opts.originalFile, { statusLine: current });
      action = 'replaced';
    }
  }
  writeJson(opts.settingsFile, { ...settings, statusLine: next });
  return { ok: true, action };
}

export function uninstallStatusLine(opts: Files): UninstallResult {
  const read = readJson(opts.settingsFile);
  if (!read.ok) return { ok: false, reason: 'bad-settings' };
  const settings = read.value ?? {};
  const current = settings.statusLine;
  if (current === undefined) return { ok: true, action: 'absent' };
  if (!isOurStatusLine(current)) return { ok: false, reason: 'not-ours', detail: JSON.stringify(current) };
  const saved = readJson(opts.originalFile);
  if (saved.ok && saved.value && saved.value.statusLine !== undefined) {
    writeJson(opts.settingsFile, { ...settings, statusLine: saved.value.statusLine });
    fs.rmSync(opts.originalFile, { force: true });
    return { ok: true, action: 'restored' };
  }
  const { statusLine: _removed, ...rest } = settings;
  writeJson(opts.settingsFile, rest);
  return { ok: true, action: 'removed' };
}
```

`src/cli.ts`:

import 줄에 추가:

```ts
import { installStatusLine, uninstallStatusLine } from './statusline/install.js';
import { claudeConfigDir } from './channel/peer-name.js';
```

`./shared/constants.js` import 목록에 `STATUSLINE_ORIGINAL_FILE` 추가.

`printUsage()`의 `claude-alarm codex run ...` 설명 뒤, `claude-alarm help` 앞에:

```
  claude-alarm statusline install [--replace]
                                Show Claude 5-hour and weekly usage in the dashboard through Claude Code's status line
                                (--replace: replace an existing status line; uninstall puts it back)
  claude-alarm statusline uninstall
                                Remove the claude-alarm status line
```

`main()`의 `if (cmd === 'setup')` 앞에:

```ts
  if (cmd === 'statusline') {
    const files = { settingsFile: path.join(claudeConfigDir(), 'settings.json'), originalFile: STATUSLINE_ORIGINAL_FILE };
    if (sub === 'install') {
      const result = installStatusLine({ ...files, scriptPath: path.join(__dirname, 'statusline.js'), replace: args.includes('--replace') });
      if (result.ok) {
        console.log(`✓ Status line ${result.action} in ${files.settingsFile}. New Claude Code sessions report their usage limits.`);
      } else if (result.reason === 'npx') {
        console.error('Install claude-alarm globally first (npm i -g @delt/claude-alarm); an npx copy can move.');
        process.exitCode = 1;
      } else if (result.reason === 'bad-settings') {
        console.error(`${files.settingsFile} is not valid JSON; nothing was changed.`);
        process.exitCode = 1;
      } else {
        console.error(`A status line is already set: ${result.detail}\nRun with --replace to replace it (uninstall puts it back).`);
        process.exitCode = 1;
      }
    } else if (sub === 'uninstall') {
      const result = uninstallStatusLine(files);
      if (result.ok) {
        console.log(result.action === 'absent' ? 'No status line is set.' : `✓ Status line ${result.action} in ${files.settingsFile}.`);
      } else if (result.reason === 'bad-settings') {
        console.error(`${files.settingsFile} is not valid JSON; nothing was changed.`);
        process.exitCode = 1;
      } else {
        console.error(`The status line is not claude-alarm's; left as is: ${result.detail}`);
        process.exitCode = 1;
      }
    } else {
      console.error(`Unknown statusline command: ${sub}`);
      printUsage();
      process.exit(1);
    }
    return;
  }
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/statusline-install.test.ts`
Expected: PASS (8개). `npx tsc --noEmit` 오류 없음

- [ ] **Step 5: 격리된 설정 폴더로 CLI 확인**

Run(Git Bash):
```bash
npm run build
before=$(stat -c %y ~/.claude/settings.json)
( T=$(mktemp -d); export CLAUDE_CONFIG_DIR=$T/claude HOME=$T USERPROFILE=$T
  node dist/cli.js statusline install; cat $T/claude/settings.json
  node dist/cli.js statusline uninstall; cat $T/claude/settings.json )
[ "$before" = "$(stat -c %y ~/.claude/settings.json)" ] && echo "real settings untouched"
```
Expected: 첫 `cat`에 `"command": "node \"C:/workspace/claude-alarm/dist/statusline.js\""`, 두 번째는 `{}`, 마지막 줄 `real settings untouched`

- [ ] **Step 6: 커밋**

```bash
git add src/statusline/install.ts src/cli.ts test/statusline-install.test.ts
git commit -m "feat(statusline): install and uninstall the status line without losing an existing one"
```

---

### Task 5: Hub가 한도를 읽어 대시보드에 보냄

**Files:**
- Create: `src/hub/usage-limits.ts`
- Modify: `src/hub/server.ts` (생성자 옵션, 필드, `start`/`stop`, `handleDashboardConnection`)
- Test: `test/hub-usage-limits.test.ts`

**Interfaces:**
- Consumes: `readLimitsFile`(Task 1), `CLAUDE_LIMITS_FILE`(Task 1), `readCodexLimits`(Task 2), `UsageLimits`·`ChannelMessage`의 `usage_limits`(Task 1)
- Produces: `readUsageLimits(): UsageLimits`, `HubServer` 생성자 옵션 `readUsageLimits?: () => UsageLimits`, `usageLimitsIntervalMs?: number`, 대시보드 메시지 `{ type: 'usage_limits', limits: UsageLimits }`

- [ ] **Step 1: 실패하는 시험 작성**

`test/hub-usage-limits.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { HubServer } from '../src/hub/server.js';
import type { UsageLimits } from '../src/shared/types.js';

const PORT = 7986;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function connect(inbox: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/dashboard?token=t`);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const limitsMsgs = (inbox: any[]) => inbox.filter((m) => m.type === 'usage_limits');

test('hub sends usage limits on connect and only again when they change', async () => {
  let current: UsageLimits = { claude: { fiveHour: { usedPercent: 42, resetsAt: null }, updatedAt: 1 }, codex: null };
  let reads = 0;
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any, {
    readUsageLimits: () => {
      reads++;
      return current;
    },
    usageLimitsIntervalMs: 50,
  });
  await hub.start();
  try {
    const inbox: any[] = [];
    const d = await connect(inbox);
    await settle();
    assert.equal(limitsMsgs(inbox).length, 1);
    assert.deepEqual(limitsMsgs(inbox)[0].limits, current);

    await settle(200);
    assert.ok(reads >= 3, `reads ${reads}`);
    assert.equal(limitsMsgs(inbox).length, 1);

    current = { ...current, codex: { sevenDay: { usedPercent: 35, resetsAt: 9 }, updatedAt: 2 } };
    await settle(200);
    assert.equal(limitsMsgs(inbox).length, 2);
    assert.deepEqual(limitsMsgs(inbox)[1].limits, current);

    const second: any[] = [];
    const d2 = await connect(second);
    await settle();
    assert.deepEqual(limitsMsgs(second).map((m) => m.limits), [current]);
    assert.equal(limitsMsgs(inbox).length, 2);

    d.close();
    d2.close();
  } finally {
    await hub.stop();
  }
});

test('a failing reader does not break the hub or dashboards', async () => {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: 't' } } as any, {
    readUsageLimits: () => {
      throw new Error('boom');
    },
    usageLimitsIntervalMs: 50,
  });
  await hub.start();
  try {
    const inbox: any[] = [];
    const d = await connect(inbox);
    await settle(200);
    assert.deepEqual(limitsMsgs(inbox).map((m) => m.limits), [{ claude: null, codex: null }]);
    assert.ok(inbox.some((m) => m.type === 'sessions_list'));
    d.close();
  } finally {
    await hub.stop();
  }
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-usage-limits.test.ts`
Expected: FAIL — `usage_limits` 메시지 0개(`1 !== 0`)

- [ ] **Step 3: 구현**

`src/hub/usage-limits.ts`:

```ts
import { CLAUDE_LIMITS_FILE } from '../shared/constants.js';
import { readLimitsFile } from '../shared/usage-limits.js';
import type { UsageLimits } from '../shared/types.js';
import { readCodexLimits } from './codex-limits.js';

export function readUsageLimits(): UsageLimits {
  return { claude: readLimitsFile(CLAUDE_LIMITS_FILE), codex: readCodexLimits() };
}
```

`src/hub/server.ts`:

1) import 추가: `import { readUsageLimits } from './usage-limits.js';`, 타입 import 목록에 `UsageLimits` 추가

2) 필드(`private codexCalls = ...` 아래):

```ts
  private readUsageLimits: () => UsageLimits;
  private usageLimitsIntervalMs: number;
  private usageLimitsTimer?: ReturnType<typeof setInterval>;
  private usageLimits: UsageLimits = { claude: null, codex: null };
  private usageLimitsKey = JSON.stringify(this.usageLimits);
```

3) 생성자 시그니처와 첫 줄:

```ts
  constructor(
    config?: Partial<AppConfig>,
    options: { codexCallTimeoutMs?: number; readUsageLimits?: () => UsageLimits; usageLimitsIntervalMs?: number } = {},
  ) {
    this.codexCallTimeoutMs = options.codexCallTimeoutMs ?? 60_000;
    this.readUsageLimits = options.readUsageLimits ?? readUsageLimits;
    this.usageLimitsIntervalMs = options.usageLimitsIntervalMs ?? 30_000;
```

4) 메서드(`startHeartbeat` 위):

```ts
  private refreshUsageLimits(): boolean {
    let next: UsageLimits;
    try {
      next = this.readUsageLimits();
    } catch (err) {
      logger.debug(`Usage limits read failed: ${(err as Error).message}`);
      return false;
    }
    const key = JSON.stringify(next);
    if (key === this.usageLimitsKey) return false;
    this.usageLimits = next;
    this.usageLimitsKey = key;
    return true;
  }

  private startUsageLimits(): void {
    this.refreshUsageLimits();
    this.usageLimitsTimer = setInterval(() => {
      if (this.refreshUsageLimits()) this.broadcastToDashboards({ type: 'usage_limits', limits: this.usageLimits });
    }, this.usageLimitsIntervalMs);
  }
```

5) `start()`의 `this.startHeartbeat();` 아래에 `this.startUsageLimits();`

6) `stop()`의 `if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);` 아래에 `if (this.usageLimitsTimer) clearInterval(this.usageLimitsTimer);`

7) `handleDashboardConnection`의 `questions_pending` 전송(`ws.send(JSON.stringify(questionsMsg));`) 아래에:

```ts
    if (this.refreshUsageLimits()) this.broadcastToDashboards({ type: 'usage_limits', limits: this.usageLimits });
    else ws.send(JSON.stringify({ type: 'usage_limits', limits: this.usageLimits } satisfies ChannelMessage));
```

(새 대시보드는 이미 `dashboardSockets`에 들어 있어 방송으로도 한 번 받는다. 두 갈래라 중복 전송은 없다)

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/hub-usage-limits.test.ts`
Expected: PASS (2개)

- [ ] **Step 5: 전체 시험**

Run: `npm test`
Expected: 모두 통과. Hub 시험들은 실제 `readUsageLimits`를 쓰지만 HOME이 격리돼 있어 `{claude: null, codex: null}`이다 — 기존 시험이 대시보드 메시지 개수를 세다 깨지면, 그 시험이 무엇을 세는지 보고 `usage_limits`를 빼고 세도록 고친다(어느 시험을 어떻게 고쳤는지 보고)

- [ ] **Step 6: 커밋**

```bash
git add src/hub/usage-limits.ts src/hub/server.ts test/hub-usage-limits.test.ts
git commit -m "feat(hub): tell dashboards the Claude and Codex usage limits when they change"
```

---

### Task 6: 대시보드 상단 한도 줄

**Files:**
- Modify: `src/dashboard/index.html` (CSS, `<header>` 마크업, `state`, `handleMessage`, 렌더 함수, 1분 타이머)
- Test: `test/dashboard-usage-limits.test.ts`

**Interfaces:**
- Consumes: 대시보드 메시지 `{ type: 'usage_limits', limits: UsageLimits }`(Task 5)
- Produces: 대시보드 함수 `formatAge(ms)`, `usageWindowHtml(label, w, now)`, `usageAgentHtml(name, limits, now)`, `renderUsageLimits(now)` — 시험이 `function formatAge(ms) {`부터 `function formatTokens(n) {` 앞까지 잘라 쓴다

- [ ] **Step 1: 실패하는 시험 작성**

`test/dashboard-usage-limits.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(usageLimits: unknown) {
  const start = html.indexOf('  function formatAge(ms) {');
  const end = html.indexOf('  function formatTokens(n) {');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const strip = { innerHTML: '', hidden: false };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#usageStrip' ? strip : null),
    state: { usageLimits },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, strip };
}

const NOW = Date.parse('2026-10-14T05:00:00Z');

test('formatAge says how old the reading is', () => {
  const { ctx } = load(null);
  assert.equal(ctx.formatAge(30_000), 'just now');
  assert.equal(ctx.formatAge(5 * 60_000), '5 min ago');
  assert.equal(ctx.formatAge(3 * 3_600_000), '3 h ago');
  assert.equal(ctx.formatAge(-1), 'just now');
});

test('the strip shows both agents with rounded percentages', () => {
  const { ctx, strip } = load({
    claude: { fiveHour: { usedPercent: 42.4, resetsAt: NOW + 3_600_000 }, sevenDay: { usedPercent: 17.6, resetsAt: NOW + 86_400_000 }, updatedAt: NOW - 120_000 },
    codex: { fiveHour: { usedPercent: 99, resetsAt: NOW + 60_000 }, sevenDay: { usedPercent: 35, resetsAt: null }, updatedAt: NOW },
  });
  ctx.renderUsageLimits(NOW);
  assert.equal(strip.hidden, false);
  const text = strip.innerHTML.replace(/<[^>]+>/g, '');
  assert.equal(text, 'Claude 5h 42% · 7d 18%│Codex 5h 99% · 7d 35%');
  assert.match(strip.innerHTML, /title="Claude usage as of 2 min ago"/);
  assert.match(strip.innerHTML, /class="usage-window usage-high"[^>]*>5h 99%/);
});

test('a window past its reset time says reset', () => {
  const { ctx, strip } = load({ claude: { fiveHour: { usedPercent: 100, resetsAt: NOW - 1 }, updatedAt: NOW - 1_000 }, codex: null });
  ctx.renderUsageLimits(NOW);
  assert.equal(strip.innerHTML.replace(/<[^>]+>/g, ''), 'Claude 5h reset');
});

test('the strip hides an agent without data, and itself when both are empty', () => {
  const one = load({ claude: null, codex: { sevenDay: { usedPercent: 5, resetsAt: null }, updatedAt: NOW } });
  one.ctx.renderUsageLimits(NOW);
  assert.equal(one.strip.innerHTML.replace(/<[^>]+>/g, ''), 'Codex 7d 5%');

  for (const limits of [null, { claude: null, codex: null }, { claude: { updatedAt: NOW }, codex: null }]) {
    const none = load(limits);
    none.ctx.renderUsageLimits(NOW);
    assert.equal(none.strip.innerHTML, '');
    assert.equal(none.strip.hidden, true);
  }
});

test('the header keeps the strip on one line', () => {
  assert.match(html, /\.usage-strip \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  assert.match(html, /<h1>Claude Alarm<\/h1>\s*<div class="usage-strip" id="usageStrip" hidden><\/div>/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-usage-limits.test.ts`
Expected: FAIL — `anchors not found`

- [ ] **Step 3: 구현**

`src/dashboard/index.html`:

1) CSS — `.header-right { ... }` 블록 바로 위에:

```css
  .usage-strip {
    flex: 1;
    min-width: 0;
    margin: 0 16px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: right;
    font-size: 12px;
    color: var(--text-dim);
  }
  .usage-sep { margin: 0 8px; opacity: 0.5; }
  .usage-window.usage-mid { color: var(--yellow); }
  .usage-window.usage-high { color: var(--red); }
```

2) 마크업 — `<h1>Claude Alarm</h1>` 바로 아래:

```html
  <div class="usage-strip" id="usageStrip" hidden></div>
```

3) `state`에 `composing: false,` 아래 `usageLimits: null,` 추가

4) `handleMessage`의 `case 'codex_adapters': { ... }` 블록 뒤에:

```js
      case 'usage_limits':
        state.usageLimits = msg.limits || null;
        renderUsageLimits();
        break;
```

5) `// --- Render ---` 아래, `function formatTokens(n) {` 바로 앞에:

```js
  function formatAge(ms) {
    if (!(ms >= 60_000)) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
    return `${Math.floor(ms / 3_600_000)} h ago`;
  }

  function usageWindowHtml(label, w, now) {
    if (!w || typeof w.usedPercent !== 'number') return '';
    if (typeof w.resetsAt === 'number' && w.resetsAt <= now) return `<span class="usage-window">${label} reset</span>`;
    const pct = Math.round(w.usedPercent);
    const level = pct >= 90 ? ' usage-high' : pct >= 70 ? ' usage-mid' : '';
    const title = typeof w.resetsAt === 'number' ? ` title="${esc(`Resets ${new Date(w.resetsAt).toLocaleString()}`)}"` : '';
    return `<span class="usage-window${level}"${title}>${label} ${pct}%</span>`;
  }

  function usageAgentHtml(name, limits, now) {
    if (!limits) return '';
    const parts = [usageWindowHtml('5h', limits.fiveHour, now), usageWindowHtml('7d', limits.sevenDay, now)].filter(Boolean);
    if (!parts.length) return '';
    const age = typeof limits.updatedAt === 'number' ? formatAge(now - limits.updatedAt) : 'unknown';
    return `<span class="usage-agent" title="${esc(`${name} usage as of ${age}`)}">${esc(name)} ${parts.join(' · ')}</span>`;
  }

  function renderUsageLimits(now = Date.now()) {
    const el = $('#usageStrip');
    const limits = state.usageLimits || {};
    const html = [usageAgentHtml('Claude', limits.claude, now), usageAgentHtml('Codex', limits.codex, now)]
      .filter(Boolean)
      .join('<span class="usage-sep">│</span>');
    el.innerHTML = html;
    el.hidden = !html;
  }

```

6) 1분마다 다시 그리기(나이·초기화 표시 갱신) — 스크립트 끝의 `checkAuth().then((ok) => (ok ? connect() : showTokenForm()));` 줄 바로 위에:

```js
  setInterval(() => renderUsageLimits(), 60_000);
```

- [ ] **Step 4: 통과 확인**

Run: `node --import tsx --import ./test/isolate-home.ts --test test/dashboard-usage-limits.test.ts`
Expected: PASS (5개). 이어서 `npm test` 전체 통과(다른 대시보드 시험의 잘라 쓰기 위치가 새 함수 때문에 깨지지 않는지 — `formatTokens` 앞에 넣었으므로 `dashboard-context-tokens`의 `formatTokens`~`bindSessionCards` 구간에는 영향 없음)

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard/index.html test/dashboard-usage-limits.test.ts
git commit -m "feat(dashboard): show Claude and Codex 5-hour and weekly usage in the header"
```

---

### Task 7: README와 실제 확인

**Files:**
- Modify: `README.md` (`## CLI Commands` 표/목록, `## Dashboard` 아래 짧은 절)

**Interfaces:**
- Consumes: Task 1~6 전부

- [ ] **Step 1: README**

`## CLI Commands`에 기존 형식대로 두 줄 추가:

```
claude-alarm statusline install [--replace]   # Report Claude 5-hour and weekly usage to the dashboard
claude-alarm statusline uninstall             # Remove it (puts back a replaced status line)
```

`## Dashboard` 절 끝에:

```markdown
### Usage limits

The header shows how much of the 5-hour and weekly limits Claude and Codex have used.

- **Claude**: run `claude-alarm statusline install` once (needs a global install). Claude Code passes its limits to the status line, which saves them for the hub; the status line itself shows `5h 42% · 7d 18%`. Values refresh when a session on this PC gets a response, and appear only for subscription accounts. An existing status line is left alone unless you pass `--replace`.
- **Codex**: read from the newest session files in `~/.codex/sessions` (or `CODEX_HOME`); nothing to install.
- Values come from files on the PC running the hub. Hover a value for its reset time and how old it is.
```

- [ ] **Step 2: 빌드·전체 시험·타입 검사**

Run: `npm run build && npm test && npx tsc --noEmit`
Expected: 모두 통과

- [ ] **Step 3: 실제 확인 (격리 Hub)**

사용자 실제 statusLine 설치 전에 격리된 Hub로 화면만 확인한다. Git Bash:

```bash
REAL_CODEX="$HOME/.codex"
T=$(mktemp -d); mkdir -p $T/.claude-alarm
echo '{"hub":{"host":"127.0.0.1","port":7987}}' > $T/.claude-alarm/config.json
cat > $T/.claude-alarm/limits-claude.json <<'EOF'
{"fiveHour":{"usedPercent":42,"resetsAt":null},"sevenDay":{"usedPercent":18,"resetsAt":null},"updatedAt":0}
EOF
HOME=$T USERPROFILE=$T CODEX_HOME="$REAL_CODEX" node dist/cli.js hub start   # run_in_background
```

포트 7987(실제 Hub 7900과 겹치지 않게). `CODEX_HOME`은 실제 `~/.codex`(읽기만). 브라우저로 격리 Hub 대시보드를 열어(`claude-in-chrome`, 토큰은 `$T/.claude-alarm/config.json`) 상단에 `Claude 5h 42% · 7d 18% │ Codex 5h …% · 7d …%`가 보이는지, 좁은 창(375px)에서 헤더가 한 줄인지 스크린숏으로 확인한다. 끝나면 띄운 Hub PID만 종료

- [ ] **Step 4: 사용자 확인 후 실제 설치**

사용자에게 "실제 `~/.claude/settings.json`에 statusLine을 넣을지" 묻는다(`ask`). 승인되면 이 브랜치를 전역 설치하지 말고, 병합·배포 뒤 전역 설치본으로 `claude-alarm statusline install` → 새 Claude Code 세션 하나에서 응답을 받은 뒤 `~/.claude-alarm/limits-claude.json`이 생기고 값이 `/usage` 화면과 맞는지 확인. Hub 재시작 필요(배포 뒤)

- [ ] **Step 5: 커밋**

```bash
git add README.md
git commit -m "docs: usage limits in the dashboard header and the statusline command"
```
