import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import WebSocket, { type ClientOptions } from 'ws';
import { logger } from '../shared/logger.js';

export type SpawnFn = (command: string, args: string[]) => ChildProcess;

export interface ProxyConnection {
  ws: WebSocket;
  close(): void;
}

// npm installs Codex on Windows as a codex.cmd shim, which only runs through a shell.
export function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; shell: boolean } {
  if (platform !== 'win32' || /[\\/]/.test(command) || path.extname(command)) return { file: command, shell: false };
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

export const defaultSpawn: SpawnFn = (command, args) => {
  const { file, shell } = resolveCommand(command);
  if (shell) return spawn(`"${file}" ${args.join(' ')}`, { stdio: 'pipe', windowsHide: true, shell: true });
  return spawn(file, args, { stdio: 'pipe', windowsHide: true });
};

// The daemon control socket speaks WebSocket, not JSONL: `codex app-server proxy` only relays bytes.
export function connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn): Promise<ProxyConnection> {
  const child = spawnFn(command, ['app-server', 'proxy']);
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
  const close = () => {
    ws.terminate();
    child.kill();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(err);
    };
    child.on('error', fail);
    child.once('exit', (code) => fail(new Error(`codex proxy exited (code ${code})`)));
    ws.on('error', fail);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      child.on('error', (err) => logger.warn(`codex proxy error: ${err.message}`));
      ws.on('error', (err) => logger.warn(`codex daemon socket error: ${err.message}`));
      resolve({ ws, close });
    });
  });
}
