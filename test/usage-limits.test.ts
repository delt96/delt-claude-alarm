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
