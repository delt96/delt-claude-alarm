// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig, setCodexEnabled } from '../src/shared/config.js';

test('setCodexEnabled toggles the flag and keeps the command', () => {
  const config = loadConfig();
  config.codex = { enabled: false, command: 'C:/tools/codex.exe' };
  saveConfig(config);
  setCodexEnabled(true);
  assert.deepEqual(loadConfig().codex, { enabled: true, command: 'C:/tools/codex.exe' });
  setCodexEnabled(false);
  assert.deepEqual(loadConfig().codex, { enabled: false, command: 'C:/tools/codex.exe' });
});

test('setCodexEnabled works without an existing codex section', () => {
  const config = loadConfig();
  delete config.codex;
  saveConfig(config);
  setCodexEnabled(true);
  assert.equal(loadConfig().codex?.enabled, true);
});
