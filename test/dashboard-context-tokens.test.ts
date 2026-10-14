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

const chip = (html: string) => html.match(/<span class="token-chip[^"]*"[^>]*>.*?<\/span><\/span>|<span class="token-chip[^"]*"[^>]*>[^<]*<\/span>/)?.[0] ?? '';

test('the count sits in a chip next to the status, not in the folder line', () => {
  const { ctx, list } = load({ s1: session({ contextTokens: 132854 }) });
  ctx.renderSessions();
  assert.doesNotMatch(list.innerHTML, /session-cwd"[^>]*>[^<]*133k/);
  assert.match(list.innerHTML, /<div class="session-chips"><span class="session-status idle">idle<\/span><span class="token-chip level-plain" title="Context: 132,854 tokens">133k<\/span><\/div>/);
});

test('a card without a count shows no chip', () => {
  const { ctx, list } = load({ s1: session({}), s2: { ...session({ contextTokens: 0 }), id: 's2', cwd: undefined } });
  ctx.renderSessions();
  assert.doesNotMatch(list.innerHTML, /token-chip/);
});

test('a card without a folder still shows the chip', () => {
  const { ctx, list } = load({ s1: session({ cwd: undefined, contextTokens: 2000 }) });
  ctx.renderSessions();
  assert.match(chip(list.innerHTML), />2k</);
});

test('the chip shows the change since the last update, up or down', () => {
  const { ctx, list } = load({
    s1: session({ contextTokens: 312_000, contextTokensDelta: 4_120 }),
    s2: { ...session({ contextTokens: 30_000, contextTokensDelta: -180_000 }), id: 's2' },
  });
  ctx.renderSessions();
  const [up, down] = list.innerHTML.split('data-id="s2"');
  assert.match(chip(up), /312k <span class="token-delta">\+4k<\/span>/);
  assert.match(chip(up), /title="Context: 312,000 tokens, \+4,120 since the last update"/);
  assert.match(chip(down), /30k <span class="token-delta">&minus;180k<\/span>/);
  assert.match(chip(down), /-180,000 since the last update/);
});

test('levels follow claude-jev-advisor: red near auto-compact, yellow when it suggests a command, green from minTokens', () => {
  const card = (contextTokens: number, control?: object) => {
    const { ctx, list } = load({ s1: session({ contextTokens, control }) });
    ctx.renderSessions();
    return chip(list.innerHTML);
  };
  assert.match(card(249_999), /level-plain/);
  assert.match(card(250_000), /level-green/);
  assert.match(card(250_000, { busy: false }), /level-green/);
  assert.match(card(150_000, { busy: false, greenFrom: 120_000 }), /level-green/);
  assert.match(card(110_000, { busy: false, greenFrom: 120_000 }), /level-plain/);
  const yellow = card(100_000, { busy: false, advice: 'compact' });
  assert.match(yellow, /level-yellow/);
  assert.match(yellow, /\/compact<\/span>/);
  assert.match(yellow, /Advisor suggests \/compact/);
  const red = card(870_300, { busy: false, advice: 'clear', compactAt: 967_000, redFrom: 773_600 });
  assert.match(red, /level-red/);
  assert.match(red, /<span class="token-note">10% left<\/span>/);
  assert.match(red, /auto-compact at 967,000/);
  assert.match(red, /Advisor suggests \/clear/);
  assert.match(card(773_599, { busy: false, compactAt: 967_000, redFrom: 773_600 }), /level-green/);
});

test('the advisor dot is gone from the folder line', () => {
  const { ctx, list } = load({ s1: session({ contextTokens: 2000, control: { busy: false, advice: 'compact' } }) });
  ctx.renderSessions();
  assert.doesNotMatch(list.innerHTML, /advice-dot/);
});
