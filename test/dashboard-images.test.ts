import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate updateImageUI in a sandbox.
function attachDisabledFor(session: Record<string, unknown>): boolean {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  function updateImageUI() {');
  const end = html.indexOf('  function renderMessages() {');
  assert.ok(start > 0 && end > start, 'updateImageUI anchors not found');
  const attach = { disabled: true };
  const ctx: Record<string, any> = { state: { selectedSession: 's1', sessions: { s1: session } }, $: () => attach };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  ctx.updateImageUI();
  return attach.disabled;
}

test('local Codex sessions can attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: true, agentKind: 'codex' }), false);
});

test('local Claude sessions can attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: true }), false);
});

test('remote sessions cannot attach images', () => {
  assert.equal(attachDisabledFor({ id: 's1', isLocal: false, agentKind: 'codex' }), true);
});
