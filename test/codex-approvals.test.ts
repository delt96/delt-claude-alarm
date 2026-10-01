import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalView, decisionLabel, fileChanges } from '../src/codex/approvals.js';

const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['New-Item', '-Name', 'x'] } };

test('command approvals offer the decisions Codex sent, in order', () => {
  const v = approvalView('item/commandExecution/requestApproval', {
    threadId: 't',
    reason: 'Allow creating x?',
    command: 'New-Item -Name x',
    availableDecisions: ['accept', amendment, 'cancel'],
  })!;
  assert.equal(v.toolName, 'Command');
  assert.equal(v.description, 'Allow creating x?');
  assert.deepEqual(JSON.parse(v.inputPreview), { command: 'New-Item -Name x' });
  assert.deepEqual(v.choices.map((c) => c.label), ['Allow once', 'Always allow this command', 'Cancel task']);
  assert.deepEqual(v.choices.map((c) => c.response), [{ decision: 'accept' }, { decision: amendment }, { decision: 'cancel' }]);
});

test('command approvals without availableDecisions fall back to allow, decline and cancel', () => {
  const v = approvalView('item/commandExecution/requestApproval', {
    threadId: 't',
    commandActions: [{ type: 'unknown', command: 'ls' }],
  })!;
  assert.equal(v.description, 'Codex wants to run a command.');
  assert.deepEqual(JSON.parse(v.inputPreview), { command: 'ls' });
  assert.deepEqual(v.choices.map((c) => c.response), [{ decision: 'accept' }, { decision: 'decline' }, { decision: 'cancel' }]);
});

test('decision labels cover session, network and unknown decisions', () => {
  assert.equal(decisionLabel('acceptForSession'), 'Allow for this session');
  assert.equal(
    decisionLabel({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } }),
    'Network rule: example.com allow',
  );
  assert.equal(decisionLabel('somethingNew'), 'somethingNew');
  assert.equal(decisionLabel({ somethingElse: {} }), 'somethingElse');
});

test('file change approvals show the files from the started item', () => {
  const files = fileChanges({ changes: [{ path: 'C:\\w\\a.txt', diff: 'hi' }, { path: 'C:\\w\\b.txt', diff: '' }] });
  const v = approvalView('item/fileChange/requestApproval', { threadId: 't', itemId: 'p1', reason: null }, files)!;
  assert.equal(v.toolName, 'File change');
  assert.equal(v.description, 'Codex wants to change files.');
  assert.equal(JSON.parse(v.inputPreview).content, 'C:\\w\\a.txt\nhi\n\nC:\\w\\b.txt');
  assert.deepEqual(v.choices.map((c) => c.response), [
    { decision: 'accept' },
    { decision: 'acceptForSession' },
    { decision: 'decline' },
    { decision: 'cancel' },
  ]);
});

test('file change approvals say so when the file list was missed', () => {
  const v = approvalView('item/fileChange/requestApproval', { threadId: 't', itemId: 'p1' })!;
  assert.match(JSON.parse(v.inputPreview).content, /not available/);
});

test('MCP tool-call elicitations become allow, decline and cancel actions', () => {
  const v = approvalView('mcpServer/elicitation/request', {
    threadId: 't',
    serverName: 'claude-alarm',
    mode: 'form',
    message: 'Allow notify?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call' },
  })!;
  assert.equal(v.toolName, 'MCP tool');
  assert.equal(v.description, 'MCP server: claude-alarm');
  assert.deepEqual(JSON.parse(v.inputPreview), { content: 'Allow notify?' });
  assert.deepEqual(v.choices.map((c) => c.label), ['Allow', 'Decline', 'Cancel']);
  assert.deepEqual(v.choices.map((c) => c.response), [{ action: 'accept', content: {} }, { action: 'decline' }, { action: 'cancel' }]);
});

test('other requests are not approvals claude-alarm can answer', () => {
  assert.equal(approvalView('mcpServer/elicitation/request', { threadId: 't', mode: 'form', message: 'Your name?' }), null);
  assert.equal(approvalView('item/tool/requestUserInput', { threadId: 't' }), null);
});

test('oversized reasons and previews are truncated', () => {
  const cmd = approvalView('item/commandExecution/requestApproval', { threadId: 't', reason: 'r'.repeat(2000), command: 'c'.repeat(60_000) })!;
  assert.equal(cmd.description, `${'r'.repeat(500)}…(truncated)`);
  assert.equal(JSON.parse(cmd.inputPreview).command, `${'c'.repeat(50_000)}…(truncated)`);
  const files = fileChanges({ changes: [{ path: 'a', diff: 'd'.repeat(60_000) }] });
  const fc = approvalView('item/fileChange/requestApproval', { threadId: 't', itemId: 'p', reason: 'r'.repeat(2000) }, files)!;
  assert.equal(fc.description, `${'r'.repeat(500)}…(truncated)`);
  assert.equal(JSON.parse(fc.inputPreview).content.length, 50_000 + '…(truncated)'.length);
  assert.ok(JSON.parse(fc.inputPreview).content.endsWith('…(truncated)'));
  const mcp = approvalView('mcpServer/elicitation/request', { serverName: 's'.repeat(2000), message: 'm'.repeat(60_000), _meta: { codex_approval_kind: 'mcp_tool_call' } })!;
  assert.equal(mcp.description, `${('MCP server: ' + 's'.repeat(2000)).slice(0, 500)}…(truncated)`);
  assert.equal(JSON.parse(mcp.inputPreview).content, `${'m'.repeat(50_000)}…(truncated)`);
});
