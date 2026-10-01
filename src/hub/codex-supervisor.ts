import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../shared/logger.js';

export type SupervisorSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const HEALTHY_RUN_MS = 60_000;

// dist/hub/server.js runs standalone, but dist/cli.js bundles the hub inline, so both layouts occur.
export function resolveAdapterScript(baseDir: string): string | undefined {
  return [path.join(baseDir, '..', 'codex', 'main.js'), path.join(baseDir, 'codex', 'main.js')].find((p) => fs.existsSync(p));
}

export class CodexSupervisor {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private delay: number;

  constructor(
    private script: string,
    private spawnFn: SupervisorSpawn = spawn,
    private minDelayMs = 2000,
    private maxDelayMs = 60_000,
    private stopGraceMs = 3000,
  ) {
    this.delay = minDelayMs;
  }

  start(): void {
    this.stopped = false;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin?.end();
    const force = setTimeout(() => child.kill(), this.stopGraceMs);
    force.unref();
    child.once('exit', () => clearTimeout(force));
  }

  private launch(): void {
    const startedAt = Date.now();
    // Detached: on Windows a non-detached child shares the hub's kill-on-close job and dies before it can remove codex.pid. Piped: a detached child cannot write to the hub's console (EBADF).
    const child = this.spawnFn(process.execPath, [this.script, '--watch-stdin'], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
    child.stdin?.on('error', () => {});
    child.on('error', (err) => logger.warn(`Codex adapter failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped || code === 0) return;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.delay = this.minDelayMs;
      logger.warn(`Codex adapter exited (${signal ?? code}); restarting in ${this.delay}ms`);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.stopped) this.launch();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, this.maxDelayMs);
    });
  }
}
