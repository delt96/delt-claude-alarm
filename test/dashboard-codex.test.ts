import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The dashboard is a single inline-script HTML file; evaluate the Codex helper block in a sandbox.
function loadCodexHelpers() {
  const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('  // --- Codex helpers ---');
  const end = html.indexOf('  // --- Add session popup ---');
  assert.ok(start > 0 && end > start, 'Codex helper anchors not found');
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return ctx as any;
}

test('only ready adapters are offered, the hub PC first', () => {
  const { usableAdapters } = loadCodexHelpers();
  const list = usableAdapters([
    { id: 'b', host: 'laptop', ready: true, isLocal: false },
    { id: 'c', host: 'old', ready: false, isLocal: true },
    { id: 'a', host: 'desk', ready: true, isLocal: true },
  ]);
  assert.deepEqual(Array.from(list, (x: any) => x.id), ['a', 'b']);
  assert.equal(usableAdapters([{ id: 'c', host: 'old', ready: false, isLocal: true }]).length, 0);
});

test('adapters on PCs with the same name are told apart by their id', () => {
  const { adapterLabels } = loadCodexHelpers();
  const labels = adapterLabels([
    { id: 'abcd1234', host: 'pc' },
    { id: 'ef567890', host: 'pc' },
    { id: 'z9', host: 'other' },
  ]);
  assert.deepEqual(Array.from(labels), ['pc (abcd)', 'pc (ef56)', 'other']);
});

test('closing takes a second click between 0.4 and 3 seconds after the first', () => {
  const { closeStep } = loadCodexHelpers();
  assert.equal(closeStep(null, 1000), 'arm');
  assert.equal(closeStep(1000, 1200), 'wait');
  assert.equal(closeStep(1000, 1400), 'close');
  assert.equal(closeStep(1000, 3999), 'close');
  assert.equal(closeStep(1000, 4000), 'arm');
});
