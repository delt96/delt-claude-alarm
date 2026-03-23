import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../shared/logger.js';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_HUB_HOST,
  DEFAULT_HUB_PORT,
  WS_PATH_CHANNEL,
  WS_PATH_DASHBOARD,
  UPLOADS_DIR,
} from '../shared/constants.js';
import { SessionManager } from './session-manager.js';
import { Notifier } from './notifier.js';
import { TelegramBot } from './telegram.js';
import { loadConfig, saveConfig } from '../shared/config.js';
import type { ChannelMessage, AppConfig, SessionInfo, WebhookConfig, TelegramConfig } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class HubServer {
  private httpServer: http.Server;
  private wssChannel: WebSocketServer;
  private wssDashboard: WebSocketServer;
  private sessions = new SessionManager();
  private notifier = new Notifier();
  private startTime = Date.now();

  // Map sessionId -> channel WebSocket
  private channelSockets = new Map<string, WebSocket>();
  // Track which channel connections are local
  private localChannels = new Set<string>();
  // All connected dashboard WebSockets
  private dashboardSockets = new Set<WebSocket>();

  private telegramBot?: TelegramBot;

  private host: string;
  private port: number;
  private token?: string;

  constructor(config?: Partial<AppConfig>) {
    this.host = config?.hub?.host ?? DEFAULT_HUB_HOST;
    this.port = config?.hub?.port ?? DEFAULT_HUB_PORT;
    this.token = config?.hub?.token;

    if (config?.notifications) {
      this.notifier.configure({
        desktop: config.notifications.desktop,
      });
    }
    if (config?.webhooks) {
      this.notifier.configure({ webhooks: config.webhooks });
    }
    const displayHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    this.notifier.configure({ dashboardUrl: `http://${displayHost}:${this.port}` });

    // Initialize Telegram bot if configured
    const fullConfig = loadConfig();
    if (fullConfig.telegram?.enabled && fullConfig.telegram.botToken && fullConfig.telegram.chatId) {
      this.initTelegram(fullConfig.telegram);
    }

    // HTTP Server
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

    // WebSocket for channel servers
    this.wssChannel = new WebSocketServer({ noServer: true });
    this.wssChannel.on('connection', (ws: WebSocket, req: http.IncomingMessage) => this.handleChannelConnection(ws, req));

    // WebSocket for dashboard
    this.wssDashboard = new WebSocketServer({ noServer: true });
    this.wssDashboard.on('connection', (ws) => this.handleDashboardConnection(ws));

    // Route WebSocket upgrade requests
    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // Token auth for WebSocket connections (skip for local requests)
      if (this.token && !this.isLocalRequest(req)) {
        const wsToken = url.searchParams.get('token');
        if (wsToken !== this.token) {
          socket.destroy();
          return;
        }
      }

      if (pathname === WS_PATH_CHANNEL) {
        this.wssChannel.handleUpgrade(req, socket, head, (ws) => {
          this.wssChannel.emit('connection', ws, req);
        });
      } else if (pathname === WS_PATH_DASHBOARD) {
        this.wssDashboard.handleUpgrade(req, socket, head, (ws) => {
          this.wssDashboard.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start(): Promise<void> {
    this.cleanupUploads();
    return new Promise((resolve, reject) => {
      this.httpServer.on('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        const displayHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
        logger.info(`Hub server listening on http://${displayHost}:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Stop telegram bot
      if (this.telegramBot) this.telegramBot.stopPolling();

      // Force-close all WebSocket connections
      for (const ws of this.channelSockets.values()) ws.terminate();
      for (const ws of this.dashboardSockets) ws.terminate();
      this.channelSockets.clear();
      this.dashboardSockets.clear();

      this.wssChannel.close();
      this.wssDashboard.close();
      this.httpServer.close(() => {
        logger.info('Hub server stopped');
        resolve();
      });

      // Force resolve after 3 seconds if server won't close
      setTimeout(() => {
        logger.warn('Force shutting down');
        resolve();
      }, 3000);
    });
  }

  // --- HTTP Handler ---

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // CORS headers - restrict to same origin
    const origin = req.headers.origin;
    if (origin && (origin.includes('127.0.0.1') || origin.includes('localhost'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Token auth for API endpoints (skip dashboard HTML serving)
    if (url.pathname !== '/' && this.token) {
      if (!this.isLocalRequest(req)) {
        const authHeader = req.headers['authorization'];
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (bearerToken !== this.token) {
          this.jsonResponse(res, 401, { error: 'Unauthorized' });
          return;
        }
      }
    }

    // Route
    if (url.pathname === '/' && req.method === 'GET') {
      this.serveDashboard(res);
    } else if (url.pathname === '/api/sessions' && req.method === 'GET') {
      this.jsonResponse(res, 200, { sessions: this.sessions.getAll() });
    } else if (url.pathname === '/api/status' && req.method === 'GET') {
      this.jsonResponse(res, 200, {
        running: true,
        pid: process.pid,
        port: this.port,
        sessions: this.sessions.count(),
        uptime: Date.now() - this.startTime,
      });
    } else if (url.pathname === '/api/send' && req.method === 'POST') {
      this.handleApiSend(req, res);
    } else if (url.pathname === '/api/notify' && req.method === 'POST') {
      this.handleApiNotify(req, res);
    } else if (url.pathname === '/api/webhooks' && req.method === 'GET') {
      const config = loadConfig();
      this.jsonResponse(res, 200, { webhooks: config.webhooks || [] });
    } else if (url.pathname === '/api/webhooks' && req.method === 'POST') {
      this.handleWebhookSave(req, res);
    } else if (url.pathname === '/api/telegram' && req.method === 'GET') {
      const cfg = loadConfig();
      const tg = cfg.telegram ?? { botToken: '', chatId: '', enabled: false };
      // Mask bot token for security
      this.jsonResponse(res, 200, {
        telegram: { ...tg, botToken: tg.botToken ? `${tg.botToken.slice(0, 8)}...` : '' },
      });
    } else if (url.pathname === '/api/telegram' && req.method === 'POST') {
      this.handleTelegramSave(req, res);
    } else if (url.pathname === '/api/telegram/test' && req.method === 'POST') {
      this.handleTelegramTest(req, res);
    } else {
      this.jsonResponse(res, 404, { error: 'Not found' });
    }
  }

  private serveDashboard(res: http.ServerResponse): void {
    // Look for dashboard HTML relative to this file (dist) or source
    const candidates = [
      path.join(__dirname, '..', 'dashboard', 'index.html'),       // from dist/hub/
      path.join(__dirname, 'dashboard', 'index.html'),             // from dist/ (bundled index.js)
      path.join(__dirname, '..', '..', 'src', 'dashboard', 'index.html'), // from dist/hub/ -> src/
      path.join(__dirname, '..', 'src', 'dashboard', 'index.html'),       // from dist/ -> src/
      path.join(process.cwd(), 'dist', 'dashboard', 'index.html'),  // from cwd
      path.join(process.cwd(), 'src', 'dashboard', 'index.html'),   // from cwd/src
    ];
    logger.debug(`Dashboard candidates: ${JSON.stringify(candidates)}`);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const html = fs.readFileSync(candidate, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>claude-alarm</h1><p>Dashboard HTML not found. Reinstall the package.</p></body></html>');
  }

  private async handleApiSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }

    const { sessionId, content } = body as { sessionId?: string; content?: string };
    if (!sessionId || !content) {
      this.jsonResponse(res, 400, { error: 'sessionId and content are required' });
      return;
    }

    const ws = this.channelSockets.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.jsonResponse(res, 404, { error: 'Session not connected' });
      return;
    }

    const msg: ChannelMessage = { type: 'message_to_session', sessionId, content };
    ws.send(JSON.stringify(msg));
    this.jsonResponse(res, 200, { ok: true });
  }

  private async handleApiNotify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }

    const { title, message, level } = body as { title?: string; message?: string; level?: string };
    if (!title || !message) {
      this.jsonResponse(res, 400, { error: 'title and message are required' });
      return;
    }

    await this.notifier.notify(title, message, (level as any) ?? 'info');
    this.jsonResponse(res, 200, { ok: true });
  }

  // --- Channel WebSocket ---

  private handleChannelConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const isLocal = this.isLocalRequest(req);
    logger.info(`Channel server connected (local: ${isLocal})`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ChannelMessage;
        this.handleChannelMessage(ws, isLocal, msg);
      } catch {
        logger.warn('Invalid message from channel');
      }
    });

    ws.on('close', () => {
      // Find and remove the session for this socket
      for (const [sessionId, sock] of this.channelSockets) {
        if (sock === ws) {
          const session = this.sessions.unregister(sessionId);
          this.channelSockets.delete(sessionId);
          this.localChannels.delete(sessionId);
          logger.info(`Channel disconnected: ${sessionId}`);
          this.broadcastToDashboards({
            type: 'session_disconnected',
            sessionId,
          });
          break;
        }
      }
    });
  }

  private handleChannelMessage(ws: WebSocket, isLocal: boolean, msg: ChannelMessage): void {
    switch (msg.type) {
      case 'register': {
        const session = msg.session;
        session.isLocal = isLocal;
        const isReregister = !!this.sessions.get(session.id);
        this.sessions.register(session);
        this.channelSockets.set(session.id, ws);
        if (isLocal) this.localChannels.add(session.id);
        logger.info(`Session registered: ${session.id} (${session.name}, channel: ${session.channelEnabled ?? false})`);
        this.broadcastToDashboards({
          type: isReregister ? 'session_updated' : 'session_connected',
          session,
        });
        break;
      }

      case 'status': {
        const updated = this.sessions.updateStatus(msg.sessionId, msg.status);
        if (updated) {
          this.broadcastToDashboards({ type: 'session_updated', session: updated });
        }
        break;
      }

      case 'notify': {
        this.sessions.updateActivity(msg.sessionId);
        const notifySession = this.sessions.get(msg.sessionId);
        const notifyLabel = this.getSessionLabel(notifySession);
        this.notifier.notifyWithSession(msg.sessionId, notifyLabel, `[${notifyLabel}] ${msg.title}`, msg.message, msg.level ?? 'info');
        this.broadcastToDashboards({
          type: 'notification',
          sessionId: msg.sessionId,
          title: msg.title,
          message: msg.message,
          level: msg.level,
          timestamp: Date.now(),
        });
        break;
      }

      case 'reply': {
        this.sessions.updateActivity(msg.sessionId);
        const replySession = this.sessions.get(msg.sessionId);
        const replyLabel = this.getSessionLabel(replySession);
        this.notifier.notifyWithSession(msg.sessionId, replyLabel, `[${replyLabel}] Reply`, msg.content.slice(0, 200), 'info');
        this.broadcastToDashboards({
          type: 'reply_from_session',
          sessionId: msg.sessionId,
          content: msg.content,
          timestamp: Date.now(),
        });
        break;
      }
    }
  }

  // --- Dashboard WebSocket ---

  private handleDashboardConnection(ws: WebSocket): void {
    this.dashboardSockets.add(ws);
    logger.info(`Dashboard connected (total: ${this.dashboardSockets.size})`);

    // Send current session list
    const sessionsMsg: ChannelMessage = {
      type: 'sessions_list',
      sessions: this.sessions.getAll(),
    };
    ws.send(JSON.stringify(sessionsMsg));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ChannelMessage;
        if (msg.type === 'message_to_session') {
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify(msg));
          }
        } else if (msg.type === 'image_upload') {
          this.handleImageUpload(msg);
        }
      } catch {
        logger.warn('Invalid message from dashboard');
      }
    });

    ws.on('close', () => {
      this.dashboardSockets.delete(ws);
      logger.info(`Dashboard disconnected (total: ${this.dashboardSockets.size})`);
    });
  }

  // --- Helpers ---

  private broadcastToDashboards(msg: ChannelMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private handleImageUpload(msg: ChannelMessage & { type: 'image_upload' }): void {
    const { sessionId, imageData, mimeType, originalName } = msg;

    // Only allow for local sessions
    if (!this.localChannels.has(sessionId)) {
      logger.warn(`Image upload rejected: session ${sessionId} is not local`);
      return;
    }

    const channelWs = this.channelSockets.get(sessionId);
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) return;

    // Validate mime type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) return;

    // Extract base64 data (remove data URL prefix if present)
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Validate size (10MB max)
    if (buffer.length > 10 * 1024 * 1024) {
      logger.warn('Image upload rejected: exceeds 10MB');
      return;
    }

    // Save to uploads dir
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const filename = `${randomUUID()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    // Forward file path to channel
    const forwardMsg: ChannelMessage = {
      type: 'image_to_session',
      sessionId,
      imagePath: filePath,
      mimeType,
      originalName,
    };
    channelWs.send(JSON.stringify(forwardMsg));
    logger.info(`Image saved and forwarded: ${filename} (${buffer.length} bytes)`);

    // Cleanup after 5 minutes
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 5 * 60 * 1000);
  }

  private async handleWebhookSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }
    const { webhooks } = body as { webhooks?: WebhookConfig[] };
    if (!Array.isArray(webhooks)) { this.jsonResponse(res, 400, { error: 'webhooks must be an array' }); return; }
    const config = loadConfig();
    config.webhooks = webhooks;
    saveConfig(config);
    this.notifier.configure({ webhooks });
    this.jsonResponse(res, 200, { ok: true });
  }

  private initTelegram(config: TelegramConfig): void {
    this.telegramBot = new TelegramBot(config);
    this.telegramBot.getSessions = () => this.sessions.getAll();
    this.telegramBot.onMessageToSession = (sessionId, content) => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState === WebSocket.OPEN) {
        const msg: ChannelMessage = { type: 'message_to_session', sessionId, content };
        channelWs.send(JSON.stringify(msg));
        logger.info(`Telegram message forwarded to session: ${sessionId}`);
      }
    };
    this.notifier.configure({ telegramBot: this.telegramBot });
    this.telegramBot.startPolling();
    logger.info('Telegram bot initialized');
  }

  private async handleTelegramSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }
    const { telegram } = body as { telegram?: TelegramConfig };
    if (!telegram) { this.jsonResponse(res, 400, { error: 'telegram config required' }); return; }

    const config = loadConfig();
    config.telegram = telegram;
    saveConfig(config);

    // Stop existing bot if running
    if (this.telegramBot) {
      this.telegramBot.stopPolling();
      this.telegramBot = undefined;
      this.notifier.configure({ telegramBot: undefined as any });
    }

    // Start new bot if enabled
    if (telegram.enabled && telegram.botToken && telegram.chatId) {
      this.initTelegram(telegram);
    }

    this.jsonResponse(res, 200, { ok: true });
  }

  private async handleTelegramTest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }
    const { botToken, chatId } = body as { botToken?: string; chatId?: string };
    if (!botToken || !chatId) {
      this.jsonResponse(res, 400, { error: 'botToken and chatId required' });
      return;
    }

    try {
      const testRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'Claude Alarm test message! Connection successful.',
        }),
      });

      if (testRes.ok) {
        this.jsonResponse(res, 200, { ok: true });
      } else {
        const err = await testRes.json() as { description?: string };
        this.jsonResponse(res, 400, { error: (err as any).description || 'Telegram API error' });
      }
    } catch (err) {
      this.jsonResponse(res, 500, { error: (err as Error).message });
    }
  }

  private cleanupUploads(): void {
    try {
      if (!fs.existsSync(UPLOADS_DIR)) return;
      const files = fs.readdirSync(UPLOADS_DIR);
      for (const file of files) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, file)); } catch {}
      }
      if (files.length > 0) logger.info(`Cleaned up ${files.length} leftover upload(s)`);
    } catch {}
  }

  private getSessionLabel(session?: SessionInfo): string {
    if (!session) return 'unknown';
    return session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  }

  private jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private isLocalRequest(req: http.IncomingMessage): boolean {
    const addr = req.socket.remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  private readBody(req: http.IncomingMessage, maxSize = 1024 * 1024): Promise<unknown | null> {
    return new Promise((resolve) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          resolve(null);
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
  }
}

// Direct execution support
if (process.argv[1] && (
  process.argv[1].endsWith('hub/server.js') ||
  process.argv[1].endsWith('hub/server.ts')
)) {
  const hub = new HubServer();
  hub.start().catch((err) => {
    logger.error('Failed to start hub:', err);
    process.exit(1);
  });

  const shutdown = () => {
    hub.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
