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
  const panel = { innerHTML: '', hidden: false };
  const ctx: Record<string, any> = {
    $: (sel: string) => (sel === '#usageStrip' ? strip : sel === '#usagePanel' ? panel : null),
    state: { usageLimits },
    esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, strip, panel };
}

const NOW = Date.parse('2026-10-14T05:00:00Z');
const pad = (n: number) => String(n).padStart(2, '0');
const hm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const md = (ms: number) => `${new Date(ms).getMonth() + 1}/${new Date(ms).getDate()}`;
const noTitles = (s: string) => s.replace(/ title="[^"]*"/g, '');
const text = (s: string) => s.replace(/<[^>]+>/g, '');

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
  assert.equal(text(strip.innerHTML), 'Claude 5h 42% · 7d 18%│Codex 5h 99% · 7d 35%');
  assert.match(strip.innerHTML, /title="Claude usage as of 2 min ago"/);
  assert.match(strip.innerHTML, /class="usage-window usage-high"[^>]*>5h 99%/);
});

test('a window past its reset time says reset', () => {
  const { ctx, strip } = load({ claude: { fiveHour: { usedPercent: 100, resetsAt: NOW - 1 }, updatedAt: NOW - 1_000 }, codex: null });
  ctx.renderUsageLimits(NOW);
  assert.equal(text(strip.innerHTML), 'Claude 5h reset');
});

test('the strip and the panel hide an agent without data, and themselves when both are empty', () => {
  const one = load({ claude: null, codex: { sevenDay: { usedPercent: 5, resetsAt: null }, updatedAt: NOW } });
  one.ctx.renderUsageLimits(NOW);
  assert.equal(text(one.strip.innerHTML), 'Codex 7d 5%');
  assert.doesNotMatch(one.panel.innerHTML, /Claude/);
  assert.equal(one.panel.hidden, false);

  for (const limits of [null, { claude: null, codex: null }, { claude: { updatedAt: NOW }, codex: null }]) {
    const none = load(limits);
    none.ctx.renderUsageLimits(NOW);
    assert.equal(none.strip.innerHTML, '');
    assert.equal(none.strip.hidden, true);
    assert.equal(none.panel.innerHTML, '');
    assert.equal(none.panel.hidden, true);
  }
});

test('the panel lists each window with a bar, its percentage and when it resets', () => {
  const fiveReset = NOW + 2 * 3_600_000;
  const weekReset = NOW + 3 * 86_400_000;
  const { ctx, panel } = load({
    claude: { fiveHour: { usedPercent: 42.4, resetsAt: fiveReset }, sevenDay: { usedPercent: 140, resetsAt: weekReset }, updatedAt: NOW - 120_000 },
    codex: { fiveHour: { usedPercent: 99, resetsAt: null }, updatedAt: NOW },
  });
  ctx.renderUsageLimits(NOW);
  const out = noTitles(panel.innerHTML);
  const row = (level: string, name: string, label: string, pct: number, reset: string) =>
    `<div class="usage-row${level}"><span class="usage-name">${name}</span><span class="usage-label">${label}</span>` +
    `<span class="usage-track" aria-hidden="true"><span class="usage-fill" style="width:${pct}%"></span></span>` +
    `<span class="usage-pct">${pct}%</span><span class="usage-reset">${reset}</span></div>`;
  assert.equal(panel.hidden, false);
  assert.ok(out.includes(row('', 'Claude', '5h', 42, hm(fiveReset))), out);
  assert.ok(out.includes(row(' usage-high', '', '7d', 100, md(weekReset))), out);
  assert.ok(out.includes(row(' usage-high', 'Codex', '5h', 99, '')), out);
  assert.match(out, /<div class="usage-age">Claude 2 min ago · Codex just now<\/div>/);
  assert.match(panel.innerHTML, /<span class="usage-reset" title="Resets [^"]+">/);
});

test('a passed window in the panel says reset with an empty bar', () => {
  const { ctx, panel } = load({ claude: { fiveHour: { usedPercent: 100, resetsAt: NOW - 1 }, updatedAt: NOW }, codex: null });
  ctx.renderUsageLimits(NOW);
  assert.ok(
    noTitles(panel.innerHTML).includes(
      '<div class="usage-row"><span class="usage-name">Claude</span><span class="usage-label">5h</span>' +
        '<span class="usage-track" aria-hidden="true"><span class="usage-fill" style="width:0%"></span></span>' +
        '<span class="usage-pct">reset</span><span class="usage-reset"></span></div>',
    ),
    panel.innerHTML,
  );
});

test('the panel sits above the notifications; the header line is for phones only', () => {
  assert.match(html, /<div class="notifications-panel">\s*<section class="usage-panel" id="usagePanel" hidden><\/section>\s*<div class="notif-header">/);
  const mobileAt = html.indexOf('@media (max-width: 768px)');
  const desktop = html.slice(0, mobileAt);
  const mobile = html.slice(mobileAt);
  assert.match(desktop, /\.usage-strip \{[^}]*display: none;/);
  assert.match(mobile, /\.usage-strip:not\(\[hidden\]\) \{ display: block; \}/);
  assert.match(mobile, /\.usage-panel \{ display: none; \}/);
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
