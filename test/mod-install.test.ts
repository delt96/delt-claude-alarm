import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installMod, uninstallMod } from '../src/mod/install.js';

const ADVISOR = 'C:/Users/u/AppData/Roaming/npm/node_modules/@delt/claude-jev-advisor/mod';
const MOD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\mod';
const OURS = 'C:/Users/u/AppData/Roaming/npm/node_modules/@delt/claude-alarm/mod';
const CONTROL = 'C:\\Users\\u\\.claude-alarm\\control';

function setup(settings?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-install-'));
  const settingsFile = path.join(dir, 'claude', 'settings.json');
  const backupFile = path.join(dir, 'alarm', 'settings-before-mod.json');
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings));
  }
  return { settingsFile, backupFile, delimiter: ';', read: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
}

test('install adds our folder after the advisor and our options', () => {
  const s = setup({ model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: ADVISOR, FOO: '1' }, pluginConfigs: { 'jev-advisor': { options: { dataDir: 'x' } } } });
  assert.deepEqual(installMod({ ...s, modDir: MOD, controlDir: CONTROL }), { ok: true, action: 'installed' });
  assert.deepEqual(s.read(), {
    model: 'opus',
    env: { CLAUDE_CODE_PLUGIN_DIRS: `${ADVISOR};${OURS}`, FOO: '1' },
    pluginConfigs: { 'jev-advisor': { options: { dataDir: 'x' } }, 'alarm-control': { options: { controlDir: 'C:/Users/u/.claude-alarm/control' } } },
  });
  assert.equal(JSON.parse(fs.readFileSync(s.backupFile, 'utf8')).model, 'opus');
});

test('install creates settings.json, and reinstalling moves our entry without doubling it', () => {
  const s = setup();
  installMod({ ...s, modDir: MOD, controlDir: CONTROL });
  const moved = 'D:\\npm\\node_modules\\@delt\\claude-alarm\\mod';
  assert.deepEqual(installMod({ ...s, modDir: moved, controlDir: CONTROL }), { ok: true, action: 'updated' });
  assert.equal(s.read().env.CLAUDE_CODE_PLUGIN_DIRS, 'D:/npm/node_modules/@delt/claude-alarm/mod');
});

test('uninstall removes only ours and keeps the advisor', () => {
  const s = setup({ env: { CLAUDE_CODE_PLUGIN_DIRS: ADVISOR }, pluginConfigs: { 'jev-advisor': {} } });
  installMod({ ...s, modDir: MOD, controlDir: CONTROL });
  assert.deepEqual(uninstallMod(s), { ok: true, action: 'removed' });
  assert.deepEqual(s.read(), { env: { CLAUDE_CODE_PLUGIN_DIRS: ADVISOR }, pluginConfigs: { 'jev-advisor': {} } });
  assert.deepEqual(uninstallMod(s), { ok: true, action: 'absent' });
});

test('uninstall drops env and pluginConfigs when they end up empty', () => {
  const s = setup({ model: 'opus' });
  installMod({ ...s, modDir: MOD, controlDir: CONTROL });
  uninstallMod(s);
  assert.deepEqual(s.read(), { model: 'opus' });
});

test('bad settings and an npx copy are refused without writing', () => {
  const bad = setup('{ nope');
  assert.deepEqual(installMod({ ...bad, modDir: MOD, controlDir: CONTROL }), { ok: false, reason: 'bad-settings' });
  assert.equal(fs.readFileSync(bad.settingsFile, 'utf8'), '{ nope');
  assert.deepEqual(uninstallMod(bad), { ok: false, reason: 'bad-settings' });
  const npx = setup({});
  assert.deepEqual(installMod({ ...npx, modDir: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\@delt\\claude-alarm\\mod', controlDir: CONTROL }), { ok: false, reason: 'npx' });
});

test('a checkout under another folder name is still recognised as ours, by its manifest', () => {
  const s = setup({ env: { CLAUDE_CODE_PLUGIN_DIRS: ADVISOR } });
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-checkout-'));
  const modDir = path.join(checkout, 'mod');
  fs.mkdirSync(path.join(modDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(modDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alarm-control' }));
  installMod({ ...s, modDir, controlDir: CONTROL });
  assert.deepEqual(installMod({ ...s, modDir, controlDir: CONTROL }), { ok: true, action: 'updated' });
  assert.equal(s.read().env.CLAUDE_CODE_PLUGIN_DIRS, `${ADVISOR};${modDir.split(path.sep).join('/')}`);
  assert.deepEqual(uninstallMod(s), { ok: true, action: 'removed' });
  assert.equal(s.read().env.CLAUDE_CODE_PLUGIN_DIRS, ADVISOR);
});
