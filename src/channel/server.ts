import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { logger } from '../shared/logger.js';
import { CHANNEL_SERVER_NAME, CHANNEL_SERVER_VERSION } from '../shared/constants.js';
import { loadConfig } from '../shared/config.js';
import { HubClient } from './hub-client.js';
import type { SessionStatus, NotifyLevel } from '../shared/types.js';

const sessionId = randomUUID();
const sessionName = process.env.CLAUDE_ALARM_SESSION_NAME ?? path.basename(process.cwd());

const server = new Server(
  {
    name: CHANNEL_SERVER_NAME,
    version: CHANNEL_SERVER_VERSION,
  },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Messages from the claude-alarm dashboard arrive as <channel source="claude-alarm" sender="...">. ' +
      'Read the message and act on it. Reply with the same detail and depth as you normally would — do not shorten your response. ' +
      'IMPORTANT: The dashboard user can ONLY see messages sent via the reply tool. Your terminal output is NOT visible on the dashboard. ' +
      'Therefore, when responding to a dashboard message, you MUST call the reply tool with your response so the dashboard user can see it. ' +
      'Use the notify tool to send desktop notifications for key events: task completion, errors, or when user input is needed. ' +
      'Do NOT notify for intermediate steps or simple acknowledgments. ' +
      'Use the status tool to update your session status.',
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
);

// --- Tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notify',
      description:
        'Send a desktop notification to the user. Use this when you complete a task, encounter an error, or need user attention. The notification will appear as a system toast/popup.',
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
        'Send a message to the web dashboard. Use this to communicate status updates, results, or any information the user should see in the monitoring dashboard.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Message content to display on the dashboard' },
        },
        required: ['content'],
      },
    },
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

// --- Startup ---

async function main() {
  logger.info(`Starting MCP channel server (session: ${sessionId})`);

  // Connect to hub (non-blocking, will retry)
  hubClient.connect();

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
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[Image: ${msg.originalName || 'image'}] The user sent an image. Read the file to view it: ${msg.imagePath}`,
          meta: { sender: 'dashboard', timestamp: String(Date.now()), imagePath: msg.imagePath, mimeType: msg.mimeType },
        },
      });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP channel server running on stdio');
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
