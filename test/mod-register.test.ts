import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../src/mod/register.js';

type AnyFn = (...args: any[]) => any;
const DIR = 'D:/alarm/control';
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function harness(opts: { dir?: string; interactive?: boolean; files?: Record<string, string>; sid?: string; compact?: () => Promise<any>; run?: () => Promise<any>; usage?: (args?: unknown) => Promise<any> } = {}) {
  const hooks = new Map<string, AnyFn>();
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const calls = { compact: 0, run: [] as unknown[] };
  let timer: (() => void) | null = null;
  let now = 1_000_000;
  let sid = opts.sid ?? 's1';
  const $ = {
    session: {
      id: async () => sid,
      compact: opts.compact ?? (async () => { calls.compact++; return undefined; }),
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
    command: { run: opts.run ?? (async (args: unknown) => { calls.run.push(args); }) },
    fs: {
      read: async (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p); },
      write: async (p: string, text: string) => { files.set(p, text); },
    },
    clock: { now: async () => now, every: (_ms: number, fn: () => void) => { timer = fn; } },
  };
  register((event: string, hook: AnyFn) => hooks.set(event, hook), { controlDir: opts.dir ?? DIR });
  const fire = (event: string, e: object = {}) => hooks.get(event)!($, e, async (x: unknown) => x);
  return {
    files, calls, $,
    start: () => fire('session.start', { isInteractive: opts.interactive ?? true }),
    fire,
    tick: async () => { timer?.(); await flush(); },
    hasTimer: () => timer !== null,
    advance: (ms: number) => { now += ms; },
    setSid: (next: string) => { sid = next; },
    now: () => now,
    json: (p: string) => JSON.parse(files.get(p)!),
  };
}

const alive = (sid = 's1') => `${DIR}/alive/${sid}.json`;
const command = (sid = 's1') => `${DIR}/command/${sid}.json`;
const result = (sid = 's1') => `${DIR}/result/${sid}.json`;

test('no timer without a control folder or outside an interactive session', async () => {
  const a = harness({ dir: '' });
  await a.start();
  assert.equal(a.hasTimer(), false);
  const b = harness({ interactive: false });
  await b.start();
  assert.equal(b.hasTimer(), false);
});

test('the heartbeat is written on the first tick and then every 15 seconds', async () => {
  const h = harness();
  await h.start();
  await h.tick();
  assert.deepEqual(h.json(alive()), { busy: false, at: h.now() });
  const first = h.files.get(alive());
  h.advance(14_000);
  await h.tick();
  assert.equal(h.files.get(alive()), first);
  h.advance(1_000);
  await h.tick();
  assert.deepEqual(h.json(alive()), { busy: false, at: h.now() });
});

test('the heartbeat carries the auto-compact threshold when Claude Code reports one', async () => {
  const asked: unknown[] = [];
  const h = harness({ usage: async (args) => { asked.push(args); return { context: { tokens: 1, window: 1_000_000, breakdown: { autoCompactThreshold: 967_000 } } }; } });
  await h.start();
  await h.tick();
  assert.deepEqual(h.json(alive()), { busy: false, at: h.now(), compactAt: 967_000 });
  assert.deepEqual(asked[0], { breakdown: 'summary' });
});

test('the heartbeat leaves the threshold out when usage fails or has none', async () => {
  for (const usage of [async () => { throw new Error('no'); }, async () => ({ context: { window: 1 } }), async () => ({ context: { breakdown: { autoCompactThreshold: 'x' } } })]) {
    const h = harness({ usage });
    await h.start();
    await h.tick();
    assert.deepEqual(h.json(alive()), { busy: false, at: h.now() });
  }
});

test('a compact command runs once and leaves an ok result', async () => {
  const h = harness();
  await h.start();
  await h.tick();
  h.files.set(command(), JSON.stringify({ id: 'r1', kind: 'compact', at: h.now() }));
  await h.tick();
  assert.equal(h.calls.compact, 1);
  assert.deepEqual(h.json(result()), { id: 'r1', ok: true, at: h.now() });
  await h.tick();
  assert.equal(h.calls.compact, 1);
});

test('a clear command runs /clear', async () => {
  const h = harness();
  await h.start();
  h.files.set(command(), JSON.stringify({ id: 'r2', kind: 'clear', at: h.now() }));
  await h.tick();
  assert.deepEqual(h.calls.run, [{ command: 'clear' }]);
  assert.equal(h.json(result()).ok, true);
});

test('a main turn makes the session busy and refuses the command; a subagent turn does not', async () => {
  const h = harness();
  await h.start();
  await h.tick();
  await h.fire('turn.start', { agentId: 'sub-1' });
  await flush();
  assert.equal(h.json(alive()).busy, false);
  await h.fire('turn.start', {});
  await flush();
  assert.equal(h.json(alive()).busy, true);
  h.files.set(command(), JSON.stringify({ id: 'r3', kind: 'compact', at: h.now() }));
  await h.tick();
  assert.equal(h.calls.compact, 0);
  assert.deepEqual(h.json(result()), { id: 'r3', ok: false, reason: 'busy', at: h.now() });
  await h.fire('turn.complete', {});
  await flush();
  assert.equal(h.json(alive()).busy, false);
});

test('an old command expires without running', async () => {
  const h = harness();
  await h.start();
  h.files.set(command(), JSON.stringify({ id: 'r4', kind: 'compact', at: h.now() - 30_001 }));
  await h.tick();
  assert.equal(h.calls.compact, 0);
  assert.equal(h.json(result()).reason, 'expired');
});

test('a reloaded mod does not run a command its result file already answers', async () => {
  const h = harness({ files: {
    [command()]: JSON.stringify({ id: 'r5', kind: 'compact', at: 1_000_000 }),
    [result()]: JSON.stringify({ id: 'r5', ok: true, at: 1_000_000 }),
  } });
  await h.start();
  await h.tick();
  assert.equal(h.calls.compact, 0);
});

test('a vetoed or failing compact reports why', async () => {
  const vetoed = harness({ compact: async () => ({ skip: 'off' }) });
  await vetoed.start();
  vetoed.files.set(command(), JSON.stringify({ id: 'r6', kind: 'compact', at: vetoed.now() }));
  await vetoed.tick();
  assert.deepEqual(vetoed.json(result()), { id: 'r6', ok: false, reason: 'skipped: off', at: vetoed.now() });

  const failing = harness({ compact: async () => { throw new Error('a turn is running'); } });
  await failing.start();
  failing.files.set(command(), JSON.stringify({ id: 'r7', kind: 'compact', at: failing.now() }));
  await failing.tick();
  assert.equal(failing.json(result()).reason, 'a turn is running');
});

test('after /clear the result goes to the old id, the old alive ends, and the new id gets a heartbeat', async () => {
  let h: ReturnType<typeof harness>;
  h = harness({ run: async () => { h.setSid('s2'); await h.fire('session.end', { reason: 'clear' }); } });
  await h.start();
  await h.tick();
  h.files.set(command('s1'), JSON.stringify({ id: 'r8', kind: 'clear', at: h.now() }));
  await h.tick();
  assert.equal(h.json(result('s1')).id, 'r8');
  assert.equal(h.json(alive('s1')).ended, true);
  await h.tick();
  assert.deepEqual(h.json(alive('s2')), { busy: false, at: h.now() });
});
