import fs from 'node:fs';
import path from 'node:path';
import { readJsonObject, writeJsonAtomic } from '../shared/json-file.js';
import { MOD_PLUGIN_NAME } from '../shared/control-protocol.js';

export const PLUGIN_DIRS_ENV = 'CLAUDE_CODE_PLUGIN_DIRS';

// Other packages (claude-jev-advisor) keep their own entries in the same variable; only ours may be touched.
// The path pattern covers an npm copy that has since moved away; the manifest covers a checkout under any folder name.
const OURS = /(^|\/)claude-alarm\/mod\/?$/;

function isOurs(dir: string): boolean {
  if (OURS.test(slashes(dir))) return true;
  const manifest = readJsonObject(path.join(dir, '.claude-plugin', 'plugin.json'));
  return manifest.ok && manifest.value?.name === MOD_PLUGIN_NAME;
}

export type ModInstallResult = { ok: true; action: 'installed' | 'updated' } | { ok: false; reason: 'npx' | 'bad-settings' };
export type ModUninstallResult = { ok: true; action: 'removed' | 'absent' } | { ok: false; reason: 'bad-settings' };

interface Files {
  settingsFile: string;
  delimiter: string;
  backupFile?: string;
}

const slashes = (p: string) => p.replace(/\\/g, '/');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const splitDirs = (value: unknown, delimiter: string) => (typeof value === 'string' ? value.split(delimiter).filter(Boolean) : []);

function backup(opts: Files): void {
  if (opts.backupFile && fs.existsSync(opts.settingsFile)) {
    fs.mkdirSync(path.dirname(opts.backupFile), { recursive: true });
    fs.copyFileSync(opts.settingsFile, opts.backupFile);
  }
}

export function installMod(opts: Files & { modDir: string; controlDir: string }): ModInstallResult {
  if (/[\\/]_npx[\\/]/.test(opts.modDir)) return { ok: false, reason: 'npx' };
  const read = readJsonObject(opts.settingsFile);
  if (!read.ok) return { ok: false, reason: 'bad-settings' };
  const settings = read.value ?? {};
  const env = isRecord(settings.env) ? settings.env : {};
  const dirs = splitDirs(env[PLUGIN_DIRS_ENV], opts.delimiter);
  const others = dirs.filter((dir) => !isOurs(dir));
  const configs = isRecord(settings.pluginConfigs) ? settings.pluginConfigs : {};
  backup(opts);
  writeJsonAtomic(opts.settingsFile, {
    ...settings,
    env: { ...env, [PLUGIN_DIRS_ENV]: [...others, slashes(opts.modDir)].join(opts.delimiter) },
    pluginConfigs: { ...configs, [MOD_PLUGIN_NAME]: { options: { controlDir: slashes(opts.controlDir) } } },
  }, 2);
  return { ok: true, action: others.length === dirs.length ? 'installed' : 'updated' };
}

export function uninstallMod(opts: Files): ModUninstallResult {
  const read = readJsonObject(opts.settingsFile);
  if (!read.ok) return { ok: false, reason: 'bad-settings' };
  const settings = read.value ?? {};
  const next: Record<string, unknown> = { ...settings };
  let changed = false;
  if (isRecord(settings.env)) {
    const dirs = splitDirs(settings.env[PLUGIN_DIRS_ENV], opts.delimiter);
    const kept = dirs.filter((dir) => !isOurs(dir));
    if (kept.length !== dirs.length) {
      changed = true;
      const { [PLUGIN_DIRS_ENV]: _ours, ...rest } = settings.env;
      const env = kept.length ? { ...rest, [PLUGIN_DIRS_ENV]: kept.join(opts.delimiter) } : rest;
      if (Object.keys(env).length) next.env = env;
      else delete next.env;
    }
  }
  if (isRecord(settings.pluginConfigs) && MOD_PLUGIN_NAME in settings.pluginConfigs) {
    changed = true;
    const { [MOD_PLUGIN_NAME]: _ours, ...rest } = settings.pluginConfigs;
    if (Object.keys(rest).length) next.pluginConfigs = rest;
    else delete next.pluginConfigs;
  }
  if (!changed) return { ok: true, action: 'absent' };
  backup(opts);
  writeJsonAtomic(opts.settingsFile, next, 2);
  return { ok: true, action: 'removed' };
}
