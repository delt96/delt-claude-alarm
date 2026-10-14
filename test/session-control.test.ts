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
  const advisorConfigFile = path.join(root, 'advisor', 'config.json');
  const control = new SessionControl(hub, 'alarm-1', { controlDir, adviceDir, advisorConfigFile, claudeSessionId: () => sid, now: () => now });
  const file = (kind: string, id = 's1') => path.join(controlDir, kind, `${id}.json`);
  const put = (p: string, value: unknown) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  return {
    control, sent, file, put, advisorConfigFile, adviceFile: (id = 's1') => path.join(adviceDir, `${id}.json`),
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

test('the red level starts 20% below the auto-compact threshold the mod reports', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now(), compactAt: 967_000 });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: false, compactAt: 967_000, redFrom: 773_600 });
});

test("the advisor's own minTokens and redRemainingPct are used when its config sets them", () => {
  const s = setup();
  s.put(s.advisorConfigFile, { version: 2, context: { minTokens: 120_000, redRemainingPct: 10 } });
  s.put(s.file('alive'), { busy: false, at: s.now(), compactAt: 200_000 });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: false, greenFrom: 120_000, compactAt: 200_000, redFrom: 180_000 });
});

test('a config without a version is read the way the advisor reads it: its old default minTokens counts as unset', () => {
  const s = setup();
  s.put(s.advisorConfigFile, { context: { minTokens: 150_000, redRemainingPct: 5 } });
  s.put(s.file('alive'), { busy: false, at: s.now(), compactAt: 100_000 });
  s.control.refresh();
  assert.deepEqual(s.last().control, { busy: false, greenFrom: 150_000, compactAt: 100_000, redFrom: 95_000 });
});

test('advisor config values that are missing or invalid are left out', () => {
  for (const config of [
    { version: 2 },
    { version: 2, context: { minTokens: -1, redRemainingPct: 150 } },
    { version: 2, context: { minTokens: '100000', redRemainingPct: '5' } },
    { context: { minTokens: 100_000 } },
    'not json',
  ]) {
    const s = setup();
    s.put(s.advisorConfigFile, config);
    s.put(s.file('alive'), { busy: false, at: s.now(), compactAt: 100_000 });
    s.control.refresh();
    assert.deepEqual(s.last().control, { busy: false, compactAt: 100_000, redFrom: 80_000 }, JSON.stringify(config));
  }
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

test('a second command while one is pending is refused and leaves the command file alone', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r7', 'compact');
  s.control.command('r8', 'clear');
  assert.equal(s.last().requestId, 'r8');
  assert.equal(s.last().reason, 'a command is already running in this session');
  assert.equal(JSON.parse(fs.readFileSync(s.file('command'), 'utf8')).id, 'r7');
});

test('when the Claude session id changes, the old id\'s ended files are removed', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.refresh();
  s.put(s.file('alive'), { busy: false, at: s.now(), ended: true });
  s.put(s.file('result'), { id: 'old', ok: true, at: s.now() });
  s.setSid('s2');
  s.put(s.file('alive', 's2'), { busy: false, at: s.now() });
  s.control.refresh();
  assert.equal(fs.existsSync(s.file('alive')), false);
  assert.equal(fs.existsSync(s.file('result')), false);
  assert.deepEqual(s.last().control, { busy: false });
});

test('the old id is kept while a command for it waits for its result', () => {
  const s = setup();
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.command('r9', 'clear');
  s.control.refresh();
  s.put(s.file('alive'), { busy: false, at: s.now(), ended: true });
  s.setSid('s2');
  s.control.refresh();
  assert.equal(fs.existsSync(s.file('command')), true);
  s.put(s.file('result'), { id: 'r9', ok: true, at: s.now() });
  s.control.refresh();
  assert.ok(s.sent.some((m) => m.requestId === 'r9' && m.ok === true));
});

test('the first refresh sweeps control files older than a day', () => {
  const s = setup();
  const old = s.file('alive', 'gone');
  s.put(old, { busy: false, at: 1, ended: true });
  s.put(s.file('result', 'gone'), { id: 'x', ok: true, at: 1 });
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(old, dayAgo, dayAgo);
  fs.utimesSync(s.file('result', 'gone'), dayAgo, dayAgo);
  s.put(s.file('alive'), { busy: false, at: s.now() });
  s.control.refresh();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(s.file('result', 'gone')), false);
  assert.equal(fs.existsSync(s.file('alive')), true);
});
