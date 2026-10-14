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

export function isOurStatusLine(value: unknown, scriptPath?: string): boolean {
  if (!isRecord(value) || typeof value.command !== 'string') return false;
  if (scriptPath !== undefined && value.command === statusLineCommand(scriptPath)) return true;
  return OURS.test(value.command.replace(/\\/g, '/'));
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
    if (isOurStatusLine(current, opts.scriptPath)) {
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

export function uninstallStatusLine(opts: Files & { scriptPath?: string }): UninstallResult {
  const read = readJson(opts.settingsFile);
  if (!read.ok) return { ok: false, reason: 'bad-settings' };
  const settings = read.value ?? {};
  const current = settings.statusLine;
  if (current === undefined) return { ok: true, action: 'absent' };
  if (!isOurStatusLine(current, opts.scriptPath)) return { ok: false, reason: 'not-ours', detail: JSON.stringify(current) };
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
