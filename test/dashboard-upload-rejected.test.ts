import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// The dashboard is a single inline-script HTML file; evaluate showUploadRejected in a sandbox.
function load(selectedSession: string) {
  const start = html.indexOf('  function showUploadRejected(msg) {');
  const end = html.indexOf('  let mentionState = ');
  assert.ok(start > 0 && end > start, 'showUploadRejected anchors not found');
  const errors: string[] = [];
  let renders = 0;
  const ctx: Record<string, any> = {
    state: { selectedSession, notifications: [] },
    showMentionError: (m: string) => errors.push(m),
    renderNotifications: () => { renders++; },
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, errors, renders: () => renders };
}

test('the dashboard handles upload_rejected messages', () => {
  assert.match(html, /case 'upload_rejected':\s*showUploadRejected\(msg\);\s*break;/);
});

test('a rejection for the open session shows under the input and in the notifications', () => {
  const { ctx, errors, renders } = load('s1');
  ctx.showUploadRejected({ type: 'upload_rejected', sessionId: 's1', reason: 'the image is larger than 10 MB' });
  assert.deepEqual(errors, ['Image not delivered: the image is larger than 10 MB']);
  const [n] = ctx.state.notifications;
  assert.equal(n.sessionId, 's1');
  assert.equal(n.title, 'Image not delivered');
  assert.equal(n.message, 'the image is larger than 10 MB');
  assert.equal(n.level, 'warning');
  assert.equal(typeof n.time, 'number');
  assert.equal(renders(), 1);
});

test('a rejection for another session only goes to the notifications', () => {
  const { ctx, errors } = load('s2');
  ctx.showUploadRejected({ type: 'upload_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, []);
  assert.equal(ctx.state.notifications.length, 1);
});
