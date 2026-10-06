import './isolate-home.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Every Claude session learns from these texts which tool to ask the user with;
// a question sent only as notify never reaches the session's conversation.
let client: Client;

before(async () => {
  client = new Client({ name: 'channel-guidance-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join('src', 'channel', 'server.ts')],
    env: { ...process.env, CLAUDE_ALARM_HUB_HOST: '127.0.0.1', CLAUDE_ALARM_HUB_PORT: '1' } as Record<string, string>,
    stderr: 'ignore',
  }));
});

after(async () => {
  await client.close();
});

async function toolDescription(name: string): Promise<string> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is listed`);
  return tool.description ?? '';
}

test('the session guidance sends a question through reply and then waits for input', () => {
  const instructions = client.getInstructions() ?? '';
  const questions = instructions.match(/QUESTIONS:([^]*?)(?:\n\n|$)/)?.[1] ?? '';
  assert.match(questions, /\breply\b/);
  assert.match(questions, /waiting_input/);
  assert.match(questions, /never put a question only in notify/i);
});

test('the session guidance keeps notify for events that need no answer', () => {
  const instructions = client.getInstructions() ?? '';
  assert.doesNotMatch(instructions, /user attention is needed/);
  const notifications = instructions.match(/NOTIFICATIONS:([^]*?)(?:\n\n|$)/)?.[1] ?? '';
  assert.match(notifications, /need no answer/);
});

test('the notify tool points questions to reply', async () => {
  const description = await toolDescription('notify');
  assert.doesNotMatch(description, /need user attention/);
  assert.match(description, /ask the user something, use reply/i);
});

test('the reply tool says questions belong in it', async () => {
  assert.match(await toolDescription('reply'), /question/i);
});
