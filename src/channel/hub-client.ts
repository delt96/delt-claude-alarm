import WebSocket from 'ws';
import { logger } from '../shared/logger.js';
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, WS_PATH_CHANNEL } from '../shared/constants.js';
import type { ChannelMessage, SessionInfo } from '../shared/types.js';

export class HubClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageHandlers: Array<(msg: ChannelMessage) => void> = [];
  private queue: ChannelMessage[] = [];
  private connected = false;
  private closed = false;
  private features: string[] | null = null;
  private featureWaiters = new Set<(features: string[]) => void>();

  constructor(
    private sessionId: string,
    private sessionName: string,
    private hubHost = DEFAULT_HUB_HOST,
    private hubPort = DEFAULT_HUB_PORT,
    private token?: string,
    private getPeerName: () => string | undefined = () => undefined,
    private getRegistration: () => Partial<SessionInfo> = () => ({}),
  ) {}

  connect(): void {
    this.closed = false;
    const tokenQuery = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const url = `ws://${this.hubHost}:${this.hubPort}${WS_PATH_CHANNEL}${tokenQuery}`;
    logger.debug(`Connecting to hub at ${url}`);

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        logger.info('Connected to hub');
        this.connected = true;

        this.ws!.send(JSON.stringify(this.registration()));

        // Flush queued messages
        for (const msg of this.queue) {
          this.ws!.send(JSON.stringify(msg));
        }
        this.queue = [];
      });

      ws.on('message', (data) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(data.toString()) as ChannelMessage;
          if (msg.type === 'hub_info') this.learnFeatures(msg.features);
          for (const handler of this.messageHandlers) {
            handler(msg);
          }
        } catch (err) {
          logger.warn('Failed to parse hub message:', err);
        }
      });

      ws.on('close', () => {
        if (this.ws !== ws) return;
        logger.info('Disconnected from hub');
        this.connected = false;
        this.features = null;
        if (!this.closed) this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        if (this.ws !== ws) return;
        logger.debug(`Hub connection error: ${err.message}`);
        this.connected = false;
      });
    } catch {
      logger.debug('Failed to connect to hub, will retry');
      this.scheduleReconnect();
    }
  }

  send(msg: ChannelMessage): 'sent' | 'queued' | 'dropped' {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return 'sent';
    }
    if (this.queue.length >= 100) {
      logger.debug('Hub not connected and the queue is full, message dropped');
      return 'dropped';
    }
    this.queue.push(msg);
    logger.debug('Hub not connected, message queued');
    return 'queued';
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  supports(feature: string): boolean {
    return this.features?.includes(feature) ?? false;
  }

  // An older hub sends no hub_info at all, so only the timeout can tell it apart from a slow one.
  waitForSupport(feature: string, ms: number): Promise<boolean> {
    if (this.features) return Promise.resolve(this.features.includes(feature));
    return new Promise((resolve) => {
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        this.featureWaiters.delete(onInfo);
        resolve(ok);
      };
      const onInfo = (features: string[]) => settle(features.includes(feature));
      const timer = setTimeout(() => settle(false), ms);
      this.featureWaiters.add(onInfo);
    });
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.features = null;
  }

  private learnFeatures(features: unknown): void {
    this.features = Array.isArray(features) ? features.filter((f): f is string => typeof f === 'string') : [];
    for (const waiter of [...this.featureWaiters]) waiter(this.features);
  }

  reregister(): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(this.registration()));
    }
  }

  private registration(): ChannelMessage {
    return {
      type: 'register',
      session: {
        id: this.sessionId,
        name: this.sessionName,
        status: 'idle',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        cwd: process.cwd(),
        channelEnabled: true,
        peerName: this.getPeerName(),
        ...this.getRegistration(),
      },
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}
