import type { OwnerState, StopResult } from './instance-lock.js';

export const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;

export interface ControlDeps {
  queryOwner: () => Promise<OwnerState>;
  requestStop: () => Promise<StopResult>;
  legacyPid: () => number | undefined;
  isRunning: (pid: number) => boolean;
  removeLegacyPidFile: () => void;
  legacyPidFile: string;
  configFile: string;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  stopWaitMs?: number;
}

export function legacyNote(d: Pick<ControlDeps, 'legacyPid' | 'isRunning' | 'removeLegacyPidFile' | 'legacyPidFile' | 'out'>, ownerPid?: number): void {
  const pid = d.legacyPid();
  if (pid === undefined || pid === ownerPid) return;
  if (!d.isRunning(pid)) {
    d.removeLegacyPidFile();
    return;
  }
  d.out(`Note: ${d.legacyPidFile} names a running process (PID: ${pid}). claude-alarm 1.2.0 and earlier wrote this file; if that process is an old Codex adapter, restart the hub or end it yourself.`);
}

function unavailable(d: ControlDeps, error: string): number {
  d.err(`Codex adapter control endpoint is unavailable: ${error}`);
  return 1;
}

export async function stopAdapter(d: ControlDeps, startWithHub: boolean): Promise<number> {
  const owner = await d.queryOwner();
  if (owner.state === 'unknown') return unavailable(d, owner.error);
  if (owner.state === 'absent') {
    d.out('Codex adapter is not running');
    legacyNote(d);
    return 0;
  }
  const reply = await d.requestStop();
  if (reply.state === 'unknown') return unavailable(d, reply.error);
  if (reply.state === 'unauthorized') {
    d.err(`Codex adapter refused to stop: the token in ${d.configFile} does not match the one it started with`);
    return 1;
  }
  if (reply.state === 'absent') {
    d.out('Codex adapter is not running');
    return 0;
  }
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < (d.stopWaitMs ?? STOP_WAIT_MS); waited += STOP_POLL_MS) {
    await sleep(STOP_POLL_MS);
    const now = await d.queryOwner();
    // A waiting hub adapter may take over later; a different PID still means this one stopped.
    if (now.state === 'absent' || (now.state === 'running' && now.pid !== reply.pid)) {
      d.out(`Codex adapter stopped (PID: ${reply.pid})`);
      if (now.state === 'running') d.out(`Another Codex adapter took over (PID: ${now.pid})`);
      else if (startWithHub) d.out('If the hub started it, the hub will not start it again until you restart the hub.');
      return 0;
    }
  }
  d.err(`Stop requested, but the Codex adapter (PID: ${reply.pid}) is still running. Check with: claude-alarm codex status`);
  return 1;
}

export async function adapterStatus(d: ControlDeps, startWithHub: boolean): Promise<number> {
  const owner = await d.queryOwner();
  if (owner.state === 'running') {
    d.out(`Codex adapter: running (PID: ${owner.pid})`);
    legacyNote(d, owner.pid);
  } else if (owner.state === 'unknown') {
    d.out(`Codex adapter: unknown (${owner.error})`);
  } else {
    d.out('Codex adapter: not running');
    legacyNote(d);
  }
  d.out(`Start with hub: ${startWithHub ? 'enabled' : 'disabled'}`);
  return 0;
}
