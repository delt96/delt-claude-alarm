import type { OwnerState } from './instance-lock.js';
import type { ChildProcess } from 'node:child_process';
import type { FirstConnect } from './adapter.js';
import type { AdapterHub } from './hub-target.js';

export const ADAPTER_REPORT_TIMEOUT_MS = 10_000;
export const HUB_CHECK_TIMEOUT_MS = 3000;
export const RESTART_HINT = 'After fixing this, restart the adapter: claude-alarm codex stop, then claude-alarm codex start (if the hub started the adapter, restart the hub instead)';

const CONFIG_PATH = '~/.claude-alarm/config.json';
const NOT_CHECKED: Line = { text: 'Codex daemon: not checked (the adapter was already running)', warning: false };

export type AdapterReport =
  | { kind: 'report'; outcome: FirstConnect }
  | { kind: 'already'; pid: number }
  | { kind: 'lockFailed'; error: string }
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; error?: Error }
  | { kind: 'timeout' };

export type HubCheck =
  | { kind: 'ok' }
  | { kind: 'unauthorized' }
  | { kind: 'not-hub'; status: number }
  | { kind: 'unreachable'; reason: string };

export interface Line {
  text: string;
  warning: boolean;
}

function toOutcome(msg: { connected?: unknown; userAgent?: unknown; error?: unknown; notFound?: unknown }): FirstConnect {
  if (msg.connected === true) return typeof msg.userAgent === 'string' ? { connected: true, userAgent: msg.userAgent } : { connected: true };
  return { connected: false, error: String(msg.error ?? ''), notFound: msg.notFound === true };
}

export function waitForAdapterReport(child: ChildProcess, timeoutMs = ADAPTER_REPORT_TIMEOUT_MS): Promise<AdapterReport> {
  return new Promise((resolve) => {
    const finish = (result: AdapterReport) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(result);
    };
    const onMessage = (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (m.type === 'codex-first-connect') finish({ kind: 'report', outcome: toOutcome(m) });
      else if (m.type === 'codex-already-running' && Number.isInteger(m.pid)) finish({ kind: 'already', pid: m.pid as number });
      else if (m.type === 'codex-lock-failed') finish({ kind: 'lockFailed', error: String(m.error ?? '') });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({ kind: 'exited', code, signal });
    const onError = (error: Error) => finish({ kind: 'exited', code: null, signal: null, error });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

export function hubUrl(hub: AdapterHub): string {
  return `http://${hub.host}:${hub.port}`;
}

export async function checkHub(hub: AdapterHub, timeoutMs = HUB_CHECK_TIMEOUT_MS): Promise<HubCheck> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${hubUrl(hub)}/api/status`, {
      headers: hub.token ? { Authorization: `Bearer ${hub.token}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: unknown } };
    return { kind: 'unreachable', reason: typeof e.cause?.code === 'string' ? e.cause.code : e.name };
  }
  if (res.status === 200) {
    try {
      const body = (await res.json()) as { running?: unknown } | null;
      if (body?.running === true) return { kind: 'ok' };
    } catch {}
    return { kind: 'not-hub', status: 200 };
  }
  await res.body?.cancel().catch(() => {});
  return res.status === 401 ? { kind: 'unauthorized' } : { kind: 'not-hub', status: res.status };
}

export function daemonLine(report: Extract<AdapterReport, { kind: 'report' | 'timeout' }>, command: string, logFile: string): Line {
  if (report.kind === 'timeout') {
    return { text: `Codex daemon: no answer within ${ADAPTER_REPORT_TIMEOUT_MS / 1000}s. The adapter keeps trying. See ${logFile}`, warning: true };
  }
  const o = report.outcome;
  if (o.connected) return { text: `Codex daemon: connected (${o.userAgent ?? 'unknown version'})`, warning: false };
  if (o.notFound) {
    return { text: `Codex daemon: "${command}" not found. Install Codex or set "codex.command" in ${CONFIG_PATH}, and run the restart from a new terminal.`, warning: true };
  }
  return { text: `Codex daemon: not connected (${o.error}). Is Codex running? The adapter keeps retrying.`, warning: true };
}

function addressSource(hub: AdapterHub): string {
  const host = hub.fromEnv.host ? 'CLAUDE_ALARM_HUB_HOST' : 'hub.host';
  const port = hub.fromEnv.port ? 'CLAUDE_ALARM_HUB_PORT' : 'hub.port';
  const fromConfig = !hub.fromEnv.host || !hub.fromEnv.port;
  return `${host} and ${port}${fromConfig ? ` in ${CONFIG_PATH}` : ''}`;
}

function tokenSource(hub: AdapterHub): string {
  return hub.fromEnv.token ? 'CLAUDE_ALARM_HUB_TOKEN' : `hub.token in ${CONFIG_PATH}`;
}

export function hubLine(check: HubCheck, hub: AdapterHub): Line {
  const url = hubUrl(hub);
  switch (check.kind) {
    case 'ok':
      return { text: `Hub: reachable at ${url}`, warning: false };
    case 'unauthorized':
      return { text: `Hub: ${url} rejected the token (401). Check ${tokenSource(hub)}.`, warning: true };
    case 'not-hub':
      return { text: `Hub: ${url} answered ${check.status} but is not a claude-alarm hub. Check ${addressSource(hub)}.`, warning: true };
    case 'unreachable':
      return { text: `Hub: not reachable at ${url} (${check.reason}). Check ${addressSource(hub)} and that the hub is running.`, warning: true };
  }
}

export interface StartDeps {
  hub: AdapterHub;
  command: string;
  logFile: string;
  spawnAdapter: () => ChildProcess;
  queryOwner: () => Promise<OwnerState>;
  out: (line: string) => void;
  err: (line: string) => void;
  reportTimeoutMs?: number;
  hubTimeoutMs?: number;
}

function printChecks(d: StartDeps, daemon: Line, hub: Line): void {
  d.out(`  ${daemon.text}`);
  d.out(`  ${hub.text}`);
  if (daemon.warning || hub.warning) d.out(`  ${RESTART_HINT}`);
}

function printAlreadyRunning(d: StartDeps, pid: number, hub: HubCheck): void {
  d.out(`Codex adapter is already running (PID: ${pid})`);
  printChecks(d, NOT_CHECKED, hubLine(hub, d.hub));
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export async function startAdapter(d: StartDeps): Promise<number> {
  const existing = await d.queryOwner();
  if (existing.state === 'running') {
    printAlreadyRunning(d, existing.pid, await checkHub(d.hub, d.hubTimeoutMs));
    return 0;
  }

  const child = d.spawnAdapter();
  const seen: { exit?: Exit } = {};
  // Watched until the very end: an adapter can report and then die while the hub check is still running.
  child.on('exit', (code, signal) => { seen.exit ??= { code, signal }; });
  child.on('error', (error) => { seen.exit ??= { code: null, signal: null, error }; });

  const [report, hub] = await Promise.all([
    waitForAdapterReport(child, d.reportTimeoutMs),
    checkHub(d.hub, d.hubTimeoutMs),
  ]);
  if (child.connected) child.disconnect();
  child.unref();

  if (report.kind === 'already') {
    printAlreadyRunning(d, report.pid, hub);
    return 0;
  }
  if (report.kind === 'lockFailed') {
    d.err(`Codex adapter cannot start: ${report.error}`);
    return 1;
  }
  if (report.kind !== 'exited' && !seen.exit && child.pid !== undefined) {
    d.out(`Codex adapter started (PID: ${child.pid}). Logs: ${d.logFile}`);
    printChecks(d, daemonLine(report, d.command, d.logFile), hubLine(hub, d.hub));
    return 0;
  }

  const exit: Exit | undefined = seen.exit ?? (report.kind === 'exited' ? report : undefined);
  if (!exit || exit.error) {
    d.err(`Codex adapter failed to start: ${exit?.error?.message ?? 'no process id'}`);
    return 1;
  }
  const owner = await d.queryOwner();
  if (owner.state === 'running' && owner.pid !== child.pid) {
    printAlreadyRunning(d, owner.pid, hub);
    return 0;
  }
  const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`;
  d.err(`Codex adapter exited during startup (${how}). See ${d.logFile}`);
  return 1;
}
