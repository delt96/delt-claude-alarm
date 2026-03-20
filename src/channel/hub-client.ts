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

  constructor(
    private sessionId: string,
    private sessionName: string,
    private hubHost = DEFAULT_HUB_HOST,
    private hubPort = DEFAULT_HUB_PORT,
    private token?: string,
  ) {}

  connect(): void {
    const tokenQuery = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const url = `ws://${this.hubHost}:${this.hubPort}${WS_PATH_CHANNEL}${tokenQuery}`;
    logger.debug(`Connecting to hub at ${url}`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('Connected to hub');
        this.connected = true;

        // Register this session
        const registration: ChannelMessage = {
          type: 'register',
          session: {
            id: this.sessionId,
            name: this.sessionName,
            status: 'idle',
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            cwd: process.cwd(),
          },
        };
        this.ws!.send(JSON.stringify(registration));

        // Flush queued messages
        for (const msg of this.queue) {
          this.ws!.send(JSON.stringify(msg));
        }
        this.queue = [];
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ChannelMessage;
          for (const handler of this.messageHandlers) {
            handler(msg);
          }
        } catch (err) {
          logger.warn('Failed to parse hub message:', err);
        }
      });

      this.ws.on('close', () => {
        logger.info('Disconnected from hub');
        this.connected = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.debug(`Hub connection error: ${err.message}`);
        this.connected = false;
      });
    } catch {
      logger.debug('Failed to connect to hub, will retry');
      this.scheduleReconnect();
    }
  }

  send(msg: ChannelMessage): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      if (this.queue.length < 100) {
        this.queue.push(msg);
      }
      logger.debug('Hub not connected, message queued');
    }
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}
