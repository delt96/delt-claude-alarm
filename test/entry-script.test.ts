import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEntryScript } from '../src/shared/entry.js';

const HUB = ['/hub/server.js', '/hub/server.ts'];

test('matches the hub script whether the path uses backslashes or slashes', () => {
  assert.equal(isEntryScript('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\hub\\server.js', HUB), true);
  assert.equal(isEntryScript('C:/repo/dist/hub/server.js', HUB), true);
  assert.equal(isEntryScript('/usr/lib/node_modules/@delt/claude-alarm/dist/hub/server.js', HUB), true);
  assert.equal(isEntryScript('C:\\repo\\src\\hub\\server.ts', HUB), true);
});

test('does not match the CLI or library bundles that include the hub module', () => {
  assert.equal(isEntryScript('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@delt\\claude-alarm\\dist\\cli.js', HUB), false);
  assert.equal(isEntryScript('/repo/dist/index.js', HUB), false);
  assert.equal(isEntryScript('C:\\repo\\test\\hub-auth.test.ts', HUB), false);
});

test('needs the whole directory name before the script', () => {
  assert.equal(isEntryScript('C:\\x\\myhub\\server.js', HUB), false);
  assert.equal(isEntryScript('/x/myhub/server.js', HUB), false);
});

test('no script path is never the entry', () => {
  assert.equal(isEntryScript(undefined, HUB), false);
  assert.equal(isEntryScript('', HUB), false);
});
