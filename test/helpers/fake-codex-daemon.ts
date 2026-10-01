import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SpawnFn } from '../../src/codex/transport.js';

const PROXY = fileURLToPath(new URL('../fixtures/fake-codex-proxy.mjs', import.meta.url));

type Handler = (params: any) => unknown;
export interface Received { method: string; params: any; id?: number | string }

export class FakeDaemon {
  readonly received: Received[] = [];
  readonly responses: Array<{ id: number | string; result?: any; error?: any }> = [];
  connections = 0;
  private handlers = new Map<string, Handler>();
  private wss?: WebSocketServer;
  private client?: WebSocket;

  async start(): Promise<void> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    wss.on('connection', (ws) => {
      this.client = ws;
      this.connections++;
      ws.on('message', (data) => this.onMessage(ws, JSON.parse(String(data))));
    });
    this.wss = wss;
    this.handle('initialize', () => ({ userAgent: 'fake-codex/0' }));
  }

  get url(): string {
    const addr = this.wss?.address();
    return `ws://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
  }

  readonly spawnFn: SpawnFn = (_command, args) =>
    spawn(process.execPath, [PROXY, ...args], {
      stdio: 'pipe',
      env: { ...process.env, FAKE_CODEX_CONTROL: this.url },
    });

  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  notify(method: string, params: unknown): void {
    this.client?.send(JSON.stringify({ method, params }));
  }

  serverRequest(id: number, method: string, params: unknown): void {
    this.client?.send(JSON.stringify({ id, method, params }));
  }

  dropClient(): void {
    this.client?.terminate();
    this.client = undefined;
  }

  calls(method: string): Received[] {
    return this.received.filter((r) => r.method === method);
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private onMessage(ws: WebSocket, m: any): void {
    if (m.method === undefined) {
      if (m.id !== undefined) this.responses.push(m.error ? { id: m.id, error: m.error } : { id: m.id, result: m.result });
      return;
    }
    this.received.push({ method: m.method, params: m.params, id: m.id });
    if (m.id === undefined) return;
    const reply = (body: object) => ws.send(JSON.stringify({ id: m.id, ...body }));
    const handler = this.handlers.get(m.method);
    if (!handler) {
      reply({ error: { code: -32601, message: `no handler for ${m.method}` } });
      return;
    }
    try {
      reply({ result: handler(m.params) });
    } catch (err) {
      reply({ error: { code: -32600, message: (err as Error).message } });
    }
  }
}

export async function until<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
