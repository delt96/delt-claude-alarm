import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate the helper block
// between sessionDisplayName() and the Theme section in a sandbox.
function loadHelpers(sessions: Record<string, object>, names: Record<string, string> = {}, selected = 'a') {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  function sessionDisplayName(s)');
  const end = html.indexOf('  // --- Theme ---');
  assert.ok(start > 0 && end > start, 'helper block anchors not found');
  const stubEl = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, textContent: '', innerHTML: '' });
  const ctx: Record<string, unknown> = {
    state: { sessions, selectedSession: selected, sessionMeta: { names, order: [] } },
    $: stubEl,
    esc: (s: string) => s,
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx as any;
}

const sessions = {
  a: { id: 'a', name: 'ebill-service-kg', displayName: 'ebill-service-kg', peerName: 'ebill-service-kg-11' },
  b: { id: 'b', name: 'kg_ebill_front', displayName: 'kg_ebill_front', peerName: 'kg_ebill_front-3a' },
  c: { id: 'c', name: 'docs', displayName: 'docs (2)', peerName: 'docs-9f' },
  d: { id: 'd', name: 'nopeer', displayName: 'nopeer' },
};
const names = { b: 'front', c: 'ebill back' };

test('text without mentions passes through unchanged', () => {
  const h = loadHelpers(sessions, names);
  assert.deepEqual({ ...h.buildRouting('hello') }, { ok: true, content: 'hello' });
});

test('custom name resolves to the SendMessage peer name', () => {
  const h = loadHelpers(sessions, names);
  const r = h.buildRouting('@front hi');
  assert.equal(r.ok, true);
  assert.equal(r.content, '@front hi\n\n[claude-alarm] @front = SendMessage to "kg_ebill_front-3a"');
});

test('matching ignores case', () => {
  const h = loadHelpers(sessions, names);
  assert.match(h.buildRouting('@FRONT hi').content, /SendMessage to "kg_ebill_front-3a"/);
});

test('folder name resolves even when renamed', () => {
  const h = loadHelpers(sessions, names);
  assert.match(h.buildRouting('@kg_ebill_front hi').content, /SendMessage to "kg_ebill_front-3a"/);
});

test('bracketed names with spaces resolve', () => {
  const h = loadHelpers(sessions, names);
  assert.match(h.buildRouting('@[ebill back] check').content, /@ebill back = SendMessage to "docs-9f"/);
});

test('trailing punctuation is stripped', () => {
  const h = loadHelpers(sessions, names);
  assert.match(h.buildRouting('@front, hi').content, /SendMessage to "kg_ebill_front-3a"/);
});

test('attached Korean particle blocks the send', () => {
  const h = loadHelpers(sessions, names);
  const r = h.buildRouting('@front에 알려줘');
  assert.equal(r.ok, false);
  assert.deepEqual([...r.unknown], ['@front에']);
});

test('unknown name blocks the send', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.buildRouting('@nobody hi').ok, false);
});

test('session without peerName is not a target', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.buildRouting('@nopeer hi').ok, false);
});

test('the selected session is not a target', () => {
  const h = loadHelpers(sessions, names, 'b');
  assert.equal(h.buildRouting('@front hi').ok, false);
});

test('email addresses are not mentions', () => {
  const h = loadHelpers(sessions, names);
  assert.deepEqual({ ...h.buildRouting('mail a@b.com') }, { ok: true, content: 'mail a@b.com' });
});

test('duplicate mentions produce one routing line', () => {
  const h = loadHelpers(sessions, names);
  const lines = h.buildRouting('@front @front hi').content.split('\n').filter((l: string) => l.startsWith('[claude-alarm]'));
  assert.equal(lines.length, 1);
});

test('NFD input matches an NFC name', () => {
  const h = loadHelpers(sessions, { b: '프론트' });
  assert.match(h.buildRouting('@' + '프론트'.normalize('NFD') + ' hi').content, /SendMessage to "kg_ebill_front-3a"/);
});

test('custom name shared by two sessions is ambiguous', () => {
  const h = loadHelpers(sessions, { b: 'x', c: 'x' });
  assert.equal(h.buildRouting('@x hi').ok, false);
});

function query(value: string, caret = value.length) {
  const h = loadHelpers(sessions, names);
  const q = h.currentMentionQuery({ value, selectionStart: caret });
  return q ? { ...q } : null;
}

test('@ at start opens an empty query', () => {
  assert.deepEqual(query('@'), { start: 0, query: '' });
});

test('@ after a space captures the partial name', () => {
  assert.deepEqual(query('hi @fr'), { start: 3, query: 'fr' });
});

test('bracket form strips the opening bracket', () => {
  assert.deepEqual(query('@[ebill b'), { start: 0, query: 'ebill b' });
});

test('@ glued to a word does not open', () => {
  assert.equal(query('a@b'), null);
});

test('query ends at the caret', () => {
  assert.equal(query('@front hi'), null);
  assert.deepEqual(query('@front hi', 3), { start: 0, query: 'fr' });
});

test('rename rejects another session folder name', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.renameError('kg_ebill_front', 'a'), 'Name already used by another session');
});

test('rename rejects another session custom name ignoring case', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.renameError('FRONT', 'a'), 'Name already used by another session');
});

test('rename rejects bracket and at characters', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.renameError('a[b]', 'a'), 'Name cannot contain [, ] or @');
  assert.equal(h.renameError('me@x', 'a'), 'Name cannot contain [, ] or @');
});

test('rename allows a fresh name and the session own current name', () => {
  const h = loadHelpers(sessions, names);
  assert.equal(h.renameError('backend', 'a'), null);
  assert.equal(h.renameError('front', 'b'), null);
});
