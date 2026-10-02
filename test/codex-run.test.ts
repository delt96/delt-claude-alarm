// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCodexTask, parseRunArgs, runFromCli, type CodexRunOptions } from '../src/codex/run.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

let daemon: FakeDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
});

const THREAD = 'th-1';

function message(turnId: string, text: string, phase: string | null = 'final_answer') {
  return { threadId: THREAD, turnId, item: { type: 'agentMessage', id: `m-${text.length}`, text, phase } };
}

// Sends the given notifications after the turn/start reply, as the daemon does for a short turn.
function finishTurn(d: FakeDaemon, turnId: string, text: string | null, status = 'completed', error: unknown = null, delayMs = 20) {
  setTimeout(() => {
    if (text !== null) d.notify('item/completed', message(turnId, text));
    d.notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status, error, items: [] } });
  }, delayMs);
}

async function startDaemon(onTurn?: (d: FakeDaemon, params: any) => void): Promise<FakeDaemon> {
  const d = new FakeDaemon();
  daemon = d;
  await d.start();
  d.handle('initialize', () => ({ userAgent: 'codex_cli_rs/0.160.0' }));
  d.handle('thread/start', (p) => ({ thread: { id: THREAD, cwd: p.cwd, status: { type: 'idle' } } }));
  d.handle('thread/resume', () => ({ thread: { id: THREAD, status: { type: 'idle' } } }));
  d.handle('thread/name/set', () => ({}));
  d.handle('turn/interrupt', () => ({}));
  d.handle('turn/start', (p) => {
    onTurn?.(d, p);
    return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
  });
  return d;
}

function run(d: FakeDaemon, opts: Partial<CodexRunOptions> = {}) {
  return runCodexTask({ brief: 'Do the task', cwd: 'C:\\w\\proj', spawnFn: d.spawnFn, ...opts });
}

test('a new task starts a writable thread that asks before leaving the sandbox, then returns the final answer', async () => {
  const d = await startDaemon((dd) => {
    setTimeout(() => dd.notify('item/completed', message('turn-1', 'Looking around', null)), 5);
    finishTurn(dd, 'turn-1', 'All done');
  });
  const r = await run(d, { name: 'Plan X Task 3' });

  const start = d.calls('thread/start')[0].params;
  assert.equal(start.cwd, 'C:\\w\\proj');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.notEqual(start.ephemeral, true);
  assert.deepEqual(d.calls('thread/name/set')[0].params, { threadId: THREAD, name: 'Plan X Task 3' });
  const turn = d.calls('turn/start')[0].params;
  assert.equal(turn.threadId, THREAD);
  assert.deepEqual(turn.input, [{ type: 'text', text: 'Do the task' }]);
  assert.equal(r.status, 'completed');
  assert.equal(r.threadId, THREAD);
  assert.equal(r.turnId, 'turn-1');
  assert.equal(r.finalText, 'All done');
  assert.equal(r.result, null);
  assert.equal(r.codex.userAgent, 'codex_cli_rs/0.160.0');
});

test('an output schema is passed to the turn and the final answer is parsed', async () => {
  const schema = { type: 'object', properties: { status: { type: 'string' } } };
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', '{"status":"DONE"}'));
  const r = await run(d, { outputSchema: schema });
  assert.deepEqual(d.calls('turn/start')[0].params.outputSchema, schema);
  assert.deepEqual(r.result, { status: 'DONE' });
});

test('a final answer that is not JSON leaves result empty but keeps the text', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', 'not json'));
  const r = await run(d, { outputSchema: { type: 'object' } });
  assert.equal(r.result, null);
  assert.equal(r.finalText, 'not json');
});

test('the final answer falls back to the items carried by turn/completed', async () => {
  const d = await startDaemon((dd) => setTimeout(() => dd.notify('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-1', status: 'completed', error: null, items: [{ type: 'agentMessage', text: 'From the turn', phase: 'final_answer' }] },
  }), 20));
  const r = await run(d);
  assert.equal(r.finalText, 'From the turn');
});

test('yolo starts the thread without a sandbox and without approvals', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', 'ok'));
  await run(d, { yolo: true });
  const start = d.calls('thread/start')[0].params;
  assert.equal(start.sandbox, 'danger-full-access');
  assert.equal(start.approvalPolicy, 'never');
});

test('yolo on a follow-up applies the same settings when resuming', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', 'ok'));
  await run(d, { threadId: THREAD, yolo: true });
  assert.deepEqual(d.calls('thread/resume')[0].params, { threadId: THREAD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
});

test('a follow-up resumes the given thread instead of starting a new one', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', 'Fixed'));
  const r = await run(d, { threadId: THREAD, name: 'ignored on resume' });
  assert.equal(d.calls('thread/start').length, 0);
  assert.deepEqual(d.calls('thread/resume')[0].params, { threadId: THREAD });
  assert.equal(d.calls('thread/name/set').length, 0);
  assert.equal(d.calls('turn/start')[0].params.threadId, THREAD);
  assert.equal(r.finalText, 'Fixed');
});

test('an unanswered command approval is declined after the approval timeout', async () => {
  const d = await startDaemon((dd) => setTimeout(() => dd.serverRequest(77, 'item/commandExecution/requestApproval', {
    threadId: THREAD, turnId: 'turn-1', itemId: 'i1', command: 'npm install left-pad', reason: 'needs network',
  }), 10));
  const running = run(d, { approvalTimeoutMs: 150 });
  const answer = await until(() => d.responses.find((r) => r.id === 77));
  assert.deepEqual(answer.result, { decision: 'decline' });
  finishTurn(d, 'turn-1', 'Could not install');
  const r = await running;
  assert.deepEqual(r.approvals, [{ kind: 'command', summary: 'npm install left-pad', outcome: 'timeout-declined' }]);
});

test('an approval answered elsewhere is left alone', async () => {
  const d = await startDaemon((dd) => {
    setTimeout(() => dd.serverRequest(78, 'item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'i2', reason: 'write outside' }), 10);
    setTimeout(() => dd.notify('serverRequest/resolved', { threadId: THREAD, requestId: 78 }), 40);
    finishTurn(dd, 'turn-1', 'ok', 'completed', null, 80);
  });
  const r = await run(d, { approvalTimeoutMs: 300 });
  await new Promise((res) => setTimeout(res, 350));
  assert.equal(d.responses.find((x) => x.id === 78), undefined);
  assert.deepEqual(r.approvals, [{ kind: 'file change', summary: 'write outside', outcome: 'answered-elsewhere' }]);
});

test('an unanswered MCP tool approval is declined with the elicitation shape', async () => {
  const d = await startDaemon((dd) => setTimeout(() => dd.serverRequest(79, 'mcpServer/elicitation/request', {
    threadId: THREAD, turnId: 'turn-1', serverName: 'docs', message: 'Call search?', _meta: { codex_approval_kind: 'mcp_tool_call' },
  }), 10));
  const running = run(d, { approvalTimeoutMs: 100 });
  const answer = await until(() => d.responses.find((r) => r.id === 79));
  assert.deepEqual(answer.result, { action: 'decline' });
  finishTurn(d, 'turn-1', 'ok');
  assert.equal((await running).approvals[0].outcome, 'timeout-declined');
});

test('requests the dashboard cannot show are answered at once', async () => {
  const d = await startDaemon((dd) => {
    setTimeout(() => {
      dd.serverRequest(80, 'item/permissions/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'i3', reason: 'more access' });
      dd.serverRequest(81, 'item/tool/requestUserInput', { threadId: THREAD, turnId: 'turn-1', itemId: 'i4', questions: [{ id: 'q', question: 'Which one?' }] });
      dd.serverRequest(82, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: 'turn-1', serverName: 'x', message: 'Fill the form' });
    }, 10);
  });
  const running = run(d, { approvalTimeoutMs: 60_000 });
  await until(() => [80, 81, 82].every((id) => d.responses.some((r) => r.id === id)));
  assert.deepEqual(d.responses.find((r) => r.id === 80)!.result, { permissions: {} });
  assert.deepEqual(d.responses.find((r) => r.id === 81)!.result, { answers: {} });
  assert.deepEqual(d.responses.find((r) => r.id === 82)!.result, { action: 'decline' });
  finishTurn(d, 'turn-1', 'ok');
  const r = await running;
  assert.deepEqual(r.approvals.map((a) => a.outcome), ['auto-declined', 'auto-declined', 'auto-declined']);
});

test('requests from other conversations are ignored', async () => {
  const d = await startDaemon((dd) => {
    setTimeout(() => dd.serverRequest(83, 'item/commandExecution/requestApproval', { threadId: 'someone-else', turnId: 't', itemId: 'i', command: 'ls' }), 10);
    finishTurn(dd, 'turn-1', 'ok');
  });
  const r = await run(d, { approvalTimeoutMs: 50 });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(d.responses.find((x) => x.id === 83), undefined);
  assert.deepEqual(r.approvals, []);
});

test('an approval still waiting when the turn is stopped is reported as unanswered', async () => {
  const d = await startDaemon((dd) => setTimeout(() => dd.serverRequest(84, 'item/commandExecution/requestApproval', {
    threadId: THREAD, turnId: 'turn-1', itemId: 'i5', command: 'npm publish',
  }), 10));
  d.handle('turn/interrupt', (p) => {
    finishTurn(d, p.turnId, null, 'interrupted');
    return {};
  });
  const r = await run(d, { timeoutMs: 100, approvalTimeoutMs: 60_000 });
  assert.equal(r.status, 'timedOut');
  assert.deepEqual(r.approvals, [{ kind: 'command', summary: 'npm publish', outcome: 'unanswered' }]);
  assert.equal(d.responses.find((x) => x.id === 84), undefined);
});

test('a turn that runs past the timeout is interrupted', async () => {
  const d = await startDaemon();
  d.handle('turn/interrupt', (p) => {
    finishTurn(d, p.turnId, null, 'interrupted');
    return {};
  });
  const r = await run(d, { timeoutMs: 100 });
  assert.deepEqual(d.calls('turn/interrupt')[0].params, { threadId: THREAD, turnId: 'turn-1' });
  assert.equal(r.status, 'timedOut');
});

test('an abort signal interrupts the turn', async () => {
  const d = await startDaemon();
  d.handle('turn/interrupt', (p) => {
    finishTurn(d, p.turnId, null, 'interrupted');
    return {};
  });
  const ac = new AbortController();
  const running = run(d, { signal: ac.signal });
  await until(() => d.calls('turn/start').length > 0);
  ac.abort();
  const r = await running;
  assert.equal(d.calls('turn/interrupt').length, 1);
  assert.equal(r.status, 'interrupted');
});

test('the run still ends when the daemon never confirms an interrupt', async () => {
  const d = await startDaemon();
  const r = await run(d, { timeoutMs: 50, interruptGraceMs: 100 });
  assert.equal(r.status, 'timedOut');
});

test('a failed turn reports its error', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', null, 'failed', { message: 'model overloaded' }));
  const r = await run(d);
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'model overloaded');
});

test('losing the daemon mid-turn ends the run as failed', async () => {
  const d = await startDaemon((dd) => setTimeout(() => dd.dropClient(), 20));
  const r = await run(d);
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /closed/);
});

test('a thread that cannot be resumed is a start error', async () => {
  const d = await startDaemon();
  d.handle('thread/resume', () => { throw new Error('no rollout found'); });
  await assert.rejects(run(d, { threadId: 'missing' }), /no rollout found/);
});

test('a turn that cannot start is a start error and leaves nothing unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const d = await startDaemon();
    d.handle('turn/start', () => { throw new Error('thread is busy'); });
    await assert.rejects(run(d), /thread is busy/);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('run arguments are parsed with minutes turned into milliseconds', () => {
  assert.deepEqual(parseRunArgs(['--brief', 'b.md', '--cwd', 'C:\\w', '--thread', 'th', '--name', 'N', '--output-schema', 's.json', '--approval-timeout', '2', '--timeout', '1.5']), {
    brief: 'b.md', cwd: 'C:\\w', threadId: 'th', name: 'N', outputSchema: 's.json', approvalTimeoutMs: 120_000, timeoutMs: 90_000,
  });
  assert.deepEqual(parseRunArgs(['--brief', '-']), { brief: '-' });
  assert.deepEqual(parseRunArgs(['--yolo', '--brief', 'b.md']), { brief: 'b.md', yolo: true });
});

function cliIo(d: FakeDaemon | undefined, files: Record<string, string>, stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      readFile: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      readStdin: async () => stdin,
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      cwd: 'C:\\w\\proj',
      spawnFn: d?.spawnFn,
    },
  };
}

test('the CLI reads the brief and schema files, prints the result as JSON and exits 0 on completion', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', '{"status":"DONE"}'));
  const c = cliIo(d, { 'brief.md': 'Implement it', 'schema.json': '{"type":"object"}' });
  const code = await runFromCli(['--brief', 'brief.md', '--output-schema', 'schema.json', '--cwd', 'sub', '--yolo'], c.io);
  assert.equal(code, 0);
  assert.equal(d.calls('thread/start')[0].params.cwd, 'C:\\w\\proj\\sub');
  assert.equal(d.calls('thread/start')[0].params.sandbox, 'danger-full-access');
  assert.equal(d.calls('turn/start')[0].params.input[0].text, 'Implement it');
  assert.deepEqual(JSON.parse(c.out.join('')).result, { status: 'DONE' });
  assert.ok(c.err.some((l) => l.startsWith('[codex run] turn turn-1 started')));
});

test('the CLI reads the brief from stdin with --brief - and exits 1 when the turn fails', async () => {
  const d = await startDaemon((dd) => finishTurn(dd, 'turn-1', null, 'failed', { message: 'boom' }));
  const c = cliIo(d, {}, 'From stdin');
  const code = await runFromCli(['--brief', '-'], c.io);
  assert.equal(code, 1);
  assert.equal(d.calls('turn/start')[0].params.input[0].text, 'From stdin');
  assert.equal(JSON.parse(c.out.join('')).status, 'failed');
});

test('the CLI exits 2 without contacting Codex when the input is unusable', async () => {
  for (const [argv, files] of [
    [['--timeout', '5'], {}],
    [['--brief', 'missing.md'], {}],
    [['--brief', 'empty.md'], { 'empty.md': '  \n' }],
    [['--brief', 'b.md', '--output-schema', 'bad.json'], { 'b.md': 'x', 'bad.json': '{' }],
  ] as Array<[string[], Record<string, string>]>) {
    const c = cliIo(undefined, files);
    assert.equal(await runFromCli(argv, c.io), 2, argv.join(' '));
    assert.equal(c.out.length, 0);
    assert.match(c.err.join(''), /^codex run: /);
  }
});

test('run arguments without a brief, with unknown flags or bad numbers are rejected', () => {
  assert.throws(() => parseRunArgs([]), /--brief/);
  assert.throws(() => parseRunArgs(['--brief', 'b', '--model', 'x']), /--model/);
  assert.throws(() => parseRunArgs(['--brief', 'b', '--timeout', 'soon']), /--timeout/);
  assert.throws(() => parseRunArgs(['--brief']), /--brief/);
});
