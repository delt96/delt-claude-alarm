import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, readSessionRecords } from './peer-name.js';

// Reads Claude Code's undocumented transcript, <configDir>/projects/<cwd>/<sessionId>.jsonl
// (verified on 2.1.296). A format change must degrade to null, never throw.

const TAIL_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

type Entry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function contextSize(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return 0;
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    const { model, usage } = entry.message;
    if (model === '<synthetic>' || !isRecord(usage)) continue;
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return count('input_tokens') + count('cache_read_input_tokens') + count('cache_creation_input_tokens');
  }
  return null;
}

export function findSession(
  records: unknown[],
  env: { messagingSocket?: string; sessionId?: string },
): { sessionId: string; cwd?: string } | undefined {
  const valid = records.filter((r): r is Record<string, unknown> => isRecord(r) && typeof r.sessionId === 'string');
  const rec =
    (env.messagingSocket ? valid.find((r) => r.messagingSocketPath === env.messagingSocket) : undefined) ??
    (env.sessionId ? valid.find((r) => r.sessionId === env.sessionId) : undefined);
  if (!rec) return undefined;
  return { sessionId: rec.sessionId as string, cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined };
}

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | undefined {
  const projects = path.join(configDir, 'projects');
  const file = `${sessionId}.jsonl`;
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const candidate = path.join(projects, dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return undefined;
}

function readTail(file: string): Entry[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    const entries: Entry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) entries.push(value);
      } catch {}
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

export function readContextTokens(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): number | null {
  try {
    const configDir = claudeConfigDir(env);
    const lookup = { messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET, sessionId: env.CLAUDE_CODE_SESSION_ID };
    const found = findSession(readSessionRecords(configDir), lookup);
    const sessionId = found?.sessionId ?? lookup.sessionId;
    if (!sessionId || !SAFE_ID.test(sessionId)) return null;
    const file = transcriptPath(configDir, found?.cwd ?? cwd, sessionId);
    return file ? contextSize(readTail(file)) : null;
  } catch {
    return null;
  }
}
