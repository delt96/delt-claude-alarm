import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { logger } from '../shared/logger.js';
import { CHANNEL_SERVER_NAME, CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { loadConfig } from '../shared/config.js';
import { HubClient } from './hub-client.js';
import { readPeerName } from './peer-name.js';
import { ASK_DROPPED, ASK_TOOL, askRequest, askResultText } from './ask.js';
import { answerText } from '../shared/questions.js';
import type { SessionStatus, NotifyLevel } from '../shared/types.js';

const sessionId = randomUUID();
const sessionName = process.env.CLAUDE_ALARM_SESSION_NAME ?? path.basename(process.cwd());
let peerName = readPeerName();

const server = new Server(
  {
    name: CHANNEL_SERVER_NAME,
    version: CHANNEL_SERVER_VERSION,
  },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: `Messages from the claude-alarm dashboard arrive as <channel source="claude-alarm" sender="...">. Read the message and act on it.

REPLYING:
- The dashboard user ONLY sees messages sent via the reply tool — your terminal output is invisible to them. You MUST call reply with your response.
- The dashboard renders Markdown (headings, lists, tables, code blocks). Provide a thorough, complete answer; do not apply CLI-style brevity.
- Reply in the user's language (match the language they wrote in).

IMAGES: If a channel message contains "[Image: ...] Read the file to view it: <path>", use the Read tool on that path before responding — otherwise the image is invisible to you.

ROUTING: If a dashboard message has lines like [claude-alarm] @X = SendMessage to "Y", do what the message asks and deliver the result with the SendMessage tool to exactly "Y". Never guess other recipients. Then reply to the dashboard with what you sent.

STATUS: Call status("working") before starting a long task, status("waiting_input") when blocked on user input, status("idle") when finished responding.

QUESTIONS: When the user can answer by picking from a few options, use ask: it shows the question with buttons in the dashboard conversation and on Telegram, and sets waiting_input for you. Its answer arrives later as a channel message starting with "Answer to your question" or "Answers to your questions". For an open question, send the whole question with reply (the context, what you need, your recommendation) and call status("waiting_input"). Never put a question only in notify: a notification is not part of the session's conversation, so the user has no place there to read the context and answer.

NOTIFICATIONS:
- Use notify only for key events that need no answer: task completion and errors. Not for intermediate steps, simple acknowledgments or questions.
- Pick level: success=completion, error=failure, warning=a problem the user should look at, info=neutral status.`,
  },
);

// Load config for hub connection (env vars take priority)
const config = loadConfig();
const hubHost = process.env.CLAUDE_ALARM_HUB_HOST ?? config.hub.host;
const hubPort = process.env.CLAUDE_ALARM_HUB_PORT ? parseInt(process.env.CLAUDE_ALARM_HUB_PORT, 10) : config.hub.port;
const hubToken = process.env.CLAUDE_ALARM_HUB_TOKEN ?? config.hub.token;

// Hub client for forwarding to central hub
const hubClient = new HubClient(
  sessionId,
  sessionName,
  hubHost,
  hubPort,
  hubToken,
  () => peerName,
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notify',
      description:
        'Send a desktop notification to the user for an event that needs no answer, such as a finished task or an error. It appears as a system toast/popup and in the dashboard\'s notification list, not in the session\'s conversation. To ask the user something, use ask or reply instead.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Notification title (short)' },
          message: { type: 'string', description: 'Notification body text' },
          level: {
            type: 'string',
            enum: ['info', 'warning', 'error', 'success'],
            description: 'Notification level (default: info)',
          },
        },
        required: ['title', 'message'],
      },
    },
    {
      name: 'reply',
      description:
        'Send a message to the web dashboard. Use this to communicate status updates, results, open questions that need the user\'s answer (use ask when they can pick from options), or any information the user should see in the monitoring dashboard. It appears in the session\'s conversation and, where enabled, is also forwarded as a desktop and Telegram notification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Message content to display on the dashboard' },
        },
        required: ['content'],
      },
    },
    ASK_TOOL,
    {
      name: 'status',
      description:
        'Update your session status displayed on the dashboard. Set to "working" when actively processing, "waiting_input" when you need user input, or "idle" when done.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['idle', 'working', 'waiting_input'],
            description: 'Current session status',
          },
        },
        required: ['status'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'notify': {
      const title = args?.title as string;
      const message = args?.message as string;
      const level = (args?.level as NotifyLevel) ?? 'info';
      logger.info(`Notify [${level}]: ${title} - ${message}`);
      hubClient.send({
        type: 'notify',
        sessionId,
        title,
        message,
        level,
      });
      return {
        content: [{ type: 'text', text: `Notification sent: "${title}"` }],
      };
    }

    case 'reply': {
      const content = args?.content as string;
      logger.info(`Reply: ${content.slice(0, 100)}...`);
      hubClient.send({
        type: 'reply',
        sessionId,
        content,
      });
      return {
        content: [{ type: 'text', text: 'Message sent to dashboard.' }],
      };
    }

    case 'ask': {
      const requestId = randomUUID();
      const built = askRequest(args, sessionId, requestId);
      if (!built.ok) {
        return { content: [{ type: 'text', text: `Question not sent: ${built.error}` }], isError: true };
      }
      const delivery = hubClient.send({ type: 'question', ...built.request });
      if (delivery === 'dropped') {
        return { content: [{ type: 'text', text: ASK_DROPPED }], isError: true };
      }
      hubClient.send({ type: 'status', sessionId, status: 'waiting_input' });
      logger.info(`Ask [${requestId}]: ${built.request.questions.length} question(s)`);
      return { content: [{ type: 'text', text: askResultText(requestId, delivery) }] };
    }

    case 'status': {
      const status = args?.status as SessionStatus;
      logger.info(`Status update: ${status}`);
      hubClient.send({
        type: 'status',
        sessionId,
        status,
      });
      return {
        content: [{ type: 'text', text: `Status updated to "${status}".` }],
      };
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// --- Permission Relay ---

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Handle permission_request from Claude Code and forward to hub
server.setNotificationHandler(
  PermissionRequestSchema,
  async (notification) => {
    const { request_id, tool_name, description, input_preview } = notification.params;
    logger.info(`Permission request [${request_id}]: ${tool_name} - ${description}`);
    hubClient.send({
      type: 'permission_request',
      sessionId,
      requestId: request_id,
      toolName: tool_name,
      description,
      inputPreview: input_preview,
      timestamp: Date.now(),
    });
  },
);

// --- Startup ---

async function main() {
  logger.info(`Starting MCP channel server (session: ${sessionId})`);

  // Connect to hub (non-blocking, will retry)
  hubClient.connect();

  // The registry entry can be written after this MCP server starts, so re-check
  // shortly after boot, then poll to follow /rename.
  const refreshPeerName = () => {
    const next = readPeerName();
    if (next === peerName) return;
    peerName = next;
    logger.info(`Peer name: ${next ?? '(none)'}`);
    hubClient.send({ type: 'peer_name', sessionId, peerName: next });
  };
  setTimeout(refreshPeerName, 2_000).unref();
  setInterval(refreshPeerName, 30_000).unref();

  // Listen for messages from hub and forward to Claude via channel notification
  hubClient.onMessage(async (msg) => {
    if (msg.type === 'message_to_session' && msg.sessionId === sessionId) {
      logger.info(`Message from dashboard: ${msg.content}`);
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: { sender: 'dashboard', timestamp: String(Date.now()) },
        },
      });
    } else if (msg.type === 'image_to_session' && msg.sessionId === sessionId) {
      logger.info(`Image from dashboard: ${msg.imagePath}`);
      const textPart = msg.content ? `\n${msg.content}` : '';
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[Image: ${msg.originalName || 'image'}] The user sent an image. Read the file to view it: ${msg.imagePath}${textPart}`,
          meta: { sender: 'dashboard', timestamp: String(Date.now()), imagePath: msg.imagePath, mimeType: msg.mimeType },
        },
      });
    } else if (msg.type === 'question_answer' && msg.sessionId === sessionId) {
      logger.info(`Answer for question ${msg.requestId}`);
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: answerText(msg.questions ?? [], msg.answers),
            meta: { sender: msg.source ?? 'dashboard', timestamp: String(Date.now()), questionId: msg.requestId },
          },
        });
        hubClient.send({ type: 'question_delivery', sessionId, requestId: msg.requestId, ok: true });
      } catch (err) {
        hubClient.send({ type: 'question_delivery', sessionId, requestId: msg.requestId, ok: false, reason: (err as Error).message });
      }
    } else if (msg.type === 'permission_response' && msg.sessionId === sessionId) {
      logger.info(`Permission verdict [${msg.requestId}]: ${msg.behavior}`);
      await server.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: msg.requestId,
          behavior: msg.behavior,
        },
      });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP channel server running on stdio');

  // Exit when stdin closes (Claude Code session ended)
  process.stdin.on('end', () => {
    logger.info('stdin closed, exiting');
    hubClient.disconnect();
    process.exit(0);
  });
  process.stdin.on('close', () => {
    logger.info('stdin closed, exiting');
    hubClient.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
