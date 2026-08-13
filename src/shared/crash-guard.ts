import fs from 'node:fs';
import { CONFIG_DIR, LOG_FILE } from './constants.js';
import { logger } from './logger.js';

const BURST_WINDOW_MS = 60_000;
const BURST_LIMIT = 10;

function appendToLog(text: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, text, 'utf-8');
  } catch {}
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Last-resort net for exceptions no local handler caught.
 *
 * The hub keeps running afterwards: a notification relay that dies silently is
 * worse than one running on possibly-degraded state, and in foreground mode the
 * stack trace would otherwise vanish with the console window. A repeated burst
 * still exits, so a self-feeding error loop cannot spin forever.
 */
export function installCrashGuard(context: string): void {
  let recent: number[] = [];

  const handle = (kind: string, err: unknown): void => {
    const stack = describe(err);
    appendToLog(`\n[${new Date().toISOString()}] ${kind} (${context})\n${stack}\n`);
    logger.error(`${kind} caught by crash guard: ${stack}`);

    const now = Date.now();
    recent = recent.filter((t) => now - t < BURST_WINDOW_MS);
    recent.push(now);

    if (recent.length > BURST_LIMIT) {
      const msg = `${recent.length} unhandled errors within ${BURST_WINDOW_MS / 1000}s — exiting`;
      appendToLog(`[${new Date().toISOString()}] ${msg}\n`);
      logger.error(msg);
      process.exit(1);
    }
  };

  process.on('uncaughtException', (err) => handle('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
}

export function logStartup(context: string): void {
  appendToLog(`\n[${new Date().toISOString()}] ${context} started (pid ${process.pid})\n`);
}
