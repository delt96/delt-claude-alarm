import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import WebSocket, { type ClientOptions } from 'ws';
import { logger } from '../shared/logger.js';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface ProxyConnection {
  ws: WebSocket;
  close(): Promise<void>;
}

// npm installs Codex on Windows as a codex.cmd shim, which only runs through a shell.
export function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; shell: boolean } {
  if (platform !== 'win32') return { file: command, shell: false };
  if (/[\\/]/.test(command) || path.extname(command)) return { file: command, shell: /\.(cmd|bat)$/i.test(command) };
  const file = findCodex(command, platform, env);
  return file ? { file, shell: file.endsWith('.cmd') } : { file: command, shell: false };
}

export function findOnPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const ext of platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
    for (const dir of dirs) {
      const file = path.join(dir, command + ext);
      if (fs.existsSync(file)) return file;
    }
  }
  return undefined;
}

// A terminal opened before Codex was installed keeps its old PATH, so also look where the installers put codex.
export function findCodex(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const onPath = findOnPath(command, platform, env);
  if (onPath || platform !== 'win32') return onPath;
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', `${command}.exe`),
    env.APPDATA && path.join(env.APPDATA, 'npm', `${command}.cmd`),
  ];
  return candidates.find((file): file is string => !!file && fs.existsSync(file));
}

const shellSpawns = new WeakSet<ChildProcess>();

export const spawnedThroughShell = (child: ChildProcess): boolean => shellSpawns.has(child);

export const defaultSpawn: SpawnFn = (command, args) => {
  const { file, shell } = resolveCommand(command);
  if (!shell) return spawn(file, args, { stdio: 'pipe', windowsHide: true });
  const child = spawn(`"${file}" ${args.join(' ')}`, { stdio: 'pipe', windowsHide: true, shell: true });
  shellSpawns.add(child);
  return child;
};

export type KillTreeFn = ((child: ChildProcess) => Promise<void>) & { track?: (child: ChildProcess) => Promise<void> };
export interface ProcessIdentity { pid: number; parentPid: number; creationTime: string }
// systemTime: the system clock, which stamps creation times, read once the processes were listed, and performance.now() when the snapshot arrived.
export type ProcessSnapshot = ProcessIdentity[] & { systemTime?: { nowMs: number; atTicks: number } };
export type ProcessQueryFn = () => Promise<ProcessSnapshot>;
export type ProcessEndFn = (targets: ProcessIdentity[]) => Promise<void>;
type Descendant = ProcessIdentity & { depth: number };

const POWERSHELL_TIMEOUT_MS = 5000;

const powershell = (script: string, env?: NodeJS.ProcessEnv) => new Promise<string>((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout) => {
    if (err) reject(err);
    else resolve(stdout);
  });
});

// Select-Object rather than a [pscustomobject] cast, which Constrained Language Mode (AppLocker/WDAC) refuses.
const QUERY_SCRIPT = "$rows = @(Get-CimInstance Win32_Process | Where-Object CreationDate | Select-Object @{ n = 'pid'; e = { [int]$_.ProcessId } }, @{ n = 'parentPid'; e = { [int]$_.ParentProcessId } }, @{ n = 'creationTime'; e = { $_.CreationDate.ToUniversalTime().ToString('o') } }); @{ rows = $rows; now = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress -Depth 3";

const asMs = (creationTime: string) => Date.parse(`${creationTime.slice(0, 23)}Z`);

// A prelude runs first in the same PowerShell session; tests use it to switch the language mode or stand in for a cmdlet.
export const processQuery = (prelude = ''): ProcessQueryFn => async () => {
  const output = await powershell(prelude + QUERY_SCRIPT);
  const atTicks = performance.now();
  const { rows, now } = (JSON.parse(output) ?? {}) as { rows?: unknown; now?: unknown };
  if (!Array.isArray(rows) || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parentPid) || typeof row.creationTime !== 'string') || typeof now !== 'string') {
    throw new Error('invalid process snapshot');
  }
  return Object.assign(rows as ProcessIdentity[], { systemTime: { nowMs: asMs(now), atTicks } });
};

export const queryProcesses: ProcessQueryFn = processQuery();

// One handle per target both proves its creation time and ends it, so a PID handed to another process meanwhile is never ended.
// Only property reads and cmdlets touch the process: Constrained Language Mode refuses method calls on it.
const END_SCRIPT = [
  'foreach ($t in ($env:CLAUDE_ALARM_END_TARGETS | ConvertFrom-Json)) {',
  '  $p = Get-Process -Id $t.pid -ErrorAction SilentlyContinue',
  // Reading Handle opens the process once, and StartTime, Stop-Process and Wait-Process then use that handle; a getter that throws reads as $null.
  '  if ($null -eq $p -or $null -eq $p.Handle) { "$($t.pid) is gone or cannot be opened"; continue }',
  '  $start = $p.StartTime',
  '  if ($null -eq $start) { "$($t.pid) has no readable creation time"; continue }',
  '  $start = $start.ToUniversalTime()',
  // Win32_Process creation dates stop at microseconds.
  "  if ($start.AddTicks(-($start.Ticks % 10)).ToString('o') -ne $t.creationTime) { \"$($t.pid) now belongs to another process\"; continue }",
  '  try { Stop-Process -InputObject $p -Force -ErrorAction Stop } catch { "$($t.pid) not ended: $($_.FullyQualifiedErrorId)" }',
  // A refused termination usually means the process is already exiting, so it is waited for all the same.
  '  try { Wait-Process -InputObject $p -Timeout 1 -ErrorAction Stop } catch { "$($t.pid) has not exited yet" }',
  '}',
].join('\n');

// Each target gets its own PowerShell and time limit, run side by side, so one that runs long cannot use up the others' turn.
export const processEnder = (prelude = ''): ProcessEndFn => async (targets) => {
  await Promise.all(targets.map(async (target) => {
    try {
      const notes = await powershell(prelude + END_SCRIPT, { ...process.env, CLAUDE_ALARM_END_TARGETS: JSON.stringify([target]) });
      for (const note of notes.split(/\r?\n/)) if (note) logger.debug(`codex process ${note}`);
    } catch (err) {
      logger.debug(`ending codex process ${target.pid} failed: ${(err as { killed?: boolean }).killed ? 'timed out' : String(err)}`);
    }
  }));
};

export const endProcesses: ProcessEndFn = processEnder();

function descendantsOf(root: ProcessIdentity, rows: ProcessIdentity[], childrenBornBefore?: string): Descendant[] {
  const found: Descendant[] = [];
  const seen = new Set([root.pid]);
  let level: ProcessIdentity[] = [root];
  for (let depth = 1; level.length; depth++) {
    const next: ProcessIdentity[] = [];
    for (const parent of level) {
      for (const row of rows) {
        // Windows keeps a dead parent's PID in its children, so a process older than the PID's current owner is not its child.
        if (row.parentPid !== parent.pid || seen.has(row.pid) || row.creationTime < parent.creationTime) continue;
        if (depth === 1 && childrenBornBefore !== undefined && row.creationTime >= childrenBornBefore) continue;
        seen.add(row.pid);
        next.push(row);
        found.push({ ...row, depth });
      }
    }
    level = next;
  }
  return found;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const SHELL_EXIT_WAIT_MS = 1000;
export const PROXY_TREE_CLOSE_BUDGET_MS = 2 * POWERSHELL_TIMEOUT_MS + SHELL_EXIT_WAIT_MS;

const exitOf = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (exited(child)) { resolve(); return; }
  const onExit = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    child.removeListener('exit', onExit);
    logger.debug(`codex proxy shell ${child.pid} has not exited yet`);
    resolve();
  }, SHELL_EXIT_WAIT_MS);
  child.once('exit', onExit);
});

// Where creation times are recorded to the clock tick (up to 15.6 ms), a process started after the shell's exit can read as slightly earlier.
const EXIT_TIME_MARGIN_MS = 100;
const asCreationTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 23)}0000Z`;

const merged = (before: Descendant[], found: Descendant[]) =>
  [...before, ...found.filter(d => !before.some(b => b.pid === d.pid && b.creationTime === d.creationTime))];

interface ShellExit { at: number; atTicks: number }
interface ShellRecord { creationTime?: string; exit?: ShellExit }

export function treeKiller(
  platform: NodeJS.Platform = process.platform,
  end: ProcessEndFn = endProcesses,
  query: ProcessQueryFn = queryProcesses,
  throughShell: (child: ChildProcess) => boolean = spawnedThroughShell,
  clock: () => number = Date.now,
  ticks: () => number = () => performance.now(),
): KillTreeFn {
  const recorded = new WeakMap<ChildProcess, Promise<Descendant[]>>();
  const shells = new WeakMap<ChildProcess, ShellRecord>();
  // No taskkill: it ends whatever holds a PID by then, and its /T builds trees from ParentProcessId alone.
  const endByIdentity = async (descendants: Descendant[]) => {
    if (!descendants.length) return;
    // The default ender ends all targets at once, so this order is not kept; that is safe because each target's identity is checked as it is ended.
    try { await end([...descendants].sort((a, b) => b.depth - a.depth).map(({ depth, ...identity }) => identity)); }
    catch (err) { logger.debug(`ending codex processes failed: ${String(err)}`); }
  };
  const snapshot = async () => {
    try { return await query(); }
    catch (err) { logger.debug(`codex process query failed: ${String(err)}`); return undefined; }
  };
  const isShellTree = (child: ChildProcess) => platform === 'win32' && child.pid !== undefined && throughShell(child);
  const treeOf = (child: ChildProcess, rows: ProcessSnapshot | undefined, begunBeforeExit: boolean): Descendant[] => {
    if (!rows) return [];
    const shell = shells.get(child);
    if (!exited(child)) {
      // Until Node sees the shell exit it holds the shell's handle, so the shell's PID cannot have been reused during the snapshot.
      const root = rows.find(row => row.pid === child.pid);
      if (!root) return [];
      if (shell) shell.creationTime ??= root.creationTime;
      return descendantsOf(root, rows);
    }
    if (!shell?.exit) return [];
    // Two readings of the exit on the system clock that stamps creation times: Date.now() at the exit, and this snapshot's system
    // time less the monotonic time since. A step of that clock after the exit can push only the second past the exit, and a step
    // Date.now() has not caught up with yet (V8 resyncs it within a minute) only the first, so the earlier one is not past it.
    const { at, atTicks } = shell.exit;
    const bySnapshot = rows.systemTime ? rows.systemTime.nowMs - (rows.systemTime.atTicks - atTicks) : Infinity;
    const bornBefore = asCreationTime(Math.min(at, bySnapshot) - EXIT_TIME_MARGIN_MS);
    // Only a snapshot begun before the exit can show the shell itself; whoever holds its PID started either as our shell or after the exit.
    if (begunBeforeExit) shell.creationTime ??= rows.find(row => row.pid === child.pid && row.creationTime < bornBefore)?.creationTime;
    if (!shell.creationTime) return [];
    return descendantsOf({ pid: child.pid!, parentPid: 0, creationTime: shell.creationTime }, rows, bornBefore);
  };
  const killer: KillTreeFn = async (child) => {
    if (!isShellTree(child)) {
      if (!exited(child)) child.kill();
      return;
    }
    // An npm codex.cmd runs the proxy under cmd.exe, and child.kill() would end only cmd.exe.
    const begunBeforeExit = !exited(child);
    const findable = begunBeforeExit || shells.get(child)?.exit !== undefined;
    const [rows, before] = await Promise.all([findable ? snapshot() : undefined, recorded.get(child)]);
    await endByIdentity(merged(before ?? [], treeOf(child, rows, begunBeforeExit)));
    if (exited(child)) return;
    child.kill();
    await exitOf(child);
  };
  killer.track = async (child) => {
    if (!isShellTree(child) || exited(child)) return;
    if (!shells.has(child)) {
      const shell: ShellRecord = {};
      shells.set(child, shell);
      // libuv closes the shell's handle only after the 'exit' listeners have run, so its PID cannot go to another process before this moment.
      child.once('exit', () => { shell.exit = { at: clock(), atTicks: ticks() }; });
    }
    const earlier = recorded.get(child);
    const latest = (async () => {
      const found = treeOf(child, await snapshot(), true);
      return merged((await earlier) ?? [], found);
    })();
    recorded.set(child, latest);
    await latest;
  };
  return killer;
}

export const killTree: KillTreeFn = treeKiller();

// The daemon control socket speaks WebSocket, not JSONL: `codex app-server proxy` only relays bytes.
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export function connectProxy(
  command: string,
  spawnFn: SpawnFn = defaultSpawn,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  killTreeFn: KillTreeFn = killTree,
): Promise<ProxyConnection> {
  const child = spawnFn(command, ['app-server', 'proxy']);
  void killTreeFn.track?.(child);
  child.stdin?.on('error', () => {});
  child.stderr?.on('data', (d) => logger.debug(`codex proxy: ${String(d).trim()}`));

  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (child.stdin?.writable) child.stdin.write(chunk, callback);
      else callback();
    },
    final(callback) {
      child.stdin?.end();
      callback();
    },
  });
  child.stdout?.on('data', (d) => stream.push(d));
  child.stdout?.on('end', () => stream.push(null));
  Object.assign(stream, { setNoDelay() {}, setTimeout() {}, setKeepAlive() {}, ref() {}, unref() {} });

  const ws = new WebSocket('ws://localhost/', {
    createConnection: (() => stream) as unknown as ClientOptions['createConnection'],
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    ws.terminate();
    child.stdin?.end();
    await killTreeFn(child);
  })();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`codex daemon did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void close().then(() => reject(err), () => reject(err));
    };
    child.on('error', fail);
    child.once('exit', (code) => fail(new Error(`codex proxy exited (code ${code})`)));
    ws.on('error', fail);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.on('error', (err) => logger.warn(`codex proxy error: ${err.message}`));
      ws.on('error', (err) => logger.warn(`codex daemon socket error: ${err.message}`));
      // The snapshot taken at spawn can predate the proxy that codex.cmd starts, so record the tree again now that it answers.
      void killTreeFn.track?.(child);
      resolve({ ws, close });
    });
  });
}
