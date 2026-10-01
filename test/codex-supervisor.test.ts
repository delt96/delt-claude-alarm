import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSupervisor, resolveAdapterScript } from '../src/hub/codex-supervisor.js';

class FakeChild extends EventEmitter {
  ended = false;
  killed = false;
  stdin = { end: () => { this.ended = true; } };
  kill() { this.killed = true; return true; }
}

function harness() {
  const children: FakeChild[] = [];
  const args: string[][] = [];
  const sup = new CodexSupervisor('/x/codex/main.js', (_cmd, a) => {
    args.push(a);
    const c = new FakeChild();
    children.push(c);
    return c as any;
  }, 10, 40);
  return { sup, children, args };
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

test('stop closes stdin, kills the child and never restarts', async () => {
  const { sup, children } = harness();
  sup.start();
  sup.stop();
  assert.equal(children[0].ended, true);
  assert.equal(children[0].killed, true);
  children[0].emit('exit', null, 'SIGTERM');
  await sleep(30);
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
