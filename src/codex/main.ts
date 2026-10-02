import fs from 'node:fs';
import { loadConfig } from '../shared/config.js';
import { CODEX_PID_FILE } from '../shared/constants.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import { logger } from '../shared/logger.js';
import { CodexAdapter } from './adapter.js';
import { resolveAdapterHub } from './hub-target.js';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

installCrashGuard('codex adapter');
// Once the hub is gone its pipes break; without listeners every log line would become an uncaught EPIPE.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const config = loadConfig();

const existing = fs.existsSync(CODEX_PID_FILE) ? parseInt(fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim(), 10) : NaN;
if (!Number.isNaN(existing) && existing !== process.pid && isRunning(existing)) {
  logger.info(`Codex adapter already running (PID: ${existing})`);
  process.exit(0);
}
fs.writeFileSync(CODEX_PID_FILE, String(process.pid), 'utf-8');
logStartup('Codex adapter');

const { host, port, token } = resolveAdapterHub(config);

const adapter = new CodexAdapter({
  command: config.codex?.command ?? 'codex',
  hub: { host, port, token },
  onFirstConnect: (outcome) => {
    if (!process.send || !process.connected) return;
    // With a callback, a channel that closes between the check and the send reports here instead of throwing.
    process.send({ type: 'codex-first-connect', ...outcome }, undefined, undefined, (err: Error | null) => {
      if (err) logger.debug(`First-connect report not delivered: ${err.message}`);
    });
  },
});
adapter.start();

let exiting = false;
const shutdown = () => {
  if (exiting) return;
  exiting = true;
  adapter.stop();
  try {
    if (fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim() === String(process.pid)) fs.unlinkSync(CODEX_PID_FILE);
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// On Windows `hub stop` kills the hub without running its exit handlers, so stdin EOF is the only sign the parent is gone.
if (process.argv.includes('--watch-stdin')) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
