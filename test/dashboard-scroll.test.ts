import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(state: Record<string, any>) {
  const start = html.indexOf('  function settleMessagesScroll(');
  const end = html.indexOf('  function renderNotifications(');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const ctx: Record<string, any> = { state };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx;
}

function list(scrollTop: number, scrollHeight: number, clientHeight: number, imgs: any[] = []) {
  return { scrollTop, scrollHeight, clientHeight, querySelectorAll: (sel: string) => (sel === 'img' ? imgs : []) };
}

function image(complete: boolean) {
  const handlers: Array<() => void> = [];
  return { complete, addEventListener: (ev: string, fn: () => void) => { if (ev === 'load') handlers.push(fn); }, fire: () => handlers.forEach(f => f()) };
}

test('a newly opened session goes to its last message even far from the bottom', () => {
  const state = { scrollToEnd: true, scrollPinned: false };
  const el = list(300, 5000, 600);
  load(state).settleMessagesScroll(el);
  assert.equal(el.scrollTop, 5000);
  assert.equal(state.scrollToEnd, false);
  assert.equal(state.scrollPinned, true);
});

test('a hidden list keeps the request until it is shown', () => {
  const state = { scrollToEnd: true, scrollPinned: false };
  const ctx = load(state);
  const hidden = list(0, 0, 0);
  ctx.settleMessagesScroll(hidden);
  assert.equal(state.scrollToEnd, true);
  const shown = list(0, 5000, 600);
  ctx.settleMessagesScroll(shown);
  assert.equal(shown.scrollTop, 5000);
  assert.equal(state.scrollToEnd, false);
});

test('reading older messages in the same session is not interrupted', () => {
  const state = { scrollToEnd: false, scrollPinned: false };
  const el = list(1000, 5000, 600);
  load(state).settleMessagesScroll(el);
  assert.equal(el.scrollTop, 1000);
});

test('near the bottom it still follows new messages', () => {
  const state = { scrollToEnd: false, scrollPinned: true };
  const el = list(4300, 5000, 600);
  load(state).settleMessagesScroll(el);
  assert.equal(el.scrollTop, 5000);
});

test('an image that loads later keeps a pinned list at the bottom', () => {
  const state = { scrollToEnd: true, scrollPinned: false };
  const late = image(false);
  const el = list(0, 5000, 600, [image(true), late]);
  load(state).settleMessagesScroll(el);
  el.scrollHeight = 5400;
  late.fire();
  assert.equal(el.scrollTop, 5400);
});

test('an image that loads after the user scrolled up does not pull them down', () => {
  const state = { scrollToEnd: true, scrollPinned: false };
  const late = image(false);
  const el = list(0, 5000, 600, [late]);
  load(state).settleMessagesScroll(el);
  state.scrollPinned = false;
  el.scrollTop = 2000;
  el.scrollHeight = 5400;
  late.fire();
  assert.equal(el.scrollTop, 2000);
});
