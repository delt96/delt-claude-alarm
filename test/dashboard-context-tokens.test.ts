import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(sessions: Record<string, any>) {
  const start = html.indexOf('  function formatTokens(n) {');
  const end = html.indexOf('  function bindSessionCards(el) {');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const list = { innerHTML: '' };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#sessionsList' ? list : null),
    state: { sessions, selectedSession: null, unread: {}, closeArmed: null },
    getOrderedSessionIds: () => Object.keys(sessions),
    sessionDisplayName: (s: any) => s.name,
    closeStep: () => 'arm',
    bindSessionCards: () => {},
    updateImageUI: () => {},
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, list };
}

const session = (extra: object) => ({ id: 's1', name: 'app', status: 'idle', connectedAt: 0, cwd: 'C:\\w\\app', ...extra });

test('formatTokens shortens counts and hides empty ones', () => {
  const { ctx } = load({});
  const cases: Array<[unknown, string]> = [
    [undefined, ''], [null, ''], [0, ''], [-5, ''], ['12', ''], [Number.NaN, ''],
    [850, '850'], [1000, '1k'], [132854, '133k'], [999_499, '999k'], [999_500, '1.0M'], [1_234_567, '1.2M'],
  ];
  for (const [input, output] of cases) assert.equal(ctx.formatTokens(input), output, String(input));
});

test('a session card shows the count with the exact value on hover', () => {
  const { ctx, list } = load({ s1: session({ contextTokens: 132854 }) });
  ctx.renderSessions();
  assert.match(list.innerHTML, /&middot; <span class="session-tokens" title="Context: 132,854 tokens">133k<\/span>/);
});

test('a card without a count shows no token part', () => {
  const { ctx, list } = load({ s1: session({}), s2: { ...session({ contextTokens: 0 }), id: 's2', cwd: undefined } });
  ctx.renderSessions();
  assert.doesNotMatch(list.innerHTML, /session-tokens/);
});

test('a card without a folder still shows the count', () => {
  const { ctx, list } = load({ s1: session({ cwd: undefined, contextTokens: 2000 }) });
  ctx.renderSessions();
  assert.match(list.innerHTML, /class="session-tokens"[^>]*>2k</);
});
