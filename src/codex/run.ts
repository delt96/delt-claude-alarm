import path from 'node:path';
import { closeWithinLimit } from './shutdown.js';
import { connectProxy, defaultSpawn, type SpawnFn } from './transport.js';
import { RpcClient, type RpcId } from './rpc.js';
import { finalAnswer, type AgentMessage } from './mapping.js';
import { CHANNEL_SERVER_VERSION } from '../shared/constants.js';

export interface CodexRunOptions {
  brief: string;
  cwd: string;
  threadId?: string;
  name?: string;
  outputSchema?: unknown;
  yolo?: boolean;
  approvalTimeoutMs?: number;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  command?: string;
  spawnFn?: SpawnFn;
  progress?: (line: string) => void;
}

export type CodexRunStatus = 'completed' | 'failed' | 'interrupted' | 'timedOut';

export interface ApprovalRecord {
  kind: string;
  summary: string;
  outcome: 'unanswered' | 'answered-elsewhere' | 'timeout-declined' | 'auto-declined';
}

export interface CodexRunResult {
  threadId: string;
  turnId: string;
  status: CodexRunStatus;
  error: string | null;
  result: unknown;
  finalText: string | null;
  approvals: ApprovalRecord[];
  durationMs: number;
  codex: { userAgent: string | null };
}

interface Turn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  items?: Array<{ type: string } & AgentMessage>;
}

const MINUTE = 60_000;
const SUMMARY_MAX = 200;

const clip = (text: string) => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text);

// Only these requests reach the dashboard through the adapter, so only these are worth waiting on.
function relayed(method: string, params: any): { kind: string; summary: string; decline: unknown } | null {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = params.command ?? (params.commandActions ?? []).map((a: { command: string }) => a.command).join('\n');
      return { kind: 'command', summary: clip(String(command || params.reason || '')), decline: { decision: 'decline' } };
    }
    case 'item/fileChange/requestApproval':
      return { kind: 'file change', summary: clip(String(params.reason ?? '')), decline: { decision: 'decline' } };
    case 'mcpServer/elicitation/request':
      if (params._meta?.codex_approval_kind !== 'mcp_tool_call') return null;
      return { kind: 'MCP tool', summary: clip(`${params.serverName ?? ''}: ${params.message ?? ''}`), decline: { action: 'decline' } };
    default:
      return null;
  }
}

function unrelayed(method: string, params: any): { kind: string; summary: string; answer: unknown } | null {
  switch (method) {
    case 'item/permissions/requestApproval':
      return { kind: 'permissions', summary: clip(String(params.reason ?? '')), answer: { permissions: {} } };
    case 'item/tool/requestUserInput':
      return {
        kind: 'question',
        summary: clip((params.questions ?? []).map((q: { question?: string }) => q.question ?? '').join(' / ')),
        answer: { answers: {} },
      };
    case 'mcpServer/elicitation/request':
      return { kind: 'MCP form', summary: clip(String(params.message ?? '')), answer: { action: 'decline' } };
    default:
      return null;
  }
}

export async function runCodexTask(opts: CodexRunOptions): Promise<CodexRunResult> {
  const progress = opts.progress ?? (() => {});
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 10 * MINUTE;
  const started = Date.now();
  const conn = await connectProxy(opts.command ?? 'codex', opts.spawnFn ?? defaultSpawn);
  const rpc = new RpcClient(conn.ws);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  try {
    const init = await rpc.request<{ userAgent?: string }>('initialize', {
      clientInfo: { name: 'claude-alarm-run', version: CHANNEL_SERVER_VERSION },
    });
    rpc.notify('initialized');

    const yolo = { sandbox: 'danger-full-access', approvalPolicy: 'never' };
    let threadId: string;
    if (opts.threadId) {
      // Without --yolo the thread keeps its own settings: resume fields override them.
      await rpc.request('thread/resume', opts.yolo ? { threadId: opts.threadId, ...yolo } : { threadId: opts.threadId });
      threadId = opts.threadId;
    } else {
      const res = await rpc.request<{ thread: { id: string } }>('thread/start', {
        cwd: opts.cwd,
        ...(opts.yolo ? yolo : { sandbox: 'workspace-write', approvalPolicy: 'on-request' }),
      });
      threadId = res.thread.id;
      if (opts.name) {
        await rpc.request('thread/name/set', { threadId, name: opts.name }).catch(() => {});
      }
    }
    progress(`thread ${threadId}`);

    const messages = new Map<string, AgentMessage[]>();
    const approvals: ApprovalRecord[] = [];
    const waiting = new Map<RpcId, ApprovalRecord>();
    let finish!: (turn: Turn) => void;
    let lose!: (err: Error) => void;
    const completed = new Promise<Turn>((resolve, reject) => {
      finish = resolve;
      lose = reject;
    });
    // Closing the connection after a failed turn/start rejects this with nobody waiting on it.
    completed.catch(() => {});

    rpc.on('close', () => lose(new Error('connection to the Codex daemon closed')));
    rpc.on('notification', (method: string, params: any) => {
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed') {
        const item = params.item ?? {};
        if (item.type === 'agentMessage') {
          const list = messages.get(params.turnId) ?? [];
          list.push({ text: item.text, phase: item.phase });
          messages.set(params.turnId, list);
        } else if (item.type === 'commandExecution') {
          progress(`ran ${clip(String(item.command ?? ''))} (exit ${item.exitCode ?? '?'})`);
        }
      } else if (method === 'serverRequest/resolved') {
        const record = waiting.get(params.requestId);
        if (record) {
          waiting.delete(params.requestId);
          record.outcome = 'answered-elsewhere';
          progress(`approval answered elsewhere: ${record.kind}`);
        }
      } else if (method === 'turn/completed') {
        finish(params.turn);
      }
    });
    rpc.on('request', (id: RpcId, method: string, params: any) => {
      if (params?.threadId !== threadId) return;
      const wait = relayed(method, params);
      if (wait) {
        const record: ApprovalRecord = { kind: wait.kind, summary: wait.summary, outcome: 'unanswered' };
        approvals.push(record);
        waiting.set(id, record);
        progress(`approval pending (${Math.round(approvalTimeoutMs / 1000)}s): ${wait.kind} ${wait.summary}`);
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!waiting.delete(id)) return;
          record.outcome = 'timeout-declined';
          rpc.respond(id, wait.decline);
          progress(`approval declined after timeout: ${wait.kind}`);
        }, approvalTimeoutMs);
        timers.add(timer);
        return;
      }
      const answer = unrelayed(method, params);
      if (answer) {
        approvals.push({ kind: answer.kind, summary: answer.summary, outcome: 'auto-declined' });
        rpc.respond(id, answer.answer);
        progress(`declined at once: ${answer.kind}`);
      }
    });

    const turnStart: Record<string, unknown> = { threadId, input: [{ type: 'text', text: opts.brief }] };
    if (opts.outputSchema !== undefined) turnStart.outputSchema = opts.outputSchema;
    const { turn } = await rpc.request<{ turn: { id: string } }>('turn/start', turnStart);
    const turnId = turn.id;
    progress(`turn ${turnId} started`);

    let stopReason: 'timedOut' | 'interrupted' | null = null;
    let interruptRequested!: () => void;
    const stopped = new Promise<void>((resolve) => (interruptRequested = resolve));
    const stop = (reason: 'timedOut' | 'interrupted') => {
      if (stopReason) return;
      stopReason = reason;
      progress(reason === 'timedOut' ? 'timeout reached, interrupting the turn' : 'interrupting the turn');
      rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      interruptRequested();
    };
    const deadline = setTimeout(() => stop('timedOut'), opts.timeoutMs ?? 60 * MINUTE);
    timers.add(deadline);
    const onAbort = () => stop('interrupted');
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const grace = stopped.then(
      () =>
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), opts.interruptGraceMs ?? 15_000);
          timers.add(t);
        }),
    );
    let ended: Turn | null;
    let lost: string | null = null;
    try {
      ended = await Promise.race([completed, grace]);
    } catch (err) {
      ended = null;
      lost = (err as Error).message;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }

    let status: CodexRunStatus;
    let error: string | null = null;
    if (stopReason) status = stopReason;
    else if (lost) {
      status = 'failed';
      error = lost;
    } else if (ended?.status === 'failed' || ended?.error) {
      status = 'failed';
      error = ended?.error?.message ?? 'the turn failed';
    } else if (ended?.status === 'interrupted') status = 'interrupted';
    else status = 'completed';

    // turn/completed may carry only a summary of the items, so prefer what was collected live.
    const collected = messages.get(turnId) ?? [];
    const fromTurn = (ended?.items ?? []).filter((i) => i.type === 'agentMessage');
    const finalText = finalAnswer(collected.length ? collected : fromTurn);
    let result: unknown = null;
    if (opts.outputSchema !== undefined && finalText) {
      try {
        result = JSON.parse(finalText);
      } catch {
        result = null;
      }
    }
    return {
      threadId,
      turnId,
      status,
      error,
      result,
      finalText,
      approvals,
      durationMs: Date.now() - started,
      codex: { userAgent: init.userAgent ?? null },
    };
  } finally {
    for (const t of timers) clearTimeout(t);
    await closeWithinLimit(() => conn.close());
  }
}

const VALUE_FLAGS: Record<string, keyof RunArgs> = {
  '--brief': 'brief',
  '--cwd': 'cwd',
  '--thread': 'threadId',
  '--name': 'name',
  '--output-schema': 'outputSchema',
  '--approval-timeout': 'approvalTimeoutMs',
  '--timeout': 'timeoutMs',
};

export interface RunArgs {
  brief: string;
  yolo?: boolean;
  cwd?: string;
  threadId?: string;
  name?: string;
  outputSchema?: string;
  approvalTimeoutMs?: number;
  timeoutMs?: number;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const out: Partial<Record<keyof RunArgs, string | number | boolean>> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--yolo') {
      out.yolo = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (key === 'approvalTimeoutMs' || key === 'timeoutMs') {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${flag} must be a number of minutes`);
      out[key] = Math.round(minutes * MINUTE);
    } else {
      out[key] = value;
    }
  }
  if (out.brief === undefined) throw new Error('--brief <file|-> is required');
  return out as unknown as RunArgs;
}

export interface RunIo {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
}

export async function runFromCli(argv: string[], io: RunIo): Promise<number> {
  let task: CodexRunOptions;
  try {
    const args = parseRunArgs(argv);
    const brief = args.brief === '-' ? await io.readStdin() : await io.readFile(args.brief);
    if (!brief.trim()) throw new Error('the brief is empty');
    task = {
      brief,
      cwd: path.resolve(io.cwd, args.cwd ?? '.'),
      threadId: args.threadId,
      name: args.name,
      yolo: args.yolo,
      outputSchema: args.outputSchema === undefined ? undefined : JSON.parse(await io.readFile(args.outputSchema)),
      approvalTimeoutMs: args.approvalTimeoutMs,
      timeoutMs: args.timeoutMs,
      signal: io.signal,
      spawnFn: io.spawnFn,
      progress: (line) => io.err(`[codex run] ${line}\n`),
    };
  } catch (err) {
    io.err(`codex run: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    const result = await runCodexTask(task);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'completed' ? 0 : 1;
  } catch (err) {
    io.err(`codex run: could not start the task: ${(err as Error).message}\n`);
    return 2;
  }
}
