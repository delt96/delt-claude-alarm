import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSupervisor, adapterEnv, resolveAdapterScript } from '../src/hub/codex-supervisor.js';

class FakeChild extends EventEmitter {
  ended = false;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => { this.ended = true; } });
  kill() { this.killed = true; return true; }
}

function harness(graceMs = 3000, env?: NodeJS.ProcessEnv) {
  const children: FakeChild[] = [];
  const args: string[][] = [];
  const options: any[] = [];
  const sup = new CodexSupervisor('/x/codex/main.js', {
    spawnFn: (_cmd, a, o) => {
      args.push(a);
      options.push(o);
      const c = new FakeChild();
      children.push(c);
      return c as any;
    },
    minDelayMs: 10,
    maxDelayMs: 40,
    stopGraceMs: graceMs,
    env,
  });
  return { sup, children, args, options };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('launches the adapter with stdin watching', () => {
  const { sup, args } = harness();
  sup.start();
  assert.deepEqual(args[0], ['/x/codex/main.js', '--watch-stdin']);
  sup.stop();
});

test('restarts after a crash', async () => {
  const { sup, children } = harness();
  sup.start();
  children[0].emit('exit', 1, null);
  await sleep(30);
  assert.equal(children.length, 2);
  sup.stop();
});

test('a clean exit is not restarted', async () => {
  const { sup, children } = harness();
  sup.start();
  children[0].emit('exit', 0, null);
  await sleep(30);
  assert.equal(children.length, 1);
  sup.stop();
});

test('spawns detached with piped stdio', () => {
  const { sup, options } = harness();
  sup.start();
  assert.equal(options[0].detached, true);
  assert.deepEqual(options[0].stdio, ['pipe', 'pipe', 'pipe']);
  sup.stop();
});

test('stop closes stdin without killing, then kills after the grace period', async () => {
  const { sup, children } = harness(50);
  sup.start();
  sup.stop();
  assert.equal(children[0].ended, true);
  assert.equal(children[0].killed, false);
  await sleep(120);
  assert.equal(children[0].killed, true);
});

test('a child that exits within the grace period is never killed', async () => {
  const { sup, children } = harness(50);
  sup.start();
  sup.stop();
  children[0].emit('exit', 0, null);
  await sleep(120);
  assert.equal(children[0].killed, false);
});

test('an exit after stop never restarts', async () => {
  const { sup, children } = harness(50);
  sup.start();
  sup.stop();
  children[0].emit('exit', 1, null);
  await sleep(40);
  assert.equal(children.length, 1);
});

test('resolveAdapterScript finds the adapter next to the hub or the bundled CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-dist-'));
  fs.mkdirSync(path.join(root, 'hub'));
  assert.equal(resolveAdapterScript(path.join(root, 'hub')), undefined);
  fs.mkdirSync(path.join(root, 'codex'));
  fs.writeFileSync(path.join(root, 'codex', 'main.js'), '');
  assert.equal(resolveAdapterScript(path.join(root, 'hub')), path.join(root, 'codex', 'main.js'));
  assert.equal(resolveAdapterScript(root), path.join(root, 'codex', 'main.js'));
});

test('the adapter gets the environment it was given', () => {
  const env = { CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: '7900' };
  const { sup, options } = harness(3000, env);
  sup.start();
  assert.deepEqual(options[0].env, env);
  sup.stop();
});

test('without an environment the adapter inherits the hub one', () => {
  const { sup, options } = harness();
  sup.start();
  assert.equal('env' in options[0], false);
  sup.stop();
});

test('adapterEnv points at the hub itself and keeps the token out of the environment', () => {
  const base = {
    PATH: '/bin',
    CLAUDE_ALARM_HUB_HOST: 'other-pc',
    CLAUDE_ALARM_HUB_PORT: '9999',
    CLAUDE_ALARM_HUB_TOKEN: 'other-token',
  };
  const env = adapterEnv(base, { host: '0.0.0.0', port: 7900 });
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_ALARM_HUB_HOST: '0.0.0.0', CLAUDE_ALARM_HUB_PORT: '7900' });
  assert.equal(base.CLAUDE_ALARM_HUB_TOKEN, 'other-token');
});
