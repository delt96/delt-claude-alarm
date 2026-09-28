import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from '../src/shared/constants.js';

test('tests never use the real ~/.claude-alarm', () => {
  assert.ok(CONFIG_DIR.startsWith(path.join(os.tmpdir(), 'claude-alarm-test-home-')), CONFIG_DIR);
});
