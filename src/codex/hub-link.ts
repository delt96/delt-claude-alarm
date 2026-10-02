import WebSocket from 'ws';
import { WS_PATH_CODEX } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { CodexCall, CodexLinkMessage } from '../shared/types.js';

export class CodexHubLink {
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = true;
  private ready = false;

  constructor(
    private hub: { host: string; port: number; token?: string },
    private identity: { id: string; host: string },
    private onCall: (call: CodexCall) => Promise<unknown>,
    private reconnectMs = 5000,
    private pingTimeoutMs = 75_000,
  ) {}

  connect(): void {
    this.closed = false;
    const query = this.hub.token ? `?token=${encodeURIComponent(this.hub.token)}` : '';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${this.hub.host}:${this.hub.port}${WS_PATH_CODEX}${query}`);
    } catch (err) {
      logger.debug(`Codex hub link failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.armWatchdog(ws);
      this.hello();
    });
    ws.on('ping', () => this.armWatchdog(ws));
    ws.on('message', (data) => {
      if (this.ws === ws) this.onMessage(String(data));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.clearWatchdog();
      this.ws = null;
      this.scheduleReconnect();
    });
    ws.on('error', (err) => logger.debug(`Codex hub link error: ${err.message}`));
  }

  setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    this.hello();
  }

  disconnect(): void {
    this.closed = true;
    this.clearWatchdog();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private hello(): void {
    this.send({ type: 'adapter_hello', adapter: { ...this.identity, ready: this.ready } });
  }

  private send(msg: CodexLinkMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string): void {
    let msg: CodexLinkMessage;
    try {
      msg = JSON.parse(text) as CodexLinkMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'adapter_call') return;
    const { requestId, call } = msg;
    this.onCall(call).then(
      (data) => this.send({ type: 'adapter_result', requestId, ok: true, data }),
      (err) => this.send({ type: 'adapter_result', requestId, ok: false, error: (err as Error).message }),
    );
  }

  private clearWatchdog(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private armWatchdog(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.clearWatchdog();
    // The hub pings every 30 s, so two missed pings mean it already dropped this socket.
    this.pingTimer = setTimeout(() => {
      if (this.ws === ws) ws.terminate();
    }, this.pingTimeoutMs);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.reconnectMs);
  }
}
