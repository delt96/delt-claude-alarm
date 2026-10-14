import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextTokenReporter } from '../src/channel/context-reporter.js';

function fakeHub(features: string[]) {
  const sent: any[] = [];
  return { sent, hub: { supports: (f: string) => features.includes(f), send: (m: any) => { sent.push(m); return 'sent'; } } };
}

test('sends only when the value changes', () => {
  const { sent, hub } = fakeHub(['context_tokens']);
  let value: number | null = 100;
  const r = new ContextTokenReporter(hub, 's1', () => value);
  r.refresh();
  r.refresh();
  value = 250;
  r.refresh();
  value = null;
  r.refresh();
  assert.deepEqual(sent, [
    { type: 'context_tokens', sessionId: 's1', tokens: 100 },
    { type: 'context_tokens', sessionId: 's1', tokens: 250 },
    { type: 'context_tokens', sessionId: 's1', tokens: null },
  ]);
});

test('sends nothing to a hub without the feature and does not read the transcript', () => {
  const { sent, hub } = fakeHub(['questions']);
  let reads = 0;
  new ContextTokenReporter(hub, 's1', () => { reads++; return 5; }).refresh();
  assert.equal(sent.length, 0);
  assert.equal(reads, 0);
});

test('reset sends the same value again after a hub reconnect', () => {
  const { sent, hub } = fakeHub(['context_tokens']);
  const r = new ContextTokenReporter(hub, 's1', () => 42);
  r.refresh();
  r.reset();
  r.refresh();
  assert.equal(sent.length, 2);
});
