import http from 'node:http';
import type { Duplex } from 'node:stream';
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
  WS_PATH_CODEX,
  UPLOADS_DIR,
} from '../shared/constants.js';
import { SessionManager } from './session-manager.js';
import { Notifier } from './notifier.js';
import { TelegramBot } from './telegram.js';
import { CodexSupervisor, adapterEnv, resolveAdapterScript } from './codex-supervisor.js';
import { loadConfig, saveConfig } from '../shared/config.js';
import { sessionLabel } from '../shared/session-label.js';
import { installCrashGuard, logStartup } from '../shared/crash-guard.js';
import type { ChannelMessage, AppConfig, SessionInfo, WebhookConfig, TelegramConfig, PermissionChoice, PendingChoiceRequest, CodexAdapterInfo, CodexCall, CodexLinkMessage } from '../shared/types.js';
import { permissionKey } from '../shared/permission-key.js';
import { isEntryScript } from '../shared/entry.js';
import { hubUrlHost } from '../shared/hub-url.js';
import {
  isAuthorized,
  isCrossOrigin,
  isJsonRequest,
  isSecureRequest,
  safeEqual,
  sessionCookieHeader,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 10MB images arrive base64-encoded (~13.4MB) over the dashboard socket.
const MAX_WS_PAYLOAD = 16 * 1024 * 1024;

function validChoices(choices: unknown): PermissionChoice[] | undefined {
  if (!Array.isArray(choices)) return undefined;
  const valid = choices.filter((c): c is PermissionChoice => typeof c?.id === 'string' && typeof c?.label === 'string');
  return valid.length ? valid : undefined;
}

type CodexCallOutcome = { status: number; body: unknown };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

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
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private channelAlive = new Map<string, boolean>(); // sessionId -> alive flag
  private socketOwners = new WeakMap<WebSocket, string>();
  // Codex approvals carry their own choices; a response is forwarded only in the mode of the request it answers.
  private choiceRequests = new Map<string, { request: PendingChoiceRequest; choiceIds: Set<string> }>();

  private host: string;
  private port: number;
  private token?: string;
  private codexEnabled: boolean;
  private codexSupervisor?: CodexSupervisor;
  private wssCodex: WebSocketServer;
  private codexAdapters = new Map<string, { ws: WebSocket; info: CodexAdapterInfo }>();
  private codexAlive = new WeakMap<WebSocket, boolean>();
  private codexCallTimeoutMs: number;
  private codexCalls = new Map<string, { adapterId: string; settle: (outcome: CodexCallOutcome) => void }>();

  constructor(config?: Partial<AppConfig>, options: { codexCallTimeoutMs?: number } = {}) {
    this.codexCallTimeoutMs = options.codexCallTimeoutMs ?? 60_000;
    this.host = config?.hub?.host ?? DEFAULT_HUB_HOST;
    this.port = config?.hub?.port ?? DEFAULT_HUB_PORT;
    this.token = config?.hub?.token;
    this.codexEnabled = config?.codex?.enabled === true;

    if (config?.notifications) {
      this.notifier.configure({
        desktop: config.notifications.desktop,
      });
    }
    if (config?.webhooks) {
      this.notifier.configure({ webhooks: config.webhooks });
    }
    const displayHost = hubUrlHost(this.host);
    this.notifier.configure({ dashboardUrl: `http://${displayHost}:${this.port}` });

    // Initialize Telegram bot if configured
    const fullConfig = loadConfig();
    if (fullConfig.telegram?.enabled && fullConfig.telegram.botToken && fullConfig.telegram.chatId) {
      this.initTelegram(fullConfig.telegram);
    }

    // HTTP Server
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

    // WebSocket for channel servers
    this.wssChannel = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.wssChannel.on('connection', (ws: WebSocket, req: http.IncomingMessage) => this.handleChannelConnection(ws, req));
    this.wssChannel.on('error', (err) => logger.warn(`Channel WebSocket server error: ${err.message}`));

    // WebSocket for dashboard
    this.wssDashboard = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.wssDashboard.on('connection', (ws) => this.handleDashboardConnection(ws));
    this.wssDashboard.on('error', (err) => logger.warn(`Dashboard WebSocket server error: ${err.message}`));

    this.wssCodex = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    this.wssCodex.on('connection', (ws: WebSocket, req: http.IncomingMessage) => this.handleCodexConnection(ws, req));
    this.wssCodex.on('error', (err) => logger.warn(`Codex WebSocket server error: ${err.message}`));

    // Route WebSocket upgrade requests
    this.httpServer.on('upgrade', (req, socket, head) => {
      // Once 'upgrade' has a listener the socket is ours; an unhandled 'error'
      // on it would take the whole process down.
      socket.on('error', (err) => logger.debug(`Upgrade socket error: ${err.message}`));

      const url = new URL(req.url ?? '/', 'http://hub');
      const pathname = url.pathname;

      if (isCrossOrigin(req)) {
        this.rejectUpgrade(socket, 403, 'Forbidden', pathname, req);
        return;
      }
      if (!this.authorized(req, true)) {
        this.rejectUpgrade(socket, 401, 'Unauthorized', pathname, req);
        return;
      }

      if (pathname === WS_PATH_CHANNEL) {
        this.wssChannel.handleUpgrade(req, socket, head, (ws) => {
          this.wssChannel.emit('connection', ws, req);
        });
      } else if (pathname === WS_PATH_DASHBOARD) {
        this.wssDashboard.handleUpgrade(req, socket, head, (ws) => {
          this.wssDashboard.emit('connection', ws, req);
        });
      } else if (pathname === WS_PATH_CODEX) {
        this.wssCodex.handleUpgrade(req, socket, head, (ws) => {
          this.wssCodex.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start(): Promise<void> {
    this.cleanupUploads();
    this.startHeartbeat();
    return new Promise((resolve, reject) => {
      const onStartupError = (err: Error) => reject(err);
      this.httpServer.once('error', onStartupError);
      this.httpServer.listen(this.port, this.host, () => {
        // Past startup a rejected promise is a no-op, so errors must be logged instead
        this.httpServer.removeListener('error', onStartupError);
        this.httpServer.on('error', (err) => logger.error(`HTTP server error: ${err.message}`));
        const displayHost = hubUrlHost(this.host);
        logger.info(`Hub server listening on http://${displayHost}:${this.port}`);
        this.startCodexAdapter();
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.codexSupervisor?.stop();
      this.codexSupervisor = undefined;
      // Stop heartbeat
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

      // Stop telegram bot
      if (this.telegramBot) this.telegramBot.stopPolling();

      // Force-close all WebSocket connections
      for (const ws of this.channelSockets.values()) ws.terminate();
      for (const ws of this.dashboardSockets) ws.terminate();
      for (const { ws } of this.codexAdapters.values()) ws.terminate();
      this.channelSockets.clear();
      this.dashboardSockets.clear();

      this.wssChannel.close();
      this.wssDashboard.close();
      this.wssCodex.close();
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
    const url = new URL(req.url ?? '/', 'http://hub');

    if (isCrossOrigin(req)) {
      this.jsonResponse(res, 403, { error: 'Cross-origin request rejected' });
      return;
    }
    if (req.method === 'POST' && !isJsonRequest(req)) {
      this.jsonResponse(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    if (url.pathname === '/' && req.method === 'GET') {
      this.serveDashboard(req, res, url);
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      this.handleLogin(req, res);
      return;
    }
    if (!this.authorized(req, false)) {
      this.jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Route
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      this.jsonResponse(res, 200, { sessions: this.sessions.getAll() });
    } else if (url.pathname === '/api/status' && req.method === 'GET') {
      this.jsonResponse(res, 200, {
        running: true,
        pid: process.pid,
        port: this.port,
        sessions: this.sessions.count(),
        uptime: Date.now() - this.startTime,
      });
    } else if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sessionId = url.pathname.slice('/api/sessions/'.length);
      const ws = this.channelSockets.get(sessionId);
      if (ws) { ws.terminate(); }
      const session = this.sessions.unregister(sessionId);
      this.channelSockets.delete(sessionId);
      this.localChannels.delete(sessionId);
      this.channelAlive.delete(sessionId);
      this.expireChoices(sessionId);
      if (session) {
        this.broadcastToDashboards({ type: 'session_disconnected', sessionId });
        this.jsonResponse(res, 200, { ok: true });
      } else {
        this.jsonResponse(res, 404, { error: 'Session not found' });
      }
    } else if (url.pathname === '/api/send' && req.method === 'POST') {
      this.handleApiSend(req, res);
    } else if (url.pathname === '/api/notify' && req.method === 'POST') {
      this.handleApiNotify(req, res);
    } else if (url.pathname === '/api/codex/folders' && req.method === 'GET') {
      this.handleCodexFolders(url, res);
    } else if (url.pathname === '/api/codex/threads' && req.method === 'POST') {
      this.handleCodexCreate(req, res);
    } else if (url.pathname === '/api/codex/threads/close' && req.method === 'POST') {
      this.handleCodexClose(req, res);
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
    } else if (url.pathname === '/api/telegram/detect' && req.method === 'POST') {
      this.handleTelegramDetect(req, res);
    } else {
      this.jsonResponse(res, 404, { error: 'Not found' });
    }
  }

  private serveDashboard(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const linkToken = url.searchParams.get('token');
    if (linkToken !== null && this.token && safeEqual(linkToken, this.token)) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookieHeader(this.token, isSecureRequest(req)) });
      res.end();
      return;
    }
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

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req) as { token?: unknown } | null;
    if (!this.token) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (typeof body?.token !== 'string' || !safeEqual(body.token, this.token)) {
      this.jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }
    res.writeHead(204, { 'Set-Cookie': sessionCookieHeader(this.token, isSecureRequest(req)) });
    res.end();
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

    const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'api' };
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

    // ws emits 'error' for protocol violations and socket failures; without a
    // listener Node rethrows it and kills the hub. 'close' still follows, so
    // session cleanup is handled there.
    ws.on('error', (err) => {
      logger.warn(`Channel WebSocket error: ${err.message}`);
      ws.terminate();
    });

    // Track pong responses for heartbeat
    ws.on('pong', () => {
      for (const [sessionId, sock] of this.channelSockets) {
        if (sock === ws) { this.channelAlive.set(sessionId, true); break; }
      }
    });

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
          this.channelAlive.delete(sessionId);
          this.expireChoices(sessionId);
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
    if (msg.type === 'register') {
      const id = msg.session.id;
      const owned = this.socketOwners.get(ws);
      if (owned && owned !== id) {
        logger.warn(`Rejected register for ${id}: connection already owns ${owned}`);
        return;
      }
      // A channel that reconnects after sleep or a network change reuses its id
      // while the hub may still see the old socket as open until the heartbeat
      // fires; the newest connection must win or the session is lost.
      const holder = this.channelSockets.get(id);
      if (holder && holder !== ws) {
        this.socketOwners.delete(holder);
        holder.terminate();
      }
      this.socketOwners.set(ws, id);
    } else if ('sessionId' in msg && this.socketOwners.get(ws) !== msg.sessionId) {
      return;
    }

    switch (msg.type) {
      case 'register': {
        const session = msg.session;
        session.isLocal = isLocal;
        const isReregister = !!this.sessions.get(session.id);
        this.sessions.register(session);
        this.channelSockets.set(session.id, ws);
        if (isLocal) this.localChannels.add(session.id);
        logger.info(`Session registered: ${session.id} (${session.name}, channel: ${session.channelEnabled ?? false}, peer: ${session.peerName ?? '-'})`);
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

      case 'peer_name': {
        const updated = this.sessions.setPeerName(msg.sessionId, msg.peerName);
        if (updated) {
          logger.info(`Peer name for ${msg.sessionId}: ${msg.peerName ?? '-'}`);
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
        this.notifier.notifyWithSession(msg.sessionId, replyLabel, `[${replyLabel}] Reply`, msg.content.slice(0, 3000), 'info');
        this.broadcastToDashboards({
          type: 'reply_from_session',
          sessionId: msg.sessionId,
          content: msg.content,
          timestamp: Date.now(),
        });
        break;
      }

      case 'permission_request': {
        this.sessions.updateActivity(msg.sessionId);
        const choices = validChoices(msg.choices);
        logger.info(`Permission request [${msg.requestId}] from ${msg.sessionId}: ${msg.toolName}`);
        if (choices) {
          this.choiceRequests.set(permissionKey(msg.sessionId, msg.requestId), {
            request: {
              sessionId: msg.sessionId,
              requestId: msg.requestId,
              toolName: msg.toolName,
              description: msg.description,
              inputPreview: msg.inputPreview,
              timestamp: msg.timestamp,
              choices,
            },
            choiceIds: new Set(choices.map((c) => c.id)),
          });
        }
        this.broadcastToDashboards({
          type: 'permission_request',
          sessionId: msg.sessionId,
          requestId: msg.requestId,
          toolName: msg.toolName,
          description: msg.description,
          inputPreview: msg.inputPreview,
          timestamp: msg.timestamp,
          ...(choices ? { choices } : {}),
        });
        // Forward to Telegram
        if (this.telegramBot) {
          const label = this.getSessionLabel(this.sessions.get(msg.sessionId));
          if (choices) {
            void this.telegramBot.sendChoiceRequest(msg.sessionId, label, msg.requestId, msg.toolName, msg.description, msg.inputPreview, choices);
          } else {
            this.telegramBot.sendPermissionRequest(msg.sessionId, label, msg.requestId, msg.toolName, msg.description, msg.inputPreview);
          }
        }
        break;
      }

      case 'permission_resolved': {
        this.resolveChoice(msg.sessionId, msg.requestId, msg.state === 'expired' ? 'expired' : 'resolved');
        break;
      }
    }
  }

  private handleCodexConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const isLocal = this.isLocalRequest(req);
    let adapterId: string | undefined;
    ws.on('error', (err) => {
      logger.warn(`Codex adapter WebSocket error: ${err.message}`);
      ws.terminate();
    });
    ws.on('pong', () => this.codexAlive.set(ws, true));
    ws.on('message', (data) => {
      let msg: CodexLinkMessage;
      try {
        msg = JSON.parse(data.toString()) as CodexLinkMessage;
        if (msg === null || typeof msg !== 'object') {
          logger.warn('Invalid message from Codex adapter');
          return;
        }
      } catch {
        logger.warn('Invalid message from Codex adapter');
        return;
      }
      if (msg.type === 'adapter_hello') {
        const a = msg.adapter;
        if (typeof a?.id !== 'string' || !a.id || typeof a.host !== 'string') return;
        if (adapterId && adapterId !== a.id) return;
        // An adapter that reconnects keeps its id while the hub may still hold the dead socket; the newest wins.
        const holder = this.codexAdapters.get(a.id);
        if (holder && holder.ws !== ws) holder.ws.terminate();
        if (!adapterId) logger.info(`Codex adapter connected: ${a.host} (${a.id}, local: ${isLocal})`);
        adapterId = a.id;
        this.codexAdapters.set(a.id, { ws, info: { id: a.id, host: a.host, ready: a.ready === true, isLocal } });
        this.broadcastCodexAdapters();
      } else if (msg.type === 'adapter_result' && adapterId) {
        const call = this.codexCalls.get(msg.requestId);
        if (!call || call.adapterId !== adapterId) return;
        call.settle(msg.ok ? { status: 200, body: msg.data } : { status: 422, body: { error: String(msg.error) } });
      }
    });
    ws.on('close', () => {
      if (!adapterId || this.codexAdapters.get(adapterId)?.ws !== ws) return;
      this.codexAdapters.delete(adapterId);
      for (const call of [...this.codexCalls.values()]) {
        if (call.adapterId === adapterId) call.settle({ status: 502, body: { error: 'Codex adapter disconnected' } });
      }
      logger.info(`Codex adapter disconnected: ${adapterId}`);
      this.broadcastCodexAdapters();
    });
  }

  private callCodexAdapter(adapterId: string, call: CodexCall): Promise<CodexCallOutcome> {
    const adapter = this.codexAdapters.get(adapterId);
    if (!adapter || adapter.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ status: 404, body: { error: 'Codex adapter is not connected' } });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ status: 504, body: { error: 'Codex did not respond in time. The conversation may still appear.' } }),
        this.codexCallTimeoutMs,
      );
      const settle = (outcome: CodexCallOutcome) => {
        clearTimeout(timer);
        this.codexCalls.delete(requestId);
        resolve(outcome);
      };
      this.codexCalls.set(requestId, { adapterId, settle });
      adapter.ws.send(JSON.stringify({ type: 'adapter_call', requestId, call } satisfies CodexLinkMessage));
    });
  }

  private async handleCodexFolders(url: URL, res: http.ServerResponse): Promise<void> {
    const adapterId = url.searchParams.get('adapterId');
    if (!nonEmpty(adapterId)) {
      this.jsonResponse(res, 400, { error: 'adapterId is required' });
      return;
    }
    const out = await this.callCodexAdapter(adapterId, { kind: 'folders' });
    this.jsonResponse(res, out.status, out.body);
  }

  private async handleCodexCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as { adapterId?: unknown; cwd?: unknown } | null;
    const adapterId = body?.adapterId;
    const cwd = body?.cwd;
    if (!nonEmpty(adapterId) || !nonEmpty(cwd)) {
      this.jsonResponse(res, 400, { error: 'adapterId and cwd are required' });
      return;
    }
    const out = await this.callCodexAdapter(adapterId, { kind: 'create', cwd });
    this.jsonResponse(res, out.status, out.body);
  }

  private async handleCodexClose(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as { sessionId?: unknown } | null;
    const sessionId = body?.sessionId;
    if (!nonEmpty(sessionId)) {
      this.jsonResponse(res, 400, { error: 'sessionId is required' });
      return;
    }
    const session = this.sessions.get(sessionId);
    const ws = this.channelSockets.get(sessionId);
    if (session?.agentKind !== 'codex' || !session.closable || ws?.readyState !== WebSocket.OPEN) {
      this.jsonResponse(res, 404, { error: 'No closable Codex conversation' });
      return;
    }
    ws.send(JSON.stringify({ type: 'codex_close', sessionId } satisfies ChannelMessage));
    this.jsonResponse(res, 200, { ok: true });
  }

  private codexAdapterList(): CodexAdapterInfo[] {
    return [...this.codexAdapters.values()].map((a) => a.info);
  }

  private broadcastCodexAdapters(): void {
    this.broadcastToDashboards({ type: 'codex_adapters', adapters: this.codexAdapterList() });
  }

  // --- Dashboard WebSocket ---

  private handleDashboardConnection(ws: WebSocket): void {
    this.dashboardSockets.add(ws);
    logger.info(`Dashboard connected (total: ${this.dashboardSockets.size})`);

    ws.on('error', (err) => {
      logger.warn(`Dashboard WebSocket error: ${err.message}`);
      ws.terminate();
    });

    // Send current session list
    const sessionsMsg: ChannelMessage = {
      type: 'sessions_list',
      sessions: this.sessions.getAll(),
    };
    ws.send(JSON.stringify(sessionsMsg));
    const pendingMsg: ChannelMessage = {
      type: 'permission_pending',
      requests: [...this.choiceRequests.values()].map((c) => c.request),
    };
    ws.send(JSON.stringify(pendingMsg));
    ws.send(JSON.stringify({ type: 'codex_adapters', adapters: this.codexAdapterList() } satisfies ChannelMessage));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ChannelMessage;
        if (msg.type === 'message_to_session') {
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
          }
        } else if (msg.type === 'image_upload') {
          this.handleImageUpload(ws, msg);
        } else if (msg.type === 'permission_response') {
          if (this.forwardPermissionResponse(msg)) {
            const verdict = msg.choiceId !== undefined ? `choice ${msg.choiceId}` : msg.behavior;
            logger.info(`Permission verdict [${msg.requestId}]: ${verdict} -> session ${msg.sessionId}`);
          }
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

  private forwardPermissionResponse(msg: { sessionId: string; requestId: string; behavior?: unknown; choiceId?: unknown }): boolean {
    const pending = this.choiceRequests.get(permissionKey(msg.sessionId, msg.requestId));
    let out: ChannelMessage;
    if (pending) {
      if (typeof msg.choiceId !== 'string' || !pending.choiceIds.has(msg.choiceId)) return false;
      out = { type: 'permission_response', sessionId: msg.sessionId, requestId: msg.requestId, choiceId: msg.choiceId };
    } else {
      if ((msg.behavior !== 'allow' && msg.behavior !== 'deny') || msg.choiceId !== undefined) return false;
      if (this.sessions.get(msg.sessionId)?.agentKind === 'codex') return false;
      out = { type: 'permission_response', sessionId: msg.sessionId, requestId: msg.requestId, behavior: msg.behavior };
    }
    const channelWs = this.channelSockets.get(msg.sessionId);
    if (channelWs?.readyState !== WebSocket.OPEN) return false;
    channelWs.send(JSON.stringify(out));
    return true;
  }

  private resolveChoice(sessionId: string, requestId: string, state: 'resolved' | 'expired'): void {
    if (!this.choiceRequests.delete(permissionKey(sessionId, requestId))) return;
    this.broadcastToDashboards({ type: 'permission_resolved', sessionId, requestId, state });
    void this.telegramBot?.resolveChoiceRequest(sessionId, requestId, state);
  }

  private expireChoices(sessionId: string): void {
    for (const pending of [...this.choiceRequests.values()]) {
      if (pending.request.sessionId === sessionId) this.resolveChoice(sessionId, pending.request.requestId, 'expired');
    }
  }

  private broadcastToDashboards(msg: ChannelMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.dashboardSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private handleImageUpload(ws: WebSocket, msg: ChannelMessage & { type: 'image_upload' }): void {
    const { sessionId, imageData, mimeType, originalName, content } = msg;
    const reject = (reason: string) => {
      logger.warn(`Image upload rejected for ${sessionId}: ${reason}`);
      const rejected: ChannelMessage = { type: 'upload_rejected', sessionId, reason };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(rejected));
    };

    const channelWs = this.channelSockets.get(sessionId);
    if (!channelWs || channelWs.readyState !== WebSocket.OPEN) {
      reject('the session is not connected');
      return;
    }
    if (!this.localChannels.has(sessionId)) {
      reject("this session is on another PC; images can only go to sessions on the hub's PC");
      return;
    }

    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(mimeType)) {
      reject('only PNG, JPEG, GIF and WebP images are supported');
      return;
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      reject('the image is larger than 10 MB');
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
      content,
      source: 'dashboard',
    };
    channelWs.send(JSON.stringify(forwardMsg));
    logger.info(`Image saved and forwarded: ${filename} (${buffer.length} bytes)`);

    // Cleanup after 5 minutes
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 5 * 60 * 1000).unref();
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
        const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
        channelWs.send(JSON.stringify(msg));
        logger.info(`Telegram message forwarded to session: ${sessionId}`);
      }
    };
    this.telegramBot.onImageToSession = (sessionId, imagePath, mimeType, caption) => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState === WebSocket.OPEN) {
        const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
        channelWs.send(JSON.stringify(msg));
        logger.info(`Telegram photo forwarded to session: ${sessionId}`);
      }
    };
    this.telegramBot.onPermissionVerdict = (sessionId, requestId, behavior) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, behavior })) {
        logger.info(`Telegram permission verdict [${requestId}]: ${behavior} -> session ${sessionId}`);
      }
      // Also notify dashboards so they can dismiss the permission bar
      this.broadcastToDashboards({ type: 'permission_response', sessionId, requestId, behavior });
    };
    this.telegramBot.onChoiceVerdict = (sessionId, requestId, choiceId) => {
      if (this.forwardPermissionResponse({ sessionId, requestId, choiceId })) {
        logger.info(`Telegram choice [${requestId}]: ${choiceId} -> session ${sessionId}`);
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
    // If botToken is masked (contains '...'), keep the existing token
    if (telegram.botToken.includes('...') && config.telegram?.botToken) {
      telegram.botToken = config.telegram.botToken;
    }
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

  private async handleTelegramDetect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body) { this.jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }
    const { botToken } = body as { botToken?: string };
    if (!botToken) {
      this.jsonResponse(res, 400, { error: 'botToken required' });
      return;
    }

    try {
      const detectRes = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?timeout=0&limit=10`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!detectRes.ok) {
        const err = await detectRes.json() as { description?: string };
        this.jsonResponse(res, 400, { error: (err as any).description || 'Invalid bot token' });
        return;
      }

      const data = await detectRes.json() as { ok: boolean; result: Array<{ message?: { chat: { id: number; first_name?: string; title?: string; type: string } } }> };
      if (!data.ok || !data.result.length) {
        this.jsonResponse(res, 200, { ok: false, chats: [] });
        return;
      }

      // Extract unique chats
      const chatMap = new Map<string, { id: string; name: string; type: string }>();
      for (const update of data.result) {
        if (update.message?.chat) {
          const chat = update.message.chat;
          const id = String(chat.id);
          if (!chatMap.has(id)) {
            chatMap.set(id, {
              id,
              name: chat.title || chat.first_name || id,
              type: chat.type,
            });
          }
        }
      }

      this.jsonResponse(res, 200, { ok: true, chats: [...chatMap.values()] });
    } catch (err) {
      this.jsonResponse(res, 500, { error: (err as Error).message });
    }
  }

  private startCodexAdapter(): void {
    if (!this.codexEnabled) return;
    const script = resolveAdapterScript(__dirname);
    if (!script) {
      logger.warn('Codex adapter is enabled but codex/main.js was not found next to the hub');
      return;
    }
    this.codexSupervisor = new CodexSupervisor(script, { env: adapterEnv(process.env, { host: this.host, port: this.port }) });
    this.codexSupervisor.start();
    logger.info('Codex adapter started');
  }

  private startHeartbeat(): void {
    // Ping channel WebSockets every 30s, terminate unresponsive ones
    this.heartbeatInterval = setInterval(() => {
      for (const [sessionId, ws] of this.channelSockets) {
        if (this.channelAlive.get(sessionId) === false) {
          // No pong received since last ping — terminate
          logger.info(`Heartbeat timeout, terminating session: ${sessionId}`);
          ws.terminate();
          continue;
        }
        this.channelAlive.set(sessionId, false);
        ws.ping();
      }
      for (const { ws } of this.codexAdapters.values()) {
        if (this.codexAlive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        this.codexAlive.set(ws, false);
        ws.ping();
      }
    }, 30000);
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
    return session ? sessionLabel(session) : 'unknown';
  }

  private jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private authorized(req: http.IncomingMessage, allowQueryToken: boolean): boolean {
    return !this.token || isAuthorized(req, this.token, allowQueryToken);
  }

  private rejectUpgrade(socket: Duplex, status: number, text: string, pathname: string, req: http.IncomingMessage): void {
    logger.warn(`Rejected ${pathname} upgrade (${status}) from ${req.socket.remoteAddress}`);
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
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

// Not import.meta.url: dist/cli.js bundles this module, so that check would also pass inside the CLI and start a second hub.
if (isEntryScript(process.argv[1], ['/hub/server.js', '/hub/server.ts'])) {
  installCrashGuard('hub daemon');
  logStartup('Hub daemon');
  const config = loadConfig();
  const hub = new HubServer(config);
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
