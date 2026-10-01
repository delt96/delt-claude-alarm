import { randomUUID } from 'node:crypto';
import { HubClient } from '../channel/hub-client.js';
import { CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { ChannelMessage, MessageSource, NotifyLevel, SessionInfo } from '../shared/types.js';
import { connectProxy, type ProxyConnection, type SpawnFn } from './transport.js';
import { RpcClient, type RpcId } from './rpc.js';
import { approvalView, fileChanges, type ApprovalChoice, type ApprovalView, type FileChange } from './approvals.js';
import {
  codexSessionId,
  finalAnswer,
  hubStatus,
  isTrackable,
  threadTitle,
  withSourcePrefix,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';

export interface CodexAdapterOptions {
  command: string;
  hub: { host: string; port: number; token?: string };
  spawnFn?: SpawnFn;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  idleReleaseMs?: number;
}

interface Tracked {
  thread: CodexThread;
  hub: HubClient;
  subscribed: boolean;
  wantSubscribed: boolean;
  sync: Promise<void>;
  pendingTurn: boolean;
  turns: Map<string, AgentMessage[]>;
  releaseTimer?: ReturnType<typeof setTimeout>;
  unrelayed: boolean;
  files: Map<string, FileChange[]>;
}

// Requests a person must answer that claude-alarm cannot relay; the user is pointed back to Codex.
const USER_REQUESTS = new Set(['item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);

interface PendingApproval {
  threadId: string;
  rpcId: RpcId;
  turnId?: string;
  choices: ApprovalChoice[];
  answered: boolean;
}

export class CodexAdapter {
  private conn?: ProxyConnection;
  private rpc?: RpcClient;
  private threads = new Map<string, Tracked>();
  private approvals = new Map<string, PendingApproval>();
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private delay: number;

  constructor(private opts: CodexAdapterOptions) {
    this.delay = opts.reconnectMinMs ?? 2000;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const id of [...this.threads.keys()]) this.drop(id);
    this.conn?.close();
  }

  private async connect(): Promise<void> {
    let rpc: RpcClient | undefined;
    try {
      const conn = await connectProxy(this.opts.command, this.opts.spawnFn);
      if (this.stopped) {
        conn.close();
        return;
      }
      const live = new RpcClient(conn.ws);
      rpc = live;
      live.on('notification', (method: string, params: any) => this.onNotification(method, params));
      live.on('request', (id: RpcId, method: string, params: any) => this.onServerRequest(id, method, params));
      live.on('close', () => {
        if (this.rpc === live) this.onDaemonLost();
      });
      this.conn = conn;
      this.rpc = live;
      const init = await live.request<{ userAgent?: string }>('initialize', {
        clientInfo: { name: 'claude-alarm', version: CHANNEL_SERVER_VERSION },
      });
      live.notify('initialized');
      logger.info(`Connected to Codex daemon (${init.userAgent ?? 'unknown version'})`);
      await this.discover();
      this.delay = this.opts.reconnectMinMs ?? 2000;
    } catch (err) {
      logger.warn(`Codex daemon connection failed: ${(err as Error).message}`);
      if (rpc && this.rpc === rpc) {
        this.rpc = undefined;
        this.conn?.close();
        this.conn = undefined;
      }
      for (const id of [...this.threads.keys()]) this.drop(id);
      this.scheduleRetry();
    }
  }

  private onDaemonLost(): void {
    this.rpc = undefined;
    this.conn?.close();
    this.conn = undefined;
    for (const id of [...this.threads.keys()]) this.drop(id);
    if (!this.stopped) logger.warn('Codex daemon connection lost');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, this.opts.reconnectMaxMs ?? 60_000);
  }

  private async discover(): Promise<void> {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.rpc!.request<{ data: string[]; nextCursor?: string | null }>(
        'thread/loaded/list',
        cursor ? { cursor } : {},
      );
      ids.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) await this.refresh(id);
  }

  private async refresh(threadId: string): Promise<void> {
    try {
      const { thread } = await this.rpc!.request<{ thread: CodexThread }>('thread/read', { threadId, includeTurns: false });
      this.upsert(thread);
    } catch (err) {
      logger.debug(`thread/read ${threadId} failed: ${(err as Error).message}`);
    }
  }

  private upsert(thread: CodexThread): void {
    if (!isTrackable(thread)) {
      this.drop(thread.id);
      return;
    }
    const existing = this.threads.get(thread.id);
    if (existing) {
      existing.thread = thread;
      existing.hub.reregister();
    } else {
      const { host, port, token } = this.opts.hub;
      const hub = new HubClient(codexSessionId(thread.id), threadTitle(thread), host, port, token, () => undefined, () =>
        this.registration(thread.id),
      );
      this.threads.set(thread.id, {
        thread,
        hub,
        subscribed: false,
        wantSubscribed: false,
        sync: Promise.resolve(),
        pendingTurn: false,
        turns: new Map(),
        unrelayed: false,
        files: new Map(),
      });
      hub.onMessage((msg) => this.onHubMessage(thread.id, msg));
      hub.connect();
    }
    void this.want(thread.id, thread.status.type === 'active');
  }

  private registration(threadId: string): Partial<SessionInfo> {
    const t = this.threads.get(threadId);
    if (!t) return {};
    const title = threadTitle(t.thread);
    return { name: title, title, cwd: t.thread.cwd, agentKind: 'codex', status: hubStatus(t.thread.status) };
  }

  private want(threadId: string, subscribed: boolean): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) return Promise.resolve();
    t.wantSubscribed = subscribed;
    t.sync = t.sync.then(() => this.syncSubscription(t));
    return t.sync;
  }

  private async syncSubscription(t: Tracked): Promise<void> {
    const threadId = t.thread.id;
    if (!this.rpc || this.threads.get(threadId) !== t || t.subscribed === t.wantSubscribed) return;
    try {
      if (t.wantSubscribed) {
        // Only these two fields: any other resume field overrides the user's own thread settings.
        await this.rpc.request('thread/resume', { threadId, excludeTurns: true });
        t.subscribed = true;
        t.unrelayed = false;
      } else {
        // The daemon unloads a conversation 60 s after its last subscriber leaves; staying subscribed would keep closed Codex windows alive.
        await this.rpc.request('thread/unsubscribe', { threadId });
        t.subscribed = false;
      }
    } catch (err) {
      logger.debug(`subscription sync for ${threadId} deferred: ${(err as Error).message}`);
    }
  }

  private releaseLater(t: Tracked): void {
    clearTimeout(t.releaseTimer);
    t.releaseTimer = setTimeout(() => {
      t.releaseTimer = undefined;
      if (this.threads.get(t.thread.id) === t && t.thread.status.type !== 'active' && !t.pendingTurn) {
        void this.want(t.thread.id, false);
      }
    }, this.opts.idleReleaseMs ?? 1000);
  }

  private drop(threadId: string): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    for (const [requestId, a] of this.approvals) {
      if (a.threadId === threadId) this.finishApproval(requestId, 'expired');
    }
    this.threads.delete(threadId);
    clearTimeout(t.releaseTimer);
    t.releaseTimer = undefined;
    t.hub.disconnect();
  }

  private onNotification(method: string, params: any): void {
    switch (method) {
      case 'thread/started':
        this.upsert(params.thread);
        break;
      case 'thread/status/changed':
        this.onStatus(params.threadId, params.status);
        break;
      case 'thread/name/updated': {
        const t = this.threads.get(params.threadId);
        if (t) {
          t.thread.name = params.threadName;
          t.hub.reregister();
        }
        break;
      }
      case 'thread/closed':
      case 'thread/archived':
      case 'thread/deleted':
        this.drop(params.threadId);
        break;
      case 'item/started':
        if (params.item?.type === 'fileChange') this.threads.get(params.threadId)?.files.set(params.item.id, fileChanges(params.item));
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') this.collect(params.threadId, params.turnId, params.item);
        if (params.item?.type === 'fileChange') this.threads.get(params.threadId)?.files.delete(params.item.id);
        break;
      case 'serverRequest/resolved':
        this.onResolved(params.threadId, params.requestId);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params.threadId, params.turn);
        break;
    }
  }

  private onStatus(threadId: string, status: CodexThreadStatus): void {
    const t = this.threads.get(threadId);
    if (!t) {
      if (status.type !== 'notLoaded') void this.refresh(threadId);
      return;
    }
    if (status.type === 'notLoaded') {
      this.drop(threadId);
      return;
    }
    t.thread.status = status;
    t.pendingTurn = false;
    t.hub.send({ type: 'status', sessionId: codexSessionId(threadId), status: hubStatus(status) });
    if (status.type === 'systemError') this.notify(threadId, 'Codex error', 'The Codex conversation hit a system error.', 'error');
    if (status.type === 'active') {
      void this.want(threadId, true);
      return;
    }
    if (t.unrelayed) {
      t.unrelayed = false;
      this.notify(threadId, 'Reply not relayed', 'Codex finished, but its reply could not be relayed here. Check the Codex window.', 'warning');
    }
    // The daemon emits idle just before turn/completed; unsubscribing at once could cut off the reply.
    this.releaseLater(t);
  }

  private collect(threadId: string, turnId: string, item: AgentMessage): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    const list = t.turns.get(turnId) ?? [];
    list.push({ text: item.text, phase: item.phase });
    t.turns.set(turnId, list);
  }

  private onTurnCompleted(
    threadId: string,
    turn: { id: string; status: string; error?: { message: string } | null; items?: Array<{ type: string } & AgentMessage> },
  ): void {
    for (const [requestId, a] of this.approvals) {
      if (a.threadId === threadId && a.turnId === turn.id) this.finishApproval(requestId, 'resolved');
    }
    const t = this.threads.get(threadId);
    if (!t) return;
    const collected = t.turns.get(turn.id) ?? [];
    t.turns.delete(turn.id);
    t.files.clear();
    if (t.thread.status.type !== 'active') void this.want(threadId, false);
    if (turn.status === 'failed' || turn.error) {
      this.notify(threadId, 'Codex task failed', turn.error?.message ?? 'The task ended with an error.', 'error');
      return;
    }
    if (turn.status === 'interrupted') {
      this.notify(threadId, 'Codex task stopped', 'The task was interrupted.', 'info');
      return;
    }
    // turn/completed may carry only a summary of the items, so prefer what was collected live.
    const fromTurn = (turn.items ?? []).filter((i) => i.type === 'agentMessage');
    const text = finalAnswer(collected.length ? collected : fromTurn);
    if (text) t.hub.send({ type: 'reply', sessionId: codexSessionId(threadId), content: text });
  }

  private onHubMessage(threadId: string, msg: ChannelMessage): void {
    if (msg.type === 'message_to_session') {
      void this.sendTurn(threadId, msg.content, msg.source);
    } else if (msg.type === 'image_to_session') {
      this.notify(threadId, 'Not delivered', 'Codex sessions do not accept images yet.', 'warning');
    } else if (msg.type === 'permission_response') {
      this.answer(threadId, msg.requestId, msg.choiceId);
    }
  }

  private async sendTurn(threadId: string, content: string, source?: MessageSource): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (t.thread.status.type !== 'idle' || t.pendingTurn) {
      this.notify(threadId, 'Not delivered', 'Codex is busy, so the message was not delivered. Send it again when the task finishes.', 'warning');
      return;
    }
    t.pendingTurn = true;
    try {
      if (!this.rpc) throw new Error('not connected to the Codex daemon');
      await this.want(threadId, true);
      // A new conversation cannot be subscribed before its first turn (no rollout found); the active broadcast retries it.
      t.unrelayed = !t.subscribed;
      await this.rpc.request('turn/start', { threadId, input: [{ type: 'text', text: withSourcePrefix(content, source) }] });
    } catch (err) {
      t.pendingTurn = false;
      t.unrelayed = false;
      this.releaseLater(t);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }

  private onServerRequest(rpcId: RpcId, method: string, params: any): void {
    const t = params?.threadId ? this.threads.get(params.threadId) : undefined;
    let view: ApprovalView | null = null;
    let broken = false;
    if (t) {
      try {
        view = approvalView(method, params, t.files.get(params.itemId));
      } catch (err) {
        broken = true;
        logger.warn(`Codex ${method} could not be shown: ${(err as Error).message}`);
      }
    }
    if (!t || !view) {
      if (t && (broken || USER_REQUESTS.has(method))) {
        this.notify(t.thread.id, 'Codex is waiting', 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.', 'warning');
      } else {
        logger.debug(`Ignoring Codex server request ${method}`);
      }
      return;
    }
    // The daemon re-sends a pending request to every new subscriber, so a resubscribe can deliver it twice.
    for (const a of this.approvals.values()) {
      if (a.threadId === t.thread.id && a.rpcId === rpcId) return;
    }
    const requestId = randomUUID();
    this.approvals.set(requestId, { threadId: t.thread.id, rpcId, turnId: params.turnId, choices: view.choices, answered: false });
    t.hub.send({
      type: 'permission_request',
      sessionId: codexSessionId(t.thread.id),
      requestId,
      toolName: view.toolName,
      description: view.description,
      inputPreview: view.inputPreview,
      timestamp: Date.now(),
      choices: view.choices.map((c, i) => ({ id: String(i), label: c.label })),
    });
  }

  private answer(threadId: string, requestId: string, choiceId?: string): void {
    const a = this.approvals.get(requestId);
    if (!a || a.threadId !== threadId || a.answered || !this.rpc || !choiceId || !/^\d+$/.test(choiceId)) return;
    const choice = a.choices[Number(choiceId)];
    if (!choice) return;
    a.answered = true;
    this.rpc.respond(a.rpcId, choice.response);
  }

  private onResolved(threadId: string, rpcId: RpcId): void {
    for (const [requestId, a] of this.approvals) {
      if (a.threadId === threadId && a.rpcId === rpcId) this.finishApproval(requestId, 'resolved');
    }
  }

  private finishApproval(requestId: string, state: 'resolved' | 'expired'): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    this.threads.get(a.threadId)?.hub.send({ type: 'permission_resolved', sessionId: codexSessionId(a.threadId), requestId, state });
  }

  private notify(threadId: string, title: string, message: string, level: NotifyLevel): void {
    this.threads.get(threadId)?.hub.send({ type: 'notify', sessionId: codexSessionId(threadId), title, message, level });
  }
}
