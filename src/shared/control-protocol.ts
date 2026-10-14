// Shared by the alarm-control mod and the channel server. The mod runs without Node, so nothing here may import node:*.
export type ControlKind = 'compact' | 'clear';

export interface AliveRecord { busy: boolean; at: number; ended?: true }
export interface CommandRecord { id: string; kind: ControlKind; at: number }
export interface ResultRecord { id: string; ok: boolean; reason?: string; at: number }
export interface AdviceRecord { kind: ControlKind | null; at: number }

export const POLL_MS = 2_000;
export const HEARTBEAT_MS = 15_000;
export const ALIVE_STALE_MS = 45_000;
export const COMMAND_TTL_MS = 30_000;
export const MOD_PLUGIN_NAME = 'alarm-control';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REASON = 500;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export function isControlKind(value: unknown): value is ControlKind {
  return value === 'compact' || value === 'clear';
}

export function controlFile(dir: string, kind: 'alive' | 'command' | 'result', sessionId: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${kind}/${sessionId}.json`;
}

export function parseJsonText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseAlive(raw: unknown): AliveRecord | null {
  if (!isRecord(raw) || typeof raw.busy !== 'boolean' || !isTime(raw.at)) return null;
  return raw.ended === true ? { busy: raw.busy, at: raw.at, ended: true } : { busy: raw.busy, at: raw.at };
}

export function parseCommand(raw: unknown): CommandRecord | null {
  if (!isRecord(raw) || !isSafeId(raw.id) || !isControlKind(raw.kind) || !isTime(raw.at)) return null;
  return { id: raw.id, kind: raw.kind, at: raw.at };
}

export function parseResult(raw: unknown): ResultRecord | null {
  if (!isRecord(raw) || !isSafeId(raw.id) || typeof raw.ok !== 'boolean' || !isTime(raw.at)) return null;
  const base = { id: raw.id, ok: raw.ok };
  return typeof raw.reason === 'string' ? { ...base, reason: raw.reason.slice(0, MAX_REASON), at: raw.at } : { ...base, at: raw.at };
}

export function parseAdvice(raw: unknown): AdviceRecord | null {
  if (!isRecord(raw) || !isTime(raw.at)) return null;
  if (raw.kind !== null && !isControlKind(raw.kind)) return null;
  return { kind: raw.kind, at: raw.at };
}
