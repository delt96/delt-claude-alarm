import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function section(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start > 0 && end > start, `anchors not found: ${from.trim()}`);
  return html.slice(start, end);
}

// The dashboard is a single inline-script HTML file; evaluate the permission relay block in a sandbox.
function loadPermissions() {
  const flashes: string[] = [];
  const ctx: Record<string, any> = {
    state: { permissionRequests: {}, selectedSession: 'other', sessions: {}, notifications: [] },
    document: { addEventListener() {} },
    esc: (s: string) => String(s),
    renderMarkdown: (s: string) => s,
    renderMessages: () => {},
    renderNotifications: () => {},
    selectSession: () => {},
    flashTitle: (m: string) => flashes.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // --- Permission relay ---', '  // Flash title for attention'), ctx);
  ctx.renderPermissionBar = () => {};
  return { ctx, flashes };
}

const choices = [{ id: '0', label: 'Allow once' }];
const pending = (sessionId: string, requestId: string) =>
  ({ sessionId, requestId, toolName: 'Command', description: `Run ${requestId}?`, inputPreview: '{}', timestamp: 1, choices });

test('the dashboard restores pending approvals and shows live ones through the new helpers', () => {
  assert.match(html, /case 'permission_pending':\s*restorePendingRequests\(msg\.requests \|\| \[\]\);\s*break;/);
  assert.match(html, /case 'permission_request':\s*showPermissionRequest\(msg\);\s*break;/);
});

test('restored approvals all join the permission bar with one notification row and one flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([pending('codex:t1', 'r1'), pending('codex:t1', 'r2'), pending('codex:t2', 'r3')]);
  assert.deepEqual(Array.from(ctx.state.permissionRequests['codex:t1'], (r: any) => r.requestId), ['r2', 'r1']);
  assert.deepEqual(Array.from(ctx.state.permissionRequests['codex:t2'], (r: any) => r.requestId), ['r3']);
  assert.equal(ctx.state.notifications.length, 1);
  const [n] = ctx.state.notifications;
  assert.equal(n.title, '3 approval request(s) waiting');
  assert.equal(n.level, 'warning');
  assert.equal(n.sessionId, 'codex:t1');
  assert.equal(n.message, 'Command: Run r1? · Command: Run r2? · Command: Run r3?');
  assert.deepEqual(flashes, ['3 approval request(s) waiting']);
});

test('the restored row names at most three approvals and counts the rest', () => {
  const { ctx } = loadPermissions();
  ctx.restorePendingRequests(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => pending('codex:t1', id)));
  const [n] = ctx.state.notifications;
  assert.equal(n.title, '5 approval request(s) waiting');
  assert.equal(n.message, 'Command: Run r1? · Command: Run r2? · Command: Run r3? …and 2 more');
});

test('a single restored approval is counted the same way', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([pending('codex:t1', 'r1')]);
  assert.equal(ctx.state.notifications[0].title, '1 approval request(s) waiting');
  assert.deepEqual(flashes, ['1 approval request(s) waiting']);
});

test('approvals the dashboard already shows add no row and no flash when restored again', () => {
  const { ctx, flashes } = loadPermissions();
  const list = [pending('codex:t1', 'r1'), pending('codex:t1', 'r2')];
  ctx.restorePendingRequests(list);
  ctx.restorePendingRequests(list);
  assert.equal(ctx.state.permissionRequests['codex:t1'].length, 2);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(flashes.length, 1);
});

test('nothing to restore adds no row and no flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([]);
  assert.deepEqual(ctx.state.notifications, []);
  assert.deepEqual(flashes, []);
});

test('each live approval still gets its own row and flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.showPermissionRequest({ type: 'permission_request', ...pending('codex:t1', 'r1') });
  ctx.showPermissionRequest({ type: 'permission_request', ...pending('codex:t1', 'r2') });
  assert.deepEqual(ctx.state.notifications.map((n: any) => [n.title, n.permRequestId]), [['Permission Request', 'r2'], ['Permission Request', 'r1']]);
  assert.deepEqual(flashes, ['Permission Request', 'Permission Request']);
});

const TITLE = 'Claude Alarm - Dashboard';

function loadFlash() {
  const timers = new Map<number, { fn: () => void; repeat: boolean }>();
  const focus = new Set<() => void>();
  let next = 1;
  const ctx: Record<string, any> = {
    document: { title: TITLE },
    window: {
      addEventListener: (type: string, fn: () => void) => { if (type === 'focus') focus.add(fn); },
      removeEventListener: (type: string, fn: () => void) => { if (type === 'focus') focus.delete(fn); },
    },
    setInterval: (fn: () => void) => { timers.set(next, { fn, repeat: true }); return next++; },
    setTimeout: (fn: () => void) => { timers.set(next, { fn, repeat: false }); return next++; },
    clearInterval: (id: number) => { timers.delete(id); },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // Flash title for attention', '  // Clear all notifications'), ctx);
  const count = (repeat: boolean) => [...timers.values()].filter((t) => t.repeat === repeat).length;
  return {
    ctx,
    tick: () => { for (const t of [...timers.values()]) if (t.repeat) t.fn(); },
    expire: () => { for (const [id, t] of [...timers]) if (!t.repeat) { timers.delete(id); t.fn(); } },
    focusWindow: () => { for (const fn of [...focus]) fn(); },
    intervals: () => count(true),
    timeouts: () => count(false),
    focusHandlers: () => focus.size,
  };
}

test('a second flash while the title shows the flash text still ends on the real title', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  f.ctx.flashTitle('Permission Request');
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
});

test('a second flash while flashing changes only the message and keeps one focus handler and one timer', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  assert.equal(f.ctx.document.title, '** Permission Request **');
  f.ctx.flashTitle('2 approval request(s) waiting');
  assert.equal(f.focusHandlers(), 1);
  assert.equal(f.timeouts(), 1);
  assert.equal(f.intervals(), 1);
  f.tick();
  assert.equal(f.ctx.document.title, TITLE);
  f.tick();
  assert.equal(f.ctx.document.title, '** 2 approval request(s) waiting **');
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
  assert.equal(f.focusHandlers(), 0);
  assert.equal(f.intervals() + f.timeouts(), 0);
});

test('the 30-second stop puts the real title back', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  f.expire();
  assert.equal(f.ctx.document.title, TITLE);
  assert.equal(f.focusHandlers(), 0);
  assert.equal(f.intervals() + f.timeouts(), 0);
});

test('a flash after the last one stopped starts again from the real title', () => {
  const f = loadFlash();
  f.ctx.flashTitle('A');
  f.tick();
  f.focusWindow();
  f.ctx.flashTitle('B');
  f.tick();
  assert.equal(f.ctx.document.title, '** B **');
  f.tick();
  assert.equal(f.ctx.document.title, TITLE);
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
});
