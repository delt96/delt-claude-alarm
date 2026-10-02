import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubUrlHost } from '../src/shared/hub-url.js';

test('IPv4 addresses and names are used as they are', () => {
  assert.equal(hubUrlHost('127.0.0.1'), '127.0.0.1');
  assert.equal(hubUrlHost('100.64.0.1'), '100.64.0.1');
  assert.equal(hubUrlHost('localhost'), 'localhost');
});

test('listen-on-all addresses are reached through loopback', () => {
  assert.equal(hubUrlHost('0.0.0.0'), '127.0.0.1');
  assert.equal(hubUrlHost(''), '127.0.0.1');
  assert.equal(hubUrlHost('::'), '[::1]');
});

test('IPv6 addresses are bracketed', () => {
  assert.equal(hubUrlHost('::1'), '[::1]');
  assert.equal(hubUrlHost('fd7a:115c:a1e0::1'), '[fd7a:115c:a1e0::1]');
});

test('every result makes a valid URL', () => {
  for (const host of ['127.0.0.1', '0.0.0.0', '', '::', '::1', 'fd7a:115c:a1e0::1', 'localhost']) {
    assert.doesNotThrow(() => new URL(`http://${hubUrlHost(host)}:7900/api/status`), host);
  }
});
