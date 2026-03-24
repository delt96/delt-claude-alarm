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
- **Permission Relay** — Approve/deny tool calls from dashboard or phone
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

Two-way messaging with Claude sessions via Telegram — text and images.

**Setup (guided wizard in dashboard):**

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Open dashboard → ⚙ Settings → Telegram tab
3. **Step 1:** Paste your Bot Token → Next
4. **Step 2:** Send any message to your bot, then click **Detect Chat ID** → select your chat → Next
5. **Step 3:** Send Test → Save

**Features:**
- Notifications forwarded to Telegram with session labels
- Reply to a notification → routed to the correct session
- Send a new message → auto-delivered if 1 session, or pick from a list
- Send photos from Telegram → downloaded and forwarded to Claude
- Photo captions included as text alongside the image

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "your-chat-id",
    "enabled": true
  }
}
```

## Permission Relay

Approve or deny Claude's tool calls remotely — from the dashboard or your phone — without `--dangerously-skip-permissions`.

When Claude wants to run a tool (Bash, Write, Edit, etc.), a permission request appears on the dashboard with **Allow / Deny** buttons. Keyboard shortcuts: **Enter** = Allow, **Esc** = Deny.

- Works with Claude Code **v2.1.81+**
- No extra setup needed — automatically enabled
- Local terminal prompt stays open; whichever answer arrives first (local or dashboard) is applied
- Parsed previews: Bash commands show `$ command`, file operations show file paths

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

## Image Support

**Dashboard (local sessions):**
- **Ctrl+V** — Paste from clipboard
- **Drag & Drop** — Drop image onto message area
- **Attach button** — Click 📎 to browse files
- Images + text sent together as one message

**Telegram:**
- Send photos to the bot → forwarded to Claude session
- Photo captions included as text

> Dashboard images are only available for local sessions (same machine as Hub). Max 10MB, auto-deleted after 5 minutes.

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
