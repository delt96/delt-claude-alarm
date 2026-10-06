import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { FakeDaemon } from '../helpers/fake-codex-daemon.js';

const mode = process.argv[2];
const daemon = new FakeDaemon();
await daemon.start();
daemon.handle('thread/start', () => ({ thread: { id: 'review-thread' } }));
daemon.handle('turn/start', () => {
  setTimeout(() => daemon.notify('turn/completed', { threadId: 'review-thread', turn: { id: 'review-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Finished', phase: 'final_answer' }] } }), 10);
  return { turn: { id: 'review-turn' } };
});
process.on('message', (m) => { if (m === 'stop-daemon') { process.disconnect(); void daemon.stop(); } });
const originalSpawn = childProcess.spawn;
childProcess.spawn = (_command, _args, _options) => {
  const child = originalSpawn(process.execPath, [path.resolve('test/fixtures/fake-codex-proxy.mjs')], { stdio: 'pipe', env: { ...process.env, FAKE_CODEX_CONTROL: daemon.url, FAKE_CODEX_LINGER: '1' } });
  process.send?.({ pid: child.pid });
  child.kill = () => true;
  return child;
};
if (mode === 'stuck') {
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 15_000 ? 20 : ms, ...args);
  fs.writeFileSync(path.join(process.env.USERPROFILE, 'codex.cmd'), '');
  process.env.PATH = process.env.USERPROFILE;
  childProcess.execFile = () => ({});
}
syncBuiltinESMExports();
process.argv = [process.execPath, path.resolve('src/cli.ts'), 'codex', 'run', '--brief', '-'];
await import('../../src/cli.ts');
