import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { logger } from '../shared/logger.js';

// Adapter stop may await the 10s handshake before the 11s tree cleanup; leave scheduling headroom.
export const ADAPTER_SHUTDOWN_MS = 25_000;
export const RUN_CLOSE_MS = 15_000;
export const SUPERVISOR_STOP_GRACE_MS = 30_000;
export const CLI_EXIT_FLUSH_MS = 1000;

interface ShutdownOptions {
  signals: EventEmitter;
  stdin?: EventEmitter;
  stop(): Promise<void> | undefined;
  release(): Promise<void> | undefined;
  exit(): void;
}

export function createAdapterShutdown(opts: ShutdownOptions): () => void {
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    // A codex.cmd proxy runs outside the job that ends this process's children on exit, so its kill must finish first.
    const timer = setTimeout(() => {
      logger.warn(`Codex adapter shutdown did not finish within ${ADAPTER_SHUTDOWN_MS}ms; exiting`);
      opts.exit();
    }, ADAPTER_SHUTDOWN_MS);
    const stopped = Promise.resolve().then(opts.stop);
    const released = Promise.resolve().then(opts.release);
    void Promise.allSettled([stopped, released]).then(() => {
      clearTimeout(timer);
      opts.exit();
    });
  };
  opts.signals.on('SIGINT', shutdown);
  opts.signals.on('SIGTERM', shutdown);
  opts.stdin?.on('end', shutdown);
  opts.stdin?.on('close', shutdown);
  return shutdown;
}

export async function closeWithinLimit(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Codex proxy cleanup timed out')), RUN_CLOSE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function exitAfterFlush(code: number, stdout: Pick<Writable, 'write'>, stderr: Pick<Writable, 'write'>, exit: (code: number) => void = process.exit): void {
  let exited = false;
  let remaining = 2;
  const finish = () => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    exit(code);
  };
  const timer = setTimeout(finish, CLI_EXIT_FLUSH_MS);
  const flushed = () => { if (--remaining === 0) finish(); };
  for (const stream of [stdout, stderr]) {
    try { stream.write('', flushed); }
    catch { flushed(); }
  }
}
