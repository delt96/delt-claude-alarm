// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONFIG_FILE } from '../src/shared/constants.js';
import { currentToken, hubTokenSource, loadConfig, readSavedToken, saveConfig, setHubToken } from '../src/shared/config.js';

test('setHubToken saves the given token and keeps the rest of the config', () => {
  const config = loadConfig();
  config.telegram = { botToken: 'bot', chatId: '1', enabled: true };
  saveConfig(config);
  assert.equal(setHubToken('my-own-token-value-123'), 'my-own-token-value-123');
  const after = loadConfig();
  assert.equal(after.hub.token, 'my-own-token-value-123');
  assert.equal(after.telegram?.botToken, 'bot');
});

test('setHubToken without a value makes a new random token', () => {
  const before = setHubToken('previous-token-value-1');
  const made = setHubToken();
  assert.notEqual(made, before);
  assert.ok(made.length >= 16);
  assert.equal(loadConfig().hub.token, made);
});

test('setHubToken refuses short tokens and tokens with spaces, and leaves the old one', () => {
  setHubToken('kept-token-value-0001');
  assert.throws(() => setHubToken('short'), /at least 16/);
  assert.throws(() => setHubToken('has a space in the token'), /spaces/);
  assert.equal(loadConfig().hub.token, 'kept-token-value-0001');
});

test('readSavedToken reads the saved token and never rewrites a broken config', () => {
  setHubToken('saved-token-value-0001');
  assert.equal(readSavedToken(), 'saved-token-value-0001');
  fs.writeFileSync(CONFIG_FILE, '{"hub": {"token": "half-writ');
  assert.equal(readSavedToken(), undefined);
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf-8'), '{"hub": {"token": "half-writ');
  fs.unlinkSync(CONFIG_FILE);
  assert.equal(readSavedToken(), undefined);
  assert.equal(fs.existsSync(CONFIG_FILE), false);
});

test('an env token is used as is; otherwise the saved token is read on every call, falling back to the start token', () => {
  assert.equal(hubTokenSource('from-env', 'start'), 'from-env');
  const source = hubTokenSource(undefined, 'start-token');
  setHubToken('first-saved-token-0001');
  assert.equal(currentToken(source), 'first-saved-token-0001');
  setHubToken('second-saved-token-001');
  assert.equal(currentToken(source), 'second-saved-token-001');
  fs.writeFileSync(CONFIG_FILE, 'not json');
  assert.equal(currentToken(source), 'start-token');
  fs.unlinkSync(CONFIG_FILE);
  assert.equal(currentToken(undefined), undefined);
});
