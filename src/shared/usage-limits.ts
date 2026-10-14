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
