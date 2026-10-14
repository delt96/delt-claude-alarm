import type { Engine, HookEvent, On } from 'claude-code';
import {
  COMMAND_TTL_MS, HEARTBEAT_MS, POLL_MS, controlFile, parseCommand, parseJsonText, parseResult, type ControlKind,
} from '../shared/control-protocol.js';

// Claude Code's mod loader only lets $ reach functions declared at the top of this file, so the state travels as an argument.
interface ModState {
  dir: string;
  sessionId: string | null;
  handled: string | null;
  beatAt: number;
  busy: boolean;
  running: boolean;
  ticking: boolean;
}

async function readRecord($: Engine, file: string): Promise<unknown> {
  try {
    return parseJsonText(await $.fs.read(file));
  } catch {
    return undefined;
  }
}

async function writeRecord($: Engine, file: string, value: unknown): Promise<void> {
  try {
    await $.fs.write(file, JSON.stringify(value));
  } catch {}
}

async function execute($: Engine, kind: ControlKind): Promise<string | undefined> {
  try {
    if (kind === 'compact') {
      const result = await $.session.compact();
      return result?.skip ? `skipped: ${String(result.skip)}` : undefined;
    }
    await $.command.run({ command: 'clear' });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function beat($: Engine, s: ModState): Promise<void> {
  const sid = s.sessionId;
  if (!sid) return;
  s.beatAt = await $.clock.now();
  await writeRecord($, controlFile(s.dir, 'alive', sid), { busy: s.busy || s.running, at: s.beatAt });
}

async function answer($: Engine, s: ModState, sid: string, id: string, reason: string | undefined): Promise<void> {
  s.handled = id;
  const at = await $.clock.now();
  await writeRecord($, controlFile(s.dir, 'result', sid), reason === undefined ? { id, ok: true, at } : { id, ok: false, reason, at });
}

async function tick($: Engine, s: ModState): Promise<void> {
  const sid = await $.session.id();
  if (sid !== s.sessionId) {
    s.sessionId = sid;
    s.handled = null;
    s.beatAt = -Infinity;
  }
  if (s.handled === null) s.handled = parseResult(await readRecord($, controlFile(s.dir, 'result', sid)))?.id ?? '';
  const now = await $.clock.now();
  if (now - s.beatAt >= HEARTBEAT_MS) await beat($, s);
  const command = parseCommand(await readRecord($, controlFile(s.dir, 'command', sid)));
  if (!command || command.id === s.handled) return;
  if (now - command.at > COMMAND_TTL_MS) return answer($, s, sid, command.id, 'expired');
  if (s.busy) return answer($, s, sid, command.id, 'busy');
  s.handled = command.id;
  s.running = true;
  let reason: string | undefined;
  try {
    await beat($, s);
    reason = await execute($, command.kind);
  } finally {
    s.running = false;
  }
  // After /clear the id has changed; the channel server still waits on the old id's result file.
  await answer($, s, sid, command.id, reason);
  if (s.sessionId === sid) await beat($, s);
}

async function poll($: Engine, s: ModState): Promise<void> {
  if (s.ticking) return;
  s.ticking = true;
  try {
    await tick($, s);
  } catch {
  } finally {
    s.ticking = false;
  }
}

async function endSession($: Engine, s: ModState): Promise<void> {
  const sid = s.sessionId;
  // Forgetting the id keeps a /clear we ran from beating over the ended record afterwards.
  s.sessionId = null;
  s.busy = false;
  if (s.dir && sid) await writeRecord($, controlFile(s.dir, 'alive', sid), { busy: false, at: await $.clock.now(), ended: true });
}

const isMainTurn = (e: HookEvent) => e.agentId === undefined;

export function register(on: On, options: Readonly<Record<string, unknown>>): void {
  const s: ModState = {
    dir: typeof options.controlDir === 'string' ? options.controlDir.replace(/[\\/]+$/, '') : '',
    sessionId: null,
    handled: null,
    beatAt: -Infinity,
    busy: false,
    running: false,
    ticking: false,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    if (!s.dir || e.isInteractive === false) return result;
    try {
      $.clock.every(POLL_MS, () => void poll($, s));
    } catch {}
    return result;
  });

  on('turn.start', async ($, e, next) => {
    if (s.dir && isMainTurn(e)) {
      s.busy = true;
      void beat($, s).catch(() => {});
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (s.dir && isMainTurn(e)) {
      s.busy = false;
      void beat($, s).catch(() => {});
    }
    return result;
  });

  // After /clear the engine raises no session.start; the next tick picks up the new id.
  on('session.end', async ($, e, next) => {
    try {
      await endSession($, s);
    } catch {}
    return next(e);
  });
}
