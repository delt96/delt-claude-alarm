import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageInput, textInput } from '../src/codex/inputs.js';

function tmpFile(name: string, bytes: Buffer): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inputs-')), name);
  fs.writeFileSync(file, bytes);
  return file;
}

test('text is sent with its source prefix', () => {
  assert.deepEqual(textInput('run the tests', 'telegram'), [{ type: 'text', text: '[claude-alarm · Telegram] run the tests' }]);
});

test('an image becomes a data URL behind its prefixed caption', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  const file = tmpFile('a.png', bytes);
  assert.deepEqual(await imageInput(file, 'image/png', 'what is this?', 'dashboard'), [
    { type: 'text', text: '[claude-alarm · Dashboard] what is this?' },
    { type: 'image', url: `data:image/png;base64,${bytes.toString('base64')}` },
  ]);
});

test('an image without a caption still says where it came from', async () => {
  const file = tmpFile('b.jpg', Buffer.from('jpeg'));
  const [text] = await imageInput(file, 'image/jpeg', '  ', 'telegram');
  assert.deepEqual(text, { type: 'text', text: '[claude-alarm · Telegram] (image)' });
});

test('unsupported image types are refused', async () => {
  const file = tmpFile('c.svg', Buffer.from('<svg/>'));
  await assert.rejects(imageInput(file, 'image/svg+xml', undefined, 'dashboard'), /unsupported image type image\/svg\+xml/);
});

test('a missing image file is refused', async () => {
  await assert.rejects(imageInput(path.join(os.tmpdir(), 'claude-alarm-no-such-image.png'), 'image/png', undefined, 'dashboard'));
});
