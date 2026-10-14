// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HubServer } from '../src/hub/server.js';
import { Notifier } from '../src/hub/notifier.js';
import { loadConfig, saveConfig } from '../src/shared/config.js';

const PORT = 7987;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 't';
const FULL = '8662133800:AAH-real-token-value';
const MASKED = `${FULL.slice(0, 8)}...`;
const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

async function withHub(fn: () => Promise<void>): Promise<void> {
  const hub = new HubServer({ hub: { host: '127.0.0.1', port: PORT, token: TOKEN } } as any);
  await hub.start();
  try { await fn(); } finally { await hub.stop(); }
}

const save = (telegram: object) =>
  fetch(`${BASE}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ telegram }),
  });

test('saving with the masked token keeps the stored token and turns Telegram off', async () => {
  await withHub(async () => {
    saveConfig({ ...loadConfig(), telegram: { botToken: FULL, chatId: '1', enabled: true } });
    const r = await save({ botToken: MASKED, chatId: '1', enabled: false });
    assert.equal(r.status, 200);
    assert.deepEqual(loadConfig().telegram, { botToken: FULL, chatId: '1', enabled: false });
  });
});

test('a masked token with no stored token is rejected', async () => {
  await withHub(async () => {
    const config = loadConfig();
    delete config.telegram;
    saveConfig(config);
    const r = await save({ botToken: MASKED, chatId: '1', enabled: true });
    assert.equal(r.status, 400);
    assert.equal(loadConfig().telegram, undefined);
  });
});

test('the dashboard sends the masked token to the hub instead of refusing to save', () => {
  const start = html.indexOf("$('#tgSave').addEventListener");
  const end = html.indexOf('// Refresh relative times', start);
  assert.ok(start > 0 && end > start, 'tgSave anchors not found');
  assert.doesNotMatch(html.slice(start, end), /Bot Token is masked/);
});

test('configuring the notifier with no Telegram bot stops Telegram notifications', async () => {
  const sent: string[] = [];
  const bot = { sendNotification: async (_s: string, _l: string, title: string) => { sent.push(title); } } as any;
  const n = new Notifier();
  n.configure({ desktop: false, telegramBot: bot });
  await n.notifyWithSession('s1', 'label', 'before', 'm');
  n.configure({ telegramBot: undefined });
  await n.notifyWithSession('s1', 'label', 'after', 'm');
  assert.deepEqual(sent, ['before']);
});
