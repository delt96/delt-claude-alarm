import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(sessions: Record<string, any>, selected = 's1') {
  const start = html.indexOf('  function controlButtonsHtml(');
  const end = html.indexOf('  // --- Add session popup ---');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const controls = { innerHTML: '' };
  const sent: any[] = [];
  const timers: Array<() => void> = [];
  const notDelivered: any[] = [];
  let now = 10_000;
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#sessionControls' ? controls : null),
    state: { sessions, selectedSession: selected, controlPending: {}, clearArmed: null, notifications: [], ws: { readyState: 1, send: (t: string) => sent.push(JSON.parse(t)) } },
    Date: { now: () => now },
    Math,
    JSON,
    setTimeout: (fn: () => void) => { timers.push(fn); return 0; },
    renderNotifications: () => {},
    showNotDelivered: (...args: any[]) => notDelivered.push(args),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, controls, sent, timers, notDelivered, advance: (ms: number) => { now += ms; } };
}

const session = (control?: object) => ({ id: 's1', name: 'app', status: 'idle', ...(control ? { control } : {}) });

test('no control state shows no buttons', () => {
  const { ctx } = load({ s1: session() });
  assert.equal(ctx.controlButtonsHtml(session(), undefined, false), '');
});

test('buttons are disabled while busy, marked when advised, and say Clear? when armed', () => {
  const { ctx } = load({});
  const busy = ctx.controlButtonsHtml(session({ busy: true }), undefined, false);
  assert.equal((busy.match(/ disabled/g) || []).length, 2);
  assert.match(busy, /title="The session is responding"/);
  const advised = ctx.controlButtonsHtml(session({ busy: false, advice: 'compact' }), undefined, false);
  assert.match(advised, /class="control-btn advised" type="button" data-kind="compact"/);
  assert.doesNotMatch(advised, /disabled/);
  assert.match(ctx.controlButtonsHtml(session({ busy: false }), undefined, true), /class="control-btn armed"[^>]*>Clear\?</);
  const running = ctx.controlButtonsHtml(session({ busy: false }), { requestId: 'r', kind: 'compact' }, false);
  assert.match(running, />Running…</);
  assert.equal((running.match(/ disabled/g) || []).length, 2);
});

test('compact sends one command and blocks a second press until the result', () => {
  const t = load({ s1: session({ busy: false }) });
  t.ctx.pressControl('compact');
  t.ctx.pressControl('compact');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].type, 'session_command');
  assert.equal(t.sent[0].kind, 'compact');
  assert.match(t.sent[0].requestId, /^[a-z0-9]+$/);
  t.ctx.showCommandResult({ sessionId: 's1', requestId: 'other', ok: true });
  assert.ok(t.ctx.state.controlPending.s1);
  t.ctx.showCommandResult({ sessionId: 's1', requestId: t.sent[0].requestId, ok: true });
  assert.equal(t.ctx.state.controlPending.s1, undefined);
  assert.equal(t.ctx.state.notifications[0].level, 'success');
});

test('clear needs a second press after the arming pause', () => {
  const t = load({ s1: session({ busy: false }) });
  t.ctx.pressControl('clear');
  assert.equal(t.sent.length, 0);
  assert.match(t.controls.innerHTML, />Clear\?</);
  t.advance(100);
  t.ctx.pressControl('clear');
  assert.equal(t.sent.length, 0);
  t.advance(400);
  t.ctx.pressControl('clear');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].kind, 'clear');
});

test('a busy or unavailable session sends nothing', () => {
  const busy = load({ s1: session({ busy: true }) });
  busy.ctx.pressControl('compact');
  assert.equal(busy.sent.length, 0);
  const none = load({ s1: session() });
  none.ctx.pressControl('compact');
  assert.equal(none.sent.length, 0);
});

test('a failed result and a silent hub both say why', () => {
  const t = load({ s1: session({ busy: false }) });
  t.ctx.pressControl('compact');
  t.ctx.showCommandResult({ sessionId: 's1', requestId: t.sent[0].requestId, ok: false, reason: 'the session is busy' });
  assert.deepEqual(t.notDelivered[0], ['s1', '/compact not run', 'the session is busy']);
  t.ctx.pressControl('compact');
  t.timers[t.timers.length - 1]();
  assert.deepEqual(t.notDelivered[1], ['s1', '/compact not run', 'no answer from the hub']);
});
