import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexHubLink } from './hub-link.js';
import { randomUUID } from 'node:crypto';
import { HubClient } from '../channel/hub-client.js';
import { CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { ChannelMessage, CodexCall, MessageSource, NotifyLevel, SessionInfo } from '../shared/types.js';
import { connectProxy, type ProxyConnection, type SpawnFn } from './transport.js';
import { imageInput, textInput, type UserInput } from './inputs.js';
import { RpcClient, type RpcId } from './rpc.js';
import { approvalView, fileChanges, type ApprovalChoice, type ApprovalView, type FileChange } from './approvals.js';
import {
  cleanFolder,
  codexSessionId,
  finalAnswer,
  hubStatus,
  isTrackable,
  threadTitle,
  type AgentMessage,
  type CodexThread,
  type CodexThreadStatus,
} from './mapping.js';

export type FirstConnect =
  | { connected: true; userAgent?: string }
  | { connected: false; error: string; notFound: boolean };

export interface CodexAdapterOptions {
  command: string;
  hub: { host: string; port: number; token?: string };
  spawnFn?: SpawnFn;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  idleReleaseMs?: number;
  noticeTimeoutMs?: number;
  hostName?: string;
  linkReconnectMs?: number;
  rpcTimeoutMs?: number;
  onFirstConnect?: (outcome: FirstConnect) => void;
}

interface Tracked {
  thread: CodexThread;
  hub: HubClient;
  subscribed: boolean;
  wantSubscribed: boolean;
  sync: Promise<void>;
  pendingTurn: boolean;
  sending: Promise<void>;
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
  private notFoundNotice: 'unsent' | 'sending' | 'sent' = 'unsent';
  private firstConnectReported = false;

  private pins = new Set<string>();
  private ready = false;
  private readonly hostName: string;
  private readonly link: CodexHubLink;

  constructor(private opts: CodexAdapterOptions) {
    this.delay = opts.reconnectMinMs ?? 2000;
    this.hostName = opts.hostName ?? os.hostname();
    this.link = new CodexHubLink(opts.hub, { id: randomUUID(), host: this.hostName }, (call) => this.onCall(call), opts.linkReconnectMs);
  }

  start(): void {
    this.stopped = false;
    this.link.connect();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.link.disconnect();
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
      const live = new RpcClient(conn.ws, this.opts.rpcTimeoutMs);
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
      this.reportFirstConnect({ connected: true, ...(init.userAgent ? { userAgent: init.userAgent } : {}) });
      await this.discover();
      if (this.rpc === live) this.setReady(true);
      this.delay = this.opts.reconnectMinMs ?? 2000;
    } catch (err) {
      this.setReady(false);
      logger.warn(`Codex daemon connection failed: ${(err as Error).message}`);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.noticeNotFound();
      this.reportFirstConnect({
        connected: false,
        error: (err as Error).message,
        notFound: (err as NodeJS.ErrnoException).code === 'ENOENT',
      });
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
    this.setReady(false);
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

  private reportFirstConnect(outcome: FirstConnect): void {
    if (this.firstConnectReported || this.stopped) return;
    this.firstConnectReported = true;
    try {
      this.opts.onFirstConnect?.(outcome);
    } catch (err) {
      // Inside connect(), a throw here would be taken for a daemon failure and drop a healthy connection.
      logger.debug(`First-connect observer failed: ${(err as Error).message}`);
    }
  }

  private noticeNotFound(): void {
    if (this.notFoundNotice !== 'unsent') return;
    this.notFoundNotice = 'sending';
    const { host, port, token } = this.opts.hub;
    fetch(`http://${host}:${port}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        title: 'Codex not found',
        message: `The Codex adapter cannot find "${this.opts.command}". Open a new terminal and restart the hub, or set "codex.command" in ~/.claude-alarm/config.json.`,
        level: 'warning',
      }),
      signal: AbortSignal.timeout(this.opts.noticeTimeoutMs ?? 5000),
    })
      .then((res) => {
        this.notFoundNotice = res.ok ? 'sent' : 'unsent';
        if (!res.ok) logger.debug(`Codex not-found notice was refused (${res.status})`);
      })
      .catch((err) => {
        // The hub replies only after its desktop notification closes, which can outlast the timeout, so a timeout still means it arrived.
        this.notFoundNotice = (err as Error).name === 'TimeoutError' ? 'sent' : 'unsent';
        logger.debug(`Codex not-found notice failed: ${(err as Error).message}`);
      });
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    this.link.setReady(ready);
  }

  private requireDaemon(): RpcClient {
    if (!this.ready || !this.rpc) throw new Error(`Codex is not connected on ${this.hostName}.`);
    return this.rpc;
  }

  private async onCall(call: CodexCall): Promise<unknown> {
    if (call.kind === 'folders') return { folders: await this.folders() };
    return { sessionId: await this.create(call.cwd) };
  }

  private async folders(): Promise<string[]> {
    const page = await this.requireDaemon().request<{ data: CodexThread[] }>('thread/list', { limit: 50, sortKey: 'updated_at' });
    return [...new Set(page.data.map((t) => t.cwd).filter(Boolean))].slice(0, 10);
  }

  private async create(input: string): Promise<string> {
    const rpc = this.requireDaemon();
    const cwd = cleanFolder(input);
    const isDir = path.isAbsolute(cwd) && (await fs.promises.stat(cwd).then((s) => s.isDirectory(), () => false));
    if (!isDir) throw new Error(`Folder not found on ${this.hostName}: ${cwd}`);
    let thread: CodexThread;
    try {
      // No RPC timeout: an answer dropped after a timeout would leave a conversation this connection holds but never pins.
      ({ thread } = await rpc.request<{ thread: CodexThread }>('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' }, null));
    } catch (err) {
      throw new Error(`Codex could not start the conversation: ${(err as Error).message}`);
    }
    this.pins.add(thread.id);
    this.upsert(thread);
    const t = this.threads.get(thread.id);
    if (!t) {
      this.pins.delete(thread.id);
      throw new Error('Codex started a conversation claude-alarm cannot follow.');
    }
    // The starting connection is already subscribed; marking it before upsert's queued sync runs avoids a resume that fails before the first turn.
    t.subscribed = true;
    return codexSessionId(thread.id);
  }

  private async discover(): Promise<void> {
    const rpc = this.rpc!;
    const pinned = [...this.pins];
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await rpc.request<{ data: string[]; nextCursor?: string | null }>('thread/loaded/list', cursor ? { cursor } : {});
      ids.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) await this.refresh(id);
    // A list read on a connection that has since been replaced says nothing about what the daemon holds now.
    if (this.rpc !== rpc) return;
    for (const id of pinned) if (!ids.includes(id)) this.pins.delete(id);
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
        sending: Promise.resolve(),
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
    return { name: title, title, cwd: t.thread.cwd, agentKind: 'codex', status: hubStatus(t.thread.status), closable: this.pins.has(threadId) };
  }

  private want(threadId: string, subscribed: boolean): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) return Promise.resolve();
    t.wantSubscribed = subscribed || this.pins.has(threadId);
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
      // A turn started in the Codex window has no other way to reach claude-alarm, so its reply is lost unless a later resume succeeds.
      if (t.wantSubscribed && !t.subscribed && t.thread.status.type === 'active') t.unrelayed = true;
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

  private busy(t: Tracked): boolean {
    return t.thread.status.type === 'active' || t.pendingTurn;
  }

  private async close(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t || !this.pins.delete(threadId)) return;
    t.hub.reregister();
    if (this.busy(t)) return;
    // drop() before the unsubscribe finishes would skip it: syncSubscription stops once the thread is untracked.
    await this.want(threadId, false);
    // A message or an active broadcast may arrive while unsubscribing; the conversation then ends like a close during work.
    if (this.threads.get(threadId) !== t || this.busy(t) || t.wantSubscribed) return;
    if (!t.subscribed) {
      this.drop(threadId);
      return;
    }
    // syncSubscription swallows unsubscribe errors, so a still-set flag is the only sign it failed.
    this.pins.add(threadId);
    t.hub.reregister();
    void this.want(threadId, true);
    this.notify(threadId, 'Not closed', 'Codex did not release the conversation. Try closing it again.', 'warning');
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
        this.pins.delete(params.threadId);
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
      this.pins.delete(threadId);
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
    // The daemon announces name changes but not preview changes, so a title taken from the folder is re-read once text exists.
    if (!t.thread.name?.trim() && !t.thread.preview?.trim()) void this.refresh(threadId);
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
      this.enqueue(threadId, async () => textInput(msg.content, msg.source), msg.source);
    } else if (msg.type === 'image_to_session') {
      this.enqueue(threadId, () => imageInput(msg.imagePath, msg.mimeType, msg.content, msg.source), msg.source);
    } else if (msg.type === 'permission_response') {
      this.answer(threadId, msg.requestId, msg.choiceId);
    } else if (msg.type === 'codex_close') {
      void this.close(threadId);
    }
  }

  // One message at a time per conversation, so a message right behind another sees the turn the first one started.
  private enqueue(threadId: string, build: () => Promise<UserInput[]>, source?: MessageSource): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.sending = t.sending
      .then(() => this.deliver(t, build, source))
      .catch((err) => logger.warn(`Codex delivery for ${threadId} failed: ${(err as Error).message}`));
  }

  private async deliver(t: Tracked, build: () => Promise<UserInput[]>, source?: MessageSource): Promise<void> {
    const threadId = t.thread.id;
    if (this.threads.get(threadId) !== t) return;
    // A steer is accepted while an approval is pending but read only after it is answered, which reads like an answer.
    if (hubStatus(t.thread.status) === 'waiting_input') {
      this.refuseWhileWaiting(threadId);
      return;
    }
    let input: UserInput[];
    try {
      input = await build();
    } catch (err) {
      logger.debug(`Codex input for ${threadId} could not be built: ${(err as Error).message}`);
      this.notify(threadId, 'Not delivered', 'The image could not be read here, so it was not delivered. Codex may be running on another PC.', 'warning');
      return;
    }
    if (this.threads.get(threadId) !== t) return;
    t.pendingTurn = true;
    const wasUnrelayed = t.unrelayed;
    try {
      const rpc = this.rpc;
      if (!rpc) throw new Error('not connected to the Codex daemon');
      await this.want(threadId, true);
      // A new conversation cannot be subscribed before its first turn (no rollout found); the active broadcast retries it.
      const unsubscribed = !t.subscribed;
      const running = await this.runningTurn(rpc, threadId);
      if (this.threads.get(threadId) !== t) return;
      // An approval can start while the input is built and the turn looked up; the check at the top cannot see it.
      if (hubStatus(t.thread.status) === 'waiting_input') {
        this.abandonDelivery(t, wasUnrelayed);
        this.refuseWhileWaiting(threadId);
        return;
      }
      if (unsubscribed) t.unrelayed = true;
      if (running) {
        await rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info', source);
        return;
      }
      await rpc.request('turn/start', { threadId, input });
    } catch (err) {
      this.abandonDelivery(t, wasUnrelayed);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }

  private abandonDelivery(t: Tracked, wasUnrelayed: boolean): void {
    t.pendingTurn = false;
    t.unrelayed = wasUnrelayed;
    this.releaseLater(t);
  }

  private refuseWhileWaiting(threadId: string): void {
    this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
  }

  // The list is unavailable before a new conversation's first turn; starting a turn is safe then, since turn/start steers a running turn.
  private async runningTurn(rpc: RpcClient, threadId: string): Promise<string | undefined> {
    try {
      const page = await rpc.request<{ data: Array<{ id: string; status: string }> }>('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
      });
      const turn = page.data?.[0];
      return turn?.status === 'inProgress' ? turn.id : undefined;
    } catch (err) {
      logger.debug(`thread/turns/list ${threadId} failed: ${(err as Error).message}`);
      return undefined;
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
        this.waitingInCodex(t.thread.id);
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
    try {
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
    } catch (err) {
      this.approvals.delete(requestId);
      logger.warn(`Codex ${method} could not be relayed: ${(err as Error).message}`);
      // No reply to the daemon: the same request is open in the Codex window, and an error reply could cancel it there.
      this.waitingInCodex(t.thread.id);
    }
  }

  private waitingInCodex(threadId: string): void {
    this.notify(threadId, 'Codex is waiting', 'Codex asked for input that claude-alarm cannot relay. Handle it in Codex.', 'warning');
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

  private notify(threadId: string, title: string, message: string, level: NotifyLevel, to?: MessageSource): void {
    this.threads.get(threadId)?.hub.send({ type: 'notify', sessionId: codexSessionId(threadId), title, message, level, ...(to ? { to } : {}) });
  }
}
