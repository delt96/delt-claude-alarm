import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// The dashboard's inline-script helpers need a sandbox to test delivery failures.
function load(selectedSession: string) {
  const start = html.indexOf('  function showUploadRejected(msg) {');
  const end = html.indexOf('  let mentionState = ');
  assert.ok(start > 0 && end > start, 'showUploadRejected anchors not found');
  const errors: string[] = [];
  let renders = 0;
  let messageRenders = 0;
  const ctx: Record<string, any> = {
    state: {
      selectedSession,
      notifications: [],
      waitingReply: { s1: true },
      messages: { s1: [{ from: 'dashboard', content: 'hi', time: 1 }] },
    },
    renderMessages: () => { messageRenders++; },
    showMentionError: (m: string) => errors.push(m),
    renderNotifications: () => { renders++; },
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, errors, renders: () => renders, messageRenders: () => messageRenders };
}

test('the dashboard handles message_rejected messages', () => {
  assert.match(html, /case 'message_rejected':\s*showMessageRejected\(msg\);\s*break;/);
});

test('a rejected message for the open session shows under the input and in the notifications', () => {
  const { ctx, errors, renders, messageRenders } = load('s1');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, ['Message not delivered: the session is not connected']);
  const [n] = ctx.state.notifications;
  assert.equal(n.sessionId, 's1');
  assert.equal(n.title, 'Message not delivered');
  assert.equal(n.message, 'the session is not connected');
  assert.equal(n.level, 'warning');
  assert.equal(typeof n.time, 'number');
  assert.equal(renders(), 1);
  assert.equal(ctx.state.waitingReply.s1, false);
  assert.equal(messageRenders(), 1);
});

test('the message already drawn stays in the conversation', () => {
  const { ctx } = load('s1');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(ctx.state.messages.s1.map((m: any) => m.content), ['hi']);
});

test('a rejected message for another session only goes to the notifications', () => {
  const { ctx, errors, messageRenders } = load('s2');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, []);
  assert.equal(messageRenders(), 0);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.waitingReply.s1, false);
});
