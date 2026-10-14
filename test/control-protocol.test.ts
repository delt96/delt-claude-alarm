import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlFile, isControlKind, isSafeId, parseAdvice, parseAlive, parseCommand, parseJsonText, parseResult,
} from '../src/shared/control-protocol.js';

test('controlFile joins with forward slashes and drops trailing separators', () => {
  assert.equal(controlFile('C:/Users/u/.claude-alarm/control/', 'alive', 'abc-1'), 'C:/Users/u/.claude-alarm/control/alive/abc-1.json');
  assert.equal(controlFile('C:\\x\\control\\', 'command', 's'), 'C:\\x\\control/command/s.json');
});

test('ids and kinds', () => {
  assert.equal(isSafeId('7fd61621-14b3_x'), true);
  for (const bad of ['', '../x', 'a/b', 'a b', 1, null, 'x'.repeat(129)]) assert.equal(isSafeId(bad), false, String(bad));
  assert.equal(isControlKind('compact'), true);
  assert.equal(isControlKind('clear'), true);
  assert.equal(isControlKind('exit'), false);
});

test('parseJsonText strips a BOM and returns undefined for junk', () => {
  assert.deepEqual(parseJsonText(String.fromCharCode(0xfeff) + '{"a":1}'), { a: 1 });
  assert.equal(parseJsonText('{"a":'), undefined);
  assert.equal(parseJsonText(undefined), undefined);
  assert.equal(parseJsonText({ base64: 'x' }), undefined);
});

test('parseAlive', () => {
  assert.deepEqual(parseAlive({ busy: false, at: 5 }), { busy: false, at: 5 });
  assert.deepEqual(parseAlive({ busy: false, at: 5, ended: true }), { busy: false, at: 5, ended: true });
  assert.deepEqual(parseAlive({ busy: true, at: 5, ended: 'yes' }), { busy: true, at: 5 });
  for (const bad of [null, [], { busy: 'no', at: 1 }, { busy: true }, { busy: true, at: Number.NaN }]) assert.equal(parseAlive(bad), null);
});

test('parseAlive keeps the auto-compact threshold only when it is a positive number', () => {
  assert.deepEqual(parseAlive({ busy: false, at: 5, compactAt: 967000 }), { busy: false, at: 5, compactAt: 967000 });
  for (const bad of [0, -1, '967000', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.deepEqual(parseAlive({ busy: false, at: 5, compactAt: bad }), { busy: false, at: 5 }, String(bad));
  }
});

test('parseCommand', () => {
  assert.deepEqual(parseCommand({ id: 'r1', kind: 'clear', at: 9, extra: 1 }), { id: 'r1', kind: 'clear', at: 9 });
  for (const bad of [{ id: '../r', kind: 'clear', at: 1 }, { id: 'r', kind: 'exit', at: 1 }, { id: 'r', kind: 'clear' }]) assert.equal(parseCommand(bad), null);
});

test('parseResult keeps a reason only when it is a string, and caps it', () => {
  assert.deepEqual(parseResult({ id: 'r', ok: true, at: 1 }), { id: 'r', ok: true, at: 1 });
  assert.deepEqual(parseResult({ id: 'r', ok: false, reason: 'busy', at: 1 }), { id: 'r', ok: false, reason: 'busy', at: 1 });
  assert.deepEqual(parseResult({ id: 'r', ok: false, reason: 3, at: 1 }), { id: 'r', ok: false, at: 1 });
  assert.equal(parseResult({ id: 'r', ok: false, reason: 'x'.repeat(600), at: 1 })?.reason?.length, 500);
  assert.equal(parseResult({ id: 'r', ok: 'yes', at: 1 }), null);
});

test('parseAdvice accepts a null kind', () => {
  assert.deepEqual(parseAdvice({ kind: null, at: 1 }), { kind: null, at: 1 });
  assert.deepEqual(parseAdvice({ kind: 'compact', at: 1 }), { kind: 'compact', at: 1 });
  assert.equal(parseAdvice({ kind: 'compactLater', at: 1 }), null);
  assert.equal(parseAdvice({ kind: 'clear' }), null);
});
