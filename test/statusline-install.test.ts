import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installStatusLine, uninstallStatusLine, statusLineCommand, isOurStatusLine } from '../src/statusline/install.js';

const SCRIPT = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js';
const OURS = 'node "C:/Users/u/AppData/Roaming/npm/node_modules/@delt/claude-alarm/dist/statusline.js"';

function setup(settings?: unknown | string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-install-'));
  const settingsFile = path.join(dir, 'claude', 'settings.json');
  const originalFile = path.join(dir, 'alarm', 'statusline-original.json');
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  return { settingsFile, originalFile, read };
}

test('statusLineCommand uses forward slashes and quotes the path', () => {
  assert.equal(statusLineCommand(SCRIPT), OURS);
  assert.equal(isOurStatusLine({ type: 'command', command: OURS }), true);
  assert.equal(isOurStatusLine({ type: 'command', command: 'node "C:/workspace/claude-alarm/dist/statusline.js"' }), true);
  assert.equal(isOurStatusLine({ type: 'command', command: 'bash ~/.claude/statusline.sh' }), false);
});

test('install adds the statusLine and keeps other settings', () => {
  const s = setup({ model: 'opus', hooks: { Stop: [] } });
  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT }), { ok: true, action: 'installed' });
  assert.deepEqual(s.read(), { model: 'opus', hooks: { Stop: [] }, statusLine: { type: 'command', command: OURS } });
});

test('install creates settings.json when it does not exist', () => {
  const s = setup();
  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT }), { ok: true, action: 'installed' });
  assert.deepEqual(s.read(), { statusLine: { type: 'command', command: OURS } });
});

test('install refuses to replace another statusLine unless asked, and uninstall restores it', () => {
  const theirs = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 1 };
  const s = setup({ statusLine: theirs });
  const refused = installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, 'occupied');
  assert.deepEqual(s.read().statusLine, theirs);
  assert.equal(fs.existsSync(s.originalFile), false);

  assert.deepEqual(installStatusLine({ ...s, scriptPath: SCRIPT, replace: true }), { ok: true, action: 'replaced' });
  assert.deepEqual(s.read().statusLine, { type: 'command', command: OURS });

  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'restored' });
  assert.deepEqual(s.read().statusLine, theirs);
  assert.equal(fs.existsSync(s.originalFile), false);
});

test('reinstalling ours updates the path and keeps the saved original', () => {
  const theirs = { type: 'command', command: 'x' };
  const s = setup({ statusLine: theirs });
  installStatusLine({ ...s, scriptPath: SCRIPT, replace: true });
  const moved = 'D:\\npm\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js';
  assert.deepEqual(installStatusLine({ ...s, scriptPath: moved }), { ok: true, action: 'updated' });
  assert.equal(s.read().statusLine.command, 'node "D:/npm/node_modules/@delt/claude-alarm/dist/statusline.js"');
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'restored' });
  assert.deepEqual(s.read().statusLine, theirs);
});

test('uninstall removes ours when there was nothing before, and leaves others alone', () => {
  const s = setup({ model: 'opus' });
  installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'removed' });
  assert.deepEqual(s.read(), { model: 'opus' });
  assert.deepEqual(uninstallStatusLine(s), { ok: true, action: 'absent' });

  const other = setup({ statusLine: { type: 'command', command: 'x' } });
  const result = uninstallStatusLine(other);
  assert.equal(!result.ok && result.reason, 'not-ours');
  assert.deepEqual(other.read().statusLine, { type: 'command', command: 'x' });
});

test('a checkout in a folder not named claude-alarm still recognizes its own status line', () => {
  const s = setup({});
  const script = 'C:\\work\\wt\\feat-x\\dist\\statusline.js';
  installStatusLine({ ...s, scriptPath: script });
  assert.deepEqual(installStatusLine({ ...s, scriptPath: script }), { ok: true, action: 'updated' });
  assert.deepEqual(uninstallStatusLine({ ...s, scriptPath: script }), { ok: true, action: 'removed' });
  assert.deepEqual(s.read(), {});
});

test('a broken settings.json is never written', () => {
  const s = setup('{ "model": "opus", }');
  const result = installStatusLine({ ...s, scriptPath: SCRIPT });
  assert.equal(!result.ok && result.reason, 'bad-settings');
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), '{ "model": "opus", }');
  const un = uninstallStatusLine(s);
  assert.equal(!un.ok && un.reason, 'bad-settings');
  assert.equal(fs.existsSync(s.originalFile), false);
});

test('install refuses an npx cache path', () => {
  const s = setup({});
  const result = installStatusLine({ ...s, scriptPath: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\@delt\\claude-alarm\\dist\\statusline.js' });
  assert.equal(!result.ok && result.reason, 'npx');
  assert.deepEqual(s.read(), {});
});
