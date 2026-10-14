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
