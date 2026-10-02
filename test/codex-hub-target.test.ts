import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapterHub } from '../src/codex/hub-target.js';
import type { AppConfig } from '../src/shared/types.js';

// null, not undefined, means "no token": passing undefined would select the default.
function config(host: string, port = 7900, token: string | null = 'cfg-token'): AppConfig {
  return { hub: { host, port, token: token ?? undefined }, notifications: { desktop: false, sound: false }, webhooks: [] };
}

test('config hosts are turned into URL hosts', () => {
  assert.equal(resolveAdapterHub(config('0.0.0.0'), {}).host, '127.0.0.1');
  assert.equal(resolveAdapterHub(config(''), {}).host, '127.0.0.1');
  assert.equal(resolveAdapterHub(config('::'), {}).host, '[::1]');
  assert.equal(resolveAdapterHub(config('fe80::1'), {}).host, '[fe80::1]');
  assert.equal(resolveAdapterHub(config('192.168.0.10'), {}).host, '192.168.0.10');
  assert.equal(resolveAdapterHub(config('hub.local'), {}).host, 'hub.local');
});

test('without environment overrides everything comes from the config', () => {
  assert.deepEqual(resolveAdapterHub(config('192.168.0.10', 7901, 'cfg-token'), {}), {
    host: '192.168.0.10',
    port: 7901,
    token: 'cfg-token',
    fromEnv: { host: false, port: false, token: false },
  });
});

test('environment variables win over the config', () => {
  const env = { CLAUDE_ALARM_HUB_HOST: '::1', CLAUDE_ALARM_HUB_PORT: '7902', CLAUDE_ALARM_HUB_TOKEN: 'env-token' };
  assert.deepEqual(resolveAdapterHub(config('192.168.0.10'), env), {
    host: '[::1]',
    port: 7902,
    token: 'env-token',
    fromEnv: { host: true, port: true, token: true },
  });
});

test('each override is reported on its own', () => {
  const hub = resolveAdapterHub(config('192.168.0.10', 7901), { CLAUDE_ALARM_HUB_PORT: '7903' });
  assert.equal(hub.host, '192.168.0.10');
  assert.equal(hub.port, 7903);
  assert.equal(hub.token, 'cfg-token');
  assert.deepEqual(hub.fromEnv, { host: false, port: true, token: false });
});

test('a config without a token stays without one', () => {
  assert.equal(resolveAdapterHub(config('127.0.0.1', 7900, null), {}).token, undefined);
});

test('every resolved host makes a valid URL', () => {
  for (const host of ['0.0.0.0', '', '::', '::1', 'fe80::1', '192.168.0.10', 'hub.local']) {
    const hub = resolveAdapterHub(config(host), {});
    assert.doesNotThrow(() => new URL(`http://${hub.host}:${hub.port}/api/status`), host);
  }
});
