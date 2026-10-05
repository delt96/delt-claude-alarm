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
export type ProcessQueryFn = () => Promise<ProcessIdentity[]>;
type Descendant = ProcessIdentity & { depth: number };

export const queryProcesses: ProcessQueryFn = () => new Promise((resolve, reject) => {
  const script = "@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; creationTime = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) { reject(err); return; }
    try {
      const rows: unknown = JSON.parse(stdout);
      if (!Array.isArray(rows) || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parentPid) || typeof row.creationTime !== 'string')) {
        throw new Error('invalid process snapshot');
      }
      resolve(rows);
    } catch (error) { reject(error); }
  });
});
export type RunFn = (file: string, args: string[], options: { windowsHide: boolean }, callback: (err: Error | null) => void) => void;

const runFile: RunFn = (file, args, options, callback) => {
  execFile(file, args, options, (err) => callback(err));
};

function descendantsOf(rootPid: number, rows: ProcessIdentity[]): Descendant[] | undefined {
  const root = rows.find(row => row.pid === rootPid);
  if (!root) return undefined;
  const found: Descendant[] = [];
  const seen = new Set([root.pid]);
  let level: ProcessIdentity[] = [root];
  for (let depth = 1; level.length; depth++) {
    const next: ProcessIdentity[] = [];
    for (const parent of level) {
      for (const row of rows) {
        // Windows keeps a dead parent's PID in its children, so a process older than the PID's current owner is not its child.
        if (row.parentPid !== parent.pid || seen.has(row.pid) || row.creationTime < parent.creationTime) continue;
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

export function treeKiller(
  platform: NodeJS.Platform = process.platform,
  run: RunFn = runFile,
  query: ProcessQueryFn = queryProcesses,
  throughShell: (child: ChildProcess) => boolean = spawnedThroughShell,
): KillTreeFn {
  const recorded = new WeakMap<ChildProcess, Promise<Descendant[]>>();
  const stop = (pid: number) => new Promise<void>((resolve) => {
    // No /T: taskkill builds trees from ParentProcessId alone, so it would also end older processes naming a reused PID as parent.
    run('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, (err) => {
      if (err) logger.debug(`taskkill ${pid} failed: ${err.message}`);
      resolve();
    });
  });
  const stopDeepestFirst = async (descendants: Descendant[]) => {
    for (const descendant of [...descendants].sort((a, b) => b.depth - a.depth)) await stop(descendant.pid);
  };
  const snapshot = async () => {
    try { return await query(); }
    catch (err) { logger.debug(`codex process query failed: ${String(err)}`); return undefined; }
  };
  const isShellTree = (child: ChildProcess) => platform === 'win32' && child.pid !== undefined && throughShell(child);
  const killer: KillTreeFn = async (child) => {
    if (!isShellTree(child)) {
      if (!exited(child)) child.kill();
      return;
    }
    // An npm codex.cmd runs the proxy under cmd.exe, and child.kill() would end only cmd.exe.
    if (!exited(child)) {
      const rows = await snapshot();
      // Until Node sees the shell exit it holds the shell's handle, so the shell's PID cannot have been reused during the snapshot.
      if (!exited(child)) {
        const descendants = rows && descendantsOf(child.pid!, rows);
        if (descendants) await stopDeepestFirst(descendants);
        child.kill();
        return;
      }
    }
    const descendants = (await recorded.get(child)) ?? [];
    if (!descendants.length) return;
    const current = await snapshot();
    if (!current) return;
    // A recorded descendant may have exited and its PID been reused; only the same creation time proves it is the same process.
    await stopDeepestFirst(descendants.filter(d => current.some(row => row.pid === d.pid && row.creationTime === d.creationTime)));
  };
  killer.track = async (child) => {
    if (!isShellTree(child) || exited(child)) return;
    const earlier = recorded.get(child);
    const latest = (async () => {
      const rows = await snapshot();
      // A snapshot that ends after the shell exited may show another process under the shell's reused PID.
      const found = rows && !exited(child) ? descendantsOf(child.pid!, rows) ?? [] : [];
      const before = (await earlier) ?? [];
      return [...before, ...found.filter(d => !before.some(b => b.pid === d.pid && b.creationTime === d.creationTime))];
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
