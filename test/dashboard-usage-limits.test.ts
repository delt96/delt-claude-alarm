import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function load(usageLimits: unknown) {
  const start = html.indexOf('  function formatAge(ms) {');
  const end = html.indexOf('  function formatTokens(n) {');
  assert.ok(start > 0 && end > start, 'anchors not found');
  const strip = { innerHTML: '', hidden: false };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#usageStrip' ? strip : null),
    state: { usageLimits },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, strip };
}

const NOW = Date.parse('2026-10-14T05:00:00Z');

test('formatAge says how old the reading is', () => {
  const { ctx } = load(null);
  assert.equal(ctx.formatAge(30_000), 'just now');
  assert.equal(ctx.formatAge(5 * 60_000), '5 min ago');
  assert.equal(ctx.formatAge(3 * 3_600_000), '3 h ago');
  assert.equal(ctx.formatAge(-1), 'just now');
});

test('the strip shows both agents with rounded percentages', () => {
  const { ctx, strip } = load({
    claude: { fiveHour: { usedPercent: 42.4, resetsAt: NOW + 3_600_000 }, sevenDay: { usedPercent: 17.6, resetsAt: NOW + 86_400_000 }, updatedAt: NOW - 120_000 },
    codex: { fiveHour: { usedPercent: 99, resetsAt: NOW + 60_000 }, sevenDay: { usedPercent: 35, resetsAt: null }, updatedAt: NOW },
  });
  ctx.renderUsageLimits(NOW);
  assert.equal(strip.hidden, false);
  const text = strip.innerHTML.replace(/<[^>]+>/g, '');
  assert.equal(text, 'Claude 5h 42% · 7d 18%│Codex 5h 99% · 7d 35%');
  assert.match(strip.innerHTML, /title="Claude usage as of 2 min ago"/);
  assert.match(strip.innerHTML, /class="usage-window usage-high"[^>]*>5h 99%/);
});

test('a window past its reset time says reset', () => {
  const { ctx, strip } = load({ claude: { fiveHour: { usedPercent: 100, resetsAt: NOW - 1 }, updatedAt: NOW - 1_000 }, codex: null });
  ctx.renderUsageLimits(NOW);
  assert.equal(strip.innerHTML.replace(/<[^>]+>/g, ''), 'Claude 5h reset');
});

test('the strip hides an agent without data, and itself when both are empty', () => {
  const one = load({ claude: null, codex: { sevenDay: { usedPercent: 5, resetsAt: null }, updatedAt: NOW } });
  one.ctx.renderUsageLimits(NOW);
  assert.equal(one.strip.innerHTML.replace(/<[^>]+>/g, ''), 'Codex 7d 5%');

  for (const limits of [null, { claude: null, codex: null }, { claude: { updatedAt: NOW }, codex: null }]) {
    const none = load(limits);
    none.ctx.renderUsageLimits(NOW);
    assert.equal(none.strip.innerHTML, '');
    assert.equal(none.strip.hidden, true);
  }
});

test('on phones the strip takes its own row and the panels shrink to fit', () => {
  const mobile = html.slice(html.indexOf('@media (max-width: 768px)'));
  assert.match(mobile, /header \{[^}]*flex-wrap: wrap;/);
  assert.match(mobile, /\.usage-strip \{[^}]*order: 3;[^}]*flex-basis: 100%;/);
  assert.match(mobile, /body:has\(#usageStrip:not\(\[hidden\]\)\) \.container \{[^}]*height: calc\(100vh - 119px\);/);
});

test('the header keeps the strip on one line', () => {
  assert.match(html, /\.usage-strip \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  assert.match(html, /<h1>Claude Alarm<\/h1>\s*<div class="usage-strip" id="usageStrip" hidden><\/div>/);
});
