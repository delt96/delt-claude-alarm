import fs from 'node:fs';
import path from 'node:path';
import type { ChannelMessage, SessionControlState } from '../shared/types.js';
import {
  ALIVE_STALE_MS, COMMAND_TTL_MS, POLL_MS, controlFile, isSafeId, parseAdvice, parseAlive, parseJsonText, parseResult,
  type AliveRecord, type ControlKind,
} from '../shared/control-protocol.js';
import { writeJsonAtomic } from '../shared/json-file.js';

export const SESSION_CONTROL_FEATURE = 'session_control';

// Two more mod polls past the command's lifetime, so an 'expired' answer still arrives before we give up.
const ANSWER_WAIT_MS = COMMAND_TTL_MS + 2 * POLL_MS;
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

interface ControlHub {
  supports(feature: string): boolean;
  send(msg: ChannelMessage): unknown;
}

export interface SessionControlOptions {
  controlDir: string;
  adviceDir: string;
  claudeSessionId: () => string | undefined;
  now?: () => number;
}

function readRecord(file: string): unknown {
  try {
    return parseJsonText(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function remove(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

export class SessionControl {
  private last: string | undefined;
  private lastSid: string | undefined;
  private swept = false;
  private lastAlive: { sid: string; alive: AliveRecord } | undefined;
  private readonly pending = new Map<string, { sid: string; at: number }>();
  private readonly now: () => number;

  constructor(
    private readonly hub: ControlHub,
    private readonly sessionId: string,
    private readonly opts: SessionControlOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  refresh(): void {
    if (!this.hub.supports(SESSION_CONTROL_FEATURE)) return;
    const now = this.now();
    if (!this.swept) {
      this.swept = true;
      this.sweepOldFiles();
    }
    this.collectResults(now);
    const sid = this.currentSession();
    if (this.lastSid && this.lastSid !== sid) this.forget(this.lastSid, now);
    this.lastSid = sid;
    const control = sid ? this.stateOf(sid, now) : null;
    const key = JSON.stringify(control);
    if (key === this.last) return;
    this.last = key;
    this.hub.send({ type: 'session_control', sessionId: this.sessionId, control });
  }

  // A new hub connection starts with no control state for this session.
  reset(): void {
    this.last = undefined;
  }

  command(requestId: unknown, kind: ControlKind): void {
    if (!isSafeId(requestId)) return;
    const fail = (reason: string) => this.reply(requestId, false, reason);
    const sid = this.currentSession();
    if (!sid) return fail('the Claude Code session was not found');
    // The hub's busy flag lags the mod by a poll, so a second tab could otherwise overwrite a command the mod is about to run.
    if ([...this.pending.values()].some((p) => p.sid === sid)) return fail('a command is already running in this session');
    const now = this.now();
    const alive = this.aliveOf(sid, now);
    if (!alive) return fail('the claude-alarm mod is not running in this session');
    if (alive.busy) return fail('the session is busy');
    try {
      writeJsonAtomic(controlFile(this.opts.controlDir, 'command', sid), { id: requestId, kind, at: now });
    } catch (err) {
      return fail(`could not write the command: ${(err as Error).message}`);
    }
    this.pending.set(requestId, { sid, at: now });
  }

  private reply(requestId: string, ok: boolean, reason?: string): void {
    this.hub.send({ type: 'session_command_result', sessionId: this.sessionId, requestId, ok, ...(reason === undefined ? {} : { reason }) });
  }

  private currentSession(): string | undefined {
    try {
      const sid = this.opts.claudeSessionId();
      return isSafeId(sid) ? sid : undefined;
    } catch {
      return undefined;
    }
  }

  // The mod has no atomic write, so a read can catch a half-written file; that keeps the last good record.
  private aliveOf(sid: string, now: number): AliveRecord | null {
    const file = controlFile(this.opts.controlDir, 'alive', sid);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : this.fresh(this.cached(sid), now);
    }
    const alive = parseAlive(parseJsonText(text));
    if (!alive) return this.fresh(this.cached(sid), now);
    this.lastAlive = { sid, alive };
    if (alive.ended) {
      remove(file);
      return null;
    }
    return this.fresh(alive, now);
  }

  private cached(sid: string): AliveRecord | null {
    return this.lastAlive?.sid === sid ? this.lastAlive.alive : null;
  }

  private fresh(alive: AliveRecord | null, now: number): AliveRecord | null {
    return alive && !alive.ended && now - alive.at <= ALIVE_STALE_MS ? alive : null;
  }

  private stateOf(sid: string, now: number): SessionControlState | null {
    const alive = this.aliveOf(sid, now);
    if (!alive) return null;
    const advice = parseAdvice(readRecord(path.join(this.opts.adviceDir, `${sid}.json`)));
    return advice?.kind ? { busy: alive.busy, advice: advice.kind } : { busy: alive.busy };
  }

  private collectResults(now: number): void {
    for (const [requestId, p] of this.pending) {
      const result = parseResult(readRecord(controlFile(this.opts.controlDir, 'result', p.sid)));
      if (result?.id === requestId) {
        this.settle(requestId, p.sid);
        this.reply(requestId, result.ok, result.ok ? undefined : (result.reason ?? 'failed'));
      } else if (now - p.at > ANSWER_WAIT_MS) {
        this.settle(requestId, p.sid);
        this.reply(requestId, false, 'no answer from the session');
      }
    }
  }

  // After /clear the old id is never read again; a command still waiting on it keeps its files until settle().
  private forget(sid: string, now: number): void {
    if ([...this.pending.values()].some((p) => p.sid === sid)) return;
    const alive = parseAlive(readRecord(controlFile(this.opts.controlDir, 'alive', sid)));
    if (alive && !alive.ended && now - alive.at <= ALIVE_STALE_MS) return;
    for (const kind of ['command', 'result', 'alive'] as const) remove(controlFile(this.opts.controlDir, kind, sid));
  }

  // A session that exits takes its channel server with it, so nobody reads its ended record; sweep leftovers once per start.
  private sweepOldFiles(): void {
    const cutoff = Date.now() - SWEEP_AGE_MS;
    for (const kind of ['alive', 'command', 'result']) {
      const dir = path.join(this.opts.controlDir, kind);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) remove(file);
        } catch {}
      }
    }
  }

  // The command goes first: a reloaded mod reads the result file to skip a command it already ran.
  private settle(requestId: string, sid: string): void {
    this.pending.delete(requestId);
    remove(controlFile(this.opts.controlDir, 'command', sid));
    remove(controlFile(this.opts.controlDir, 'result', sid));
  }
}
