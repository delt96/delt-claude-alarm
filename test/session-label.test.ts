import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionLabel } from '../src/shared/session-label.js';

const base = { id: 'x', name: 'n', status: 'idle' as const, connectedAt: 0, lastActivity: 0 };

test('claude sessions keep the plain label', () => {
  assert.equal(sessionLabel({ ...base, displayName: 'proj', cwd: '/w/proj' }), 'proj');
});

test('codex sessions are prefixed', () => {
  assert.equal(sessionLabel({ ...base, agentKind: 'codex', displayName: 'Fix bug' }), 'Codex · Fix bug');
});

test('falls back to the cwd folder, then the name', () => {
  assert.equal(sessionLabel({ ...base, cwd: 'C:\\w\\api' }), 'api');
  assert.equal(sessionLabel(base), 'n');
});
