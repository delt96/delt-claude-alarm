import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { logger } from '../shared/logger.js';

export type RpcId = number | string;

export class RpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();

  constructor(private ws: WebSocket, private timeoutMs = 30_000) {
    super();
    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id: RpcId, result: unknown): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ id, result }));
  }

  // ws stops reading the socket for good if a 'message' listener throws.
  private guarded(method: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.warn(`Codex ${method} handling failed: ${(err as Error).message}`);
    }
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.guarded(msg.method, () => this.emit('request', msg.id, msg.method, msg.params));
    } else if (msg.method !== undefined) {
      this.guarded(msg.method, () => this.emit('notification', msg.method, msg.params));
    }
  }
}
