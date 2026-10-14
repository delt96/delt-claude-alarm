import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionControl } from '../src/channel/session-control.js';

function setup(opts: { supports?: boolean; sid?: string | undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-control-'));
  const controlDir = path.join(root, 'control');
  const adviceDir = path.join(root, 'advice');
  const sent: any[] = [];
  let now = 1_000_000;
  let sid: string | undefined = 'sid' in opts ? opts.sid : 's1';
  const hub = { supports: () => opts.supports ?? true, send: (m: unknown) => sent.push(m) };
  const control = new SessionControl(hub, 'alarm-1', { controlDir, adviceDir, claudeSessionId: () => sid, now: () => now });
  const file = (kind: string, id = 's1') => path.join(controlDir, kind, `${id}.json`);
  const put = (p: string, value: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  return {
    control, sent, file, put, adviceFile: (id = 's1') => path.join(adviceDir, `${id}.json`),
    advance: (ms: number) => { now += ms; }, now: () => now, setSid: (next: string | undefined) => { sid = next; },
    last: () => sent[sent.length - 1],
  };
}

test('nothing is sent to a hub without the feature', () => {
  const s = setup({ supports: false });
  s.control.refresh();
  assert.deepEqual(s.sent, []);
});

test('no alive file means no control, sent once', () => {
  const s = setup();
  s.control.refresh();
  s.control.refresh();
  assert.deepEqual(s.sent, [{ type: 'session_control', sessionId: 'alarm-1', control: null }]);
});

test('a fresh alive file gives the busy flag, with the advisor advice when there is one', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: false });
  s.put(s.adviceFile(), { kind: 'compact', at: 1 });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: false, advice: 'compact' });
  s.put(s.adviceFile(), { kind: null, at: 2 });
  s.put(s.file('alive'), { busy: true, at: s.now() });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: true });
});

test('a stale or ended alive file means no control, and an ended one is removed', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.refresh();
  s.advance(45_001);
  s.control.refresh();
  assert.equal(s.last().control, null);
  s.put(s.file('alive'), { busy: false, at: s.now(), ended: true });
  s.control.reset();
  s.control.refresh();
  assert.equal(s.last().control, null);
  assert.equal(fs.existsSync(s.file('alive')), false);
});

test('a half-written alive file keeps the previous state', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.refresh();
  s.put(s.file('alive'), '{"busy":fa');
  s.control.refresh();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.last().control, { busy: false });
});

test('a command is written for an idle session and refused otherwise', () => {
  const s = setup();
  s.control.command('r1', 'compact');
  assert.deepEqual(s.last(), { type: 'session_command_result', sessionId: 'alarm-1', requestId: 'r1', ok: false, reason: 'the claude-alarm mod is not running in this session' });
  s.put(s.file('alive'), { busy: true, at: s.now() });
  s.control.command('r2', 'compact');
  assert.equal(s.last().reason, 'the session is busy');
  assert.equal(fs.existsSync(s.file('command')), false);
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r3', 'clear');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file('command'), 'utf8')), { id: 'r3', kind: 'clear', at: s.now() });
  const before = s.sent.length;
  s.control.command('../bad', 'clear');
  assert.equal(s.sent.length, before);
});

test('no Claude session id means the command is refused', () => {
  const s = setup({ sid: undefined });
  s.control.command('r1', 'compact');
  assert.equal(s.last().reason, 'the Claude Code session was not found');
});

test('a result is relayed and both files are removed', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r4', 'compact');
  s.put(s.file('result'), { id: 'r4', ok: false, reason: 'skipped: off', at: s.now() });
  s.control.refresh();
  assert.ok(s.sent.some((m) => m.type === 'session_command_result' && m.requestId === 'r4' && m.ok === false && m.reason === 'skipped: off'));
  assert.equal(fs.existsSync(s.file('command')), false);
  assert.equal(fs.existsSync(s.file('result')), false);
});

test('a result for another request is not taken; silence ends in "no answer"', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r5', 'compact');
  s.put(s.file('result'), { id: 'older', ok: true, at: s.now() });
  s.advance(34_000);
  s.control.refresh();
  assert.ok(!s.sent.some((m) => m.requestId === 'r5'));
  s.advance(1);
  s.control.refresh();
  assert.ok(s.sent.some((m) => m.requestId === 'r5' && m.reason === 'no answer from the session'));
  assert.equal(fs.existsSync(s.file('command')), false);
});

test('after /clear the result is still read from the old id', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r6', 'clear');
  s.setSid('s2');
  s.put(s.file('result', 's1'), { id: 'r6', ok: true, at: s.now() });
  s.control.refresh();
  assert.ok(s.sent.some((m) => m.requestId === 'r6' && m.ok === true));
});
