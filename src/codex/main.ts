import { loadConfig } from '../shared/config.js';
import { CONFIG_DIR } from '../shared/constants.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import { logger } from '../shared/logger.js';
import { CodexAdapter } from './adapter.js';
import { resolveAdapterHub } from './hub-target.js';
import { acquireLock, controlEndpoint } from './instance-lock.js';

const WAIT_MIN_MS = 2000;
const WAIT_MAX_MS = 30_000;

installCrashGuard('codex adapter');
// Once the hub is gone its pipes break; without listeners every log line would become an uncaught EPIPE.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const config = loadConfig();
const supervised = process.argv.includes('--watch-stdin');
const endpoint = controlEndpoint(CONFIG_DIR);

let adapter: CodexAdapter | undefined;
let release: (() => Promise<void>) | undefined;
let exiting = false;
const shutdown = () => {
  if (exiting) return;
  exiting = true;
  // A codex.cmd proxy runs outside the job that ends this process's children on exit, so its kill must finish first.
  const stopped = adapter?.stop();
  const exit = () => process.exit(0);
  // server.close() waits for open control connections and the kill for a process snapshot; neither may keep a stopped adapter alive.
  setTimeout(exit, 3000).unref();
  Promise.all([stopped, release?.()]).then(exit, exit);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// On Windows `hub stop` kills the hub without running its exit handlers, so stdin EOF is the only sign the parent is gone.
if (supervised) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}

function send(message: object, then?: () => void): void {
  if (!process.send || !process.connected) {
    then?.();
    return;
  }
  // With a callback, a channel that closes between the check and the send reports here instead of throwing.
  process.send(message, undefined, undefined, (err: Error | null) => {
    if (err) logger.debug(`Report to the parent not delivered: ${err.message}`);
    then?.();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeLock(): Promise<boolean> {
  let delay = WAIT_MIN_MS;
  let waitReason: string | undefined;
  for (;;) {
    const lock = await acquireLock(endpoint, {
      pid: process.pid,
      token: config.hub.token ?? '',
      onStop: () => {
        if (supervised) logger.warn('Stopped by claude-alarm codex stop; the hub will not start the Codex adapter again until the hub restarts');
        shutdown();
      },
    });
    if (lock.kind === 'owner') {
      release = lock.close;
      if (waitReason !== undefined) logger.info('Codex adapter took over: the other adapter has stopped');
      return true;
    }
    if (!supervised) {
      if (lock.kind === 'held') {
        logger.info(`Codex adapter already running (PID: ${lock.pid})`);
        send({ type: 'codex-already-running', pid: lock.pid }, () => process.exit(0));
      } else {
        logger.error(`Codex adapter cannot start: ${lock.error}`);
        send({ type: 'codex-lock-failed', error: lock.error }, () => process.exit(1));
      }
      return false;
    }
    const reason = lock.kind === 'held' ? `held:${lock.pid}` : `unknown:${lock.error}`;
    if (reason !== waitReason) {
      waitReason = reason;
      if (lock.kind === 'held') logger.info(`Another Codex adapter is running (PID: ${lock.pid}); this one takes over when it stops`);
      else logger.warn(`Codex adapter control endpoint is unavailable (${lock.error}); retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, WAIT_MAX_MS);
  }
}

void takeLock().then((owned) => {
  if (!owned) return;
  logStartup('Codex adapter');
  const { host, port, token } = resolveAdapterHub(config);
  adapter = new CodexAdapter({
    command: config.codex?.command ?? 'codex',
    hub: { host, port, token },
    onFirstConnect: (outcome) => send({ type: 'codex-first-connect', ...outcome }),
  });
  adapter.start();
});
