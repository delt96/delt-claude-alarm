# claude-alarm

> Multi-session monitoring dashboard for Claude Code via MCP Channels

Monitor and interact with multiple Claude Code sessions from a web dashboard. Get desktop notifications when tasks complete, send messages to Claude, and track session status.

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/delt96/delt-claude-alarm/main/docs/architecture.svg" alt="Architecture" width="800">
</p>

## Features

- **Multi-Session Monitoring** — Real-time session status (idle / working / waiting)
- **Two-way Messaging** — Text + markdown + image exchange with Claude
- **Desktop Notifications** — Windows / macOS / Linux toast alerts
- **Telegram Integration** — Two-way messaging via Telegram bot
- **Webhook Support** — Slack, Discord, or custom webhook endpoints
- **Token Auth** — Auto-generated secure access
- **Dark / Light Mode** — Theme toggle with persistence
- **Multi-Machine** — Remote hub access support

## Quick Start

### 1. Install

```bash
npm install -g @delt/claude-alarm
```

### 2. Start the Hub

```bash
claude-alarm hub start
```

### 3. Initialize Project

```bash
cd your-project
claude-alarm init
```

### 4. Run Claude Code

```bash
claude --dangerously-load-development-channels server:claude-alarm
```

### 5. Open Dashboard

Open `http://127.0.0.1:7900` in your browser.

## Message Flow

<p align="center">
  <img src="https://raw.githubusercontent.com/delt96/delt-claude-alarm/main/docs/message-flow.svg" alt="Message Flow" width="700">
</p>

## Dashboard

<p align="center">
  <img src="https://raw.githubusercontent.com/delt96/delt-claude-alarm/main/docs/dashboard-preview.png" alt="Dashboard" width="800">
</p>

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-alarm init` | Setup project and show next steps |
| `claude-alarm hub start [-d]` | Start hub server (`-d` for daemon) |
| `claude-alarm hub stop` | Stop hub daemon |
| `claude-alarm hub status` | Show hub status |
| `claude-alarm token` | Show auth token |
| `claude-alarm test` | Send test notification |

## Tools Available to Claude

| Tool | Description |
|------|-------------|
| `notify` | Send a desktop notification (title, message, level) |
| `reply` | Send a message to the dashboard |
| `status` | Update session status (idle, working, waiting_input) |

## Configuration

Config stored at `~/.claude-alarm/config.json`:

```json
{
  "hub": {
    "host": "127.0.0.1",
    "port": 7900,
    "token": "auto-generated-uuid"
  },
  "notifications": {
    "desktop": true,
    "sound": true
  },
  "webhooks": [],
  "telegram": {
    "botToken": "",
    "chatId": "",
    "enabled": false
  }
}
```

### Custom Session Names

```json
{
  "mcpServers": {
    "claude-alarm": {
      "command": "npx",
      "args": ["-y", "@delt/claude-alarm", "serve"],
      "env": {
        "CLAUDE_ALARM_SESSION_NAME": "my-project"
      }
    }
  }
}
```

### Webhooks

Configure via dashboard (⚙ Settings → Webhook tab) or in config:

```json
{
  "webhooks": [
    {
      "url": "https://hooks.slack.com/services/...",
      "headers": { "Content-Type": "application/json" }
    }
  ]
}
```

### Telegram Bot

Two-way messaging with Claude sessions via Telegram:

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Send any message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your Chat ID
3. Open dashboard → ⚙ Settings → Telegram tab
4. Enter Bot Token + Chat ID → Test → Save

**Features:**
- Notifications forwarded to Telegram with session labels
- Reply to a notification message → routed to the correct session
- Send a new message → auto-delivered if 1 session, or pick from a list

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "your-chat-id",
    "enabled": true
  }
}
```

## Remote Access

<p align="center">
  <img src="https://raw.githubusercontent.com/delt96/delt-claude-alarm/main/docs/remote-access.svg" alt="Remote Access" width="600">
</p>

1. Set host to `0.0.0.0` in `~/.claude-alarm/config.json`
2. Open port 7900 in your firewall
3. On remote machine: `claude-alarm init` → select remote hub (Y)

```json
{
  "mcpServers": {
    "claude-alarm": {
      "command": "npx",
      "args": ["-y", "@delt/claude-alarm", "serve"],
      "env": {
        "CLAUDE_ALARM_HUB_HOST": "your-server-ip",
        "CLAUDE_ALARM_HUB_PORT": "7900",
        "CLAUDE_ALARM_HUB_TOKEN": "your-token"
      }
    }
  }
}
```

## Image Upload (Local Sessions)

Send images to Claude via the dashboard:
- **Ctrl+V** — Paste from clipboard
- **Drag & Drop** — Drop image onto message area
- **Attach button** — Click 📎 to browse files

> Images are only available for local sessions (same machine as Hub). Max 10MB, auto-deleted after 5 minutes.

## Platform Support

| Platform | Notifications | Engine |
|----------|:---:|--------|
| Windows | ✓ | SnoreToast |
| macOS | ✓ | terminal-notifier |
| Linux | ✓ | notify-send |

## Requirements

- Node.js >= 18
- Claude Code with MCP Channels support

## License

MIT
