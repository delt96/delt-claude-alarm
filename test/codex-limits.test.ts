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
