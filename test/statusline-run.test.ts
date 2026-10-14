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
