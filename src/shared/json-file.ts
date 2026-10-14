import fs from 'node:fs';
import path from 'node:path';

export type JsonObjectRead = { ok: true; value: Record<string, unknown> | undefined } | { ok: false };

export function readJsonObject(file: string): JsonObjectRead {
  if (!fs.existsSync(file)) return { ok: true, value: undefined };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ok: true, value: value as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function writeJsonAtomic(file: string, value: unknown, space?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, space) + (space ? '\n' : ''));
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
