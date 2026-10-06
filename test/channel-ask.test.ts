import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { until } from './helpers/fake-codex-daemon.js';

// A stand-in hub: records what the channel server sends and can answer back.
let wss: WebSocketServer;
let hubSocket: WebSocket | undefined;
const fromChannel: any[] = [];
let client: Client;
const channelNotes: any[] = [];

async function spawnChannel(port: number): Promise<Client> {
  const c = new Client({ name: 'channel-ask-test', version: '0.0.0' });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join('src', 'channel', 'server.ts')],
    env: { ...process.env, CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: String(port) } as Record<string, string>,
    stderr: 'ignore',
  }));
  return c;
}

before(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (ws) => {
    hubSocket = ws;
    ws.on('message', (d) => fromChannel.push(JSON.parse(String(d))));
  });
  const port = (wss.address() as { port: number }).port;
  client = await spawnChannel(port);
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({}).passthrough() }),
    (n) => { channelNotes.push(n.params); },
  );
  await until(() => fromChannel.find((m) => m.type === 'register'), 15000);
});

after(async () => {
  await client.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

const textOf = (r: any) => r.content.map((c: any) => c.text).join('');

test('ask sends the question to the hub, marks the session as waiting, and says the answer comes later', async () => {
  const before = fromChannel.length;
  const result: any = await client.callTool({
    name: 'ask',
    arguments: {
      context: 'Two ways to do it.',
      questions: [
        { header: 'Scope', question: 'Who needs the alert?', options: [{ label: 'Approvers', description: 'Badge only' }, { label: 'Both' }] },
        { question: 'Anything else?' },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  const [question, status] = await until(() => {
    const sent = fromChannel.slice(before);
    return sent.length >= 2 && sent;
  });
  assert.equal(question.type, 'question');
  assert.match(question.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(question.context, 'Two ways to do it.');
  assert.deepEqual(question.questions, [
    { id: 'q1', header: 'Scope', question: 'Who needs the alert?', options: [{ label: 'Approvers', description: 'Badge only' }, { label: 'Both' }], allowOther: true },
    { id: 'q2', question: 'Anything else?', options: null, allowOther: true },
  ]);
  assert.deepEqual({ type: status.type, status: status.status }, { type: 'status', status: 'waiting_input' });
  assert.equal(status.sessionId, question.sessionId);
  assert.match(textOf(result), new RegExp(`^Question sent \\(id ${question.requestId}\\)\\.`));
  assert.match(textOf(result), /arrives as a channel message starting with "Answer to your question"/);
  assert.doesNotMatch(textOf(result), /not connected/);
});

test('a malformed ask is refused with the reason and nothing reaches the hub', async () => {
  const before = fromChannel.length;
  const tooMany: any = await client.callTool({ name: 'ask', arguments: { questions: [1, 2, 3, 4, 5].map((n) => ({ question: `Q${n}` })) } });
  const oneOption: any = await client.callTool({ name: 'ask', arguments: { questions: [{ question: 'Pick', options: [{ label: 'Only' }] }] } });
  const blank: any = await client.callTool({ name: 'ask', arguments: { questions: [{ question: '   ' }] } });
  assert.equal(tooMany.isError, true);
  assert.match(textOf(tooMany), /^Question not sent: questions must list 1 to 4 questions/);
  assert.match(textOf(oneOption), /question 1 needs 2 to 6 options/);
  assert.match(textOf(blank), /question 1 needs text/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fromChannel.length, before);
});

test('an answer from the hub reaches the session as a channel message and is confirmed back', async () => {
  const sessionId = fromChannel.find((m) => m.type === 'register').session.id;
  const questions = [
    { id: 'q1', question: 'Which color do you prefer?', options: [{ label: 'Red' }, { label: 'Blue' }], allowOther: false },
    { id: 'q2', question: 'What name should I use?', options: null, allowOther: true },
  ];
  hubSocket!.send(JSON.stringify({ type: 'question_answer', sessionId, requestId: 'r-1', answers: { q1: 'Blue', q2: 'Probe' }, questions, source: 'telegram' }));
  const note = await until(() => channelNotes.find((n) => n.meta?.questionId === 'r-1'));
  assert.equal(note.content, 'Answers to your questions:\n- Which color do you prefer? → Blue\n- What name should I use? → Probe');
  assert.equal(note.meta.sender, 'telegram');
  const ack = await until(() => fromChannel.find((m) => m.type === 'question_delivery' && m.requestId === 'r-1'));
  assert.deepEqual(ack, { type: 'question_delivery', sessionId, requestId: 'r-1', ok: true });
});

test('an answer for another session is ignored', async () => {
  hubSocket!.send(JSON.stringify({ type: 'question_answer', sessionId: 'someone-else', requestId: 'r-2', answers: { q1: 'x' }, questions: [{ id: 'q1', question: 'Q', options: null, allowOther: true }] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(channelNotes.some((n) => n.meta?.questionId === 'r-2'), false);
  assert.equal(fromChannel.some((m) => m.type === 'question_delivery' && m.requestId === 'r-2'), false);
});

test('with no hub the question is queued and the result says so', async () => {
  const offline = await spawnChannel(1);
  try {
    const result: any = await offline.callTool({ name: 'ask', arguments: { questions: [{ question: 'Still there?' }] } });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /The hub is not connected right now, so the question is queued/);
  } finally {
    await offline.close();
  }
});
