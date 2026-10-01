import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate the permission relay block in a sandbox.
function loadPermissionHelpers() {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  // --- Permission relay ---');
  const end = html.indexOf('  // Flash title for attention');
  assert.ok(start > 0 && end > start, 'permission block anchors not found');
  const ctx: Record<string, unknown> = {
    state: { permissionRequests: {}, selectedSession: null },
    document: { addEventListener() {} },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    renderMarkdown: (s: string) => s,
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx as any;
}

const choiceReq = {
  requestId: 'r1',
  toolName: 'Command',
  description: 'Allow?',
  inputPreview: '{"command":"ls"}',
  resolved: false,
  choices: [{ id: '0', label: 'Allow once' }, { id: '1', label: 'Cancel task' }],
  sent: null,
};
const claudeReq = { requestId: 'r2', toolName: 'Bash', description: '', inputPreview: '{"command":"ls"}', resolved: false, choices: null };

test('Codex requests get one button per choice and no Enter/Esc hint', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions(choiceReq, 'codex:t1');
  assert.equal((html.match(/class="perm-choice"/g) || []).length, 2);
  assert.match(html, /data-choice-id="1"/);
  assert.doesNotMatch(html, /Enter|Esc/);
});

test('a sent choice shows what was sent instead of buttons', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions({ ...choiceReq, sent: '1' }, 'codex:t1');
  assert.doesNotMatch(html, /perm-choice/);
  assert.match(html, /Sent: Cancel task/);
});

test('Claude requests keep Allow and Deny', () => {
  const h = loadPermissionHelpers();
  const html = h.permissionActions(claudeReq, 'claude-1');
  assert.match(html, /class="perm-allow"/);
  assert.match(html, /class="perm-deny"/);
});

test('Enter and Esc only answer Claude requests', () => {
  const h = loadPermissionHelpers();
  assert.equal(h.shortcutRequest([choiceReq]), undefined);
  assert.equal(h.shortcutRequest([choiceReq, claudeReq]).requestId, 'r2');
  assert.equal(h.shortcutRequest([{ ...claudeReq, resolved: true }]), undefined);
});

test('Codex commands preview like shell commands', () => {
  const h = loadPermissionHelpers();
  assert.equal(h.formatPermPreview('Command', '{"command":"New-Item x"}').text, '$ New-Item x');
});

test('applyPendingChoices expires unlisted choice requests and re-arms listed ones', () => {
  const h = loadPermissionHelpers();
  const listed = { ...choiceReq, requestId: 'a', sent: '0' };
  const unlisted = { ...choiceReq, requestId: 'b', sent: '1' };
  const done = { ...choiceReq, requestId: 'c', resolved: true, outcome: 'resolved' };
  const claude = { ...claudeReq };
  const reqs = { 'codex:t1': [listed, unlisted, done], 'claude-1': [claude] };
  h.applyPendingChoices(reqs, [{ sessionId: 'codex:t1', requestId: 'a' }]);
  assert.equal(listed.sent, null);
  assert.equal(listed.resolved, false);
  assert.equal(unlisted.resolved, true);
  assert.equal(unlisted.outcome, 'expired');
  assert.equal(done.outcome, 'resolved');
  assert.equal(claude.resolved, false);
  assert.equal((claude as any).outcome, undefined);
});
