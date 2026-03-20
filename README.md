# claude-alarm

Monitor and interact with multiple Claude Code sessions from a web dashboard. Get desktop notifications when tasks complete, send messages to Claude, and track session status — all through MCP Channels.

```
[Dashboard]  ──message──>  [Hub Server]  ──WebSocket──>  [Channel Server]  ──>  Claude Code
                                                              <──
Claude Code  ──reply/notify──>  [Channel Server]  ──>  [Hub Server]  ──>  [Dashboard]
```

## Features

- **Web Dashboard** — Monitor all Claude Code sessions in one place
- **Two-way Messaging** — Send messages to Claude and receive replies (with markdown rendering)
- **Desktop Notifications** — Get Windows/macOS/Linux toast notifications
- **Session Status** — See which sessions are idle, working, or waiting for input
- **Token Auth** — Secure hub access with auto-generated tokens
- **Multi-session** — Connect multiple Claude Code instances simultaneously

## Quick Start

### 1. Install & Initialize

In your project directory:

```bash
npx @delt/claude-alarm init
```

This creates `.mcp.json` with the claude-alarm channel server config.

### 2. Start the Hub

```bash
npx @delt/claude-alarm hub start
```

This starts the hub server and prints your auth token.

### 3. Run Claude Code

```bash
claude --dangerously-load-development-channels server:claude-alarm
```

To allow remote control without approval prompts:

```bash
claude --dangerously-load-development-channels server:claude-alarm --dangerously-skip-permissions
```

> **WARNING:** `--dangerously-skip-permissions` allows Claude to execute any action without your approval. Only use in trusted, isolated environments.

### 4. Open Dashboard

Open `http://127.0.0.1:7890` in your browser.

## CLI Commands

```
claude-alarm init             Setup everything and show next steps
claude-alarm hub start [-d]   Start the hub server (-d for daemon mode)
claude-alarm hub stop         Stop the hub daemon
claude-alarm hub status       Show hub status
claude-alarm setup [dir]      Add claude-alarm to .mcp.json
claude-alarm test             Send a test notification
claude-alarm token            Show current auth token
```

## How It Works

claude-alarm uses [MCP Channels](https://modelcontextprotocol.io) to create a communication bridge between Claude Code and a web dashboard.

- **Hub Server** — Central server that manages sessions, serves the dashboard, and routes messages
- **Channel Server** — MCP server that runs inside Claude Code, providing tools and forwarding messages
- **Dashboard** — Web UI for monitoring sessions and sending messages

### Tools Available to Claude

| Tool | Description |
|------|-------------|
| `notify` | Send a desktop notification (title, message, level) |
| `reply` | Send a message to the dashboard |
| `status` | Update session status (idle, working, waiting_input) |

## Configuration

Config is stored at `~/.claude-alarm/config.json`:

```json
{
  "hub": {
    "host": "127.0.0.1",
    "port": 7890,
    "token": "auto-generated-uuid"
  },
  "notifications": {
    "desktop": true,
    "sound": true
  },
  "webhooks": []
}
```

### Custom Session Names

The `.mcp.json` created by `claude-alarm init` automatically uses the project directory name as the session name. You can customize it:

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

Send notifications to external services:

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

## Remote Access

To access the hub from another machine:

1. Set host to `0.0.0.0` in `~/.claude-alarm/config.json`
2. Open port 7890 in your firewall
3. On the remote machine, run `claude-alarm init` and select remote hub (Y), or manually set `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-alarm": {
      "command": "npx",
      "args": ["-y", "@delt/claude-alarm", "serve"],
      "env": {
        "CLAUDE_ALARM_HUB_HOST": "your-server-ip",
        "CLAUDE_ALARM_HUB_PORT": "7890",
        "CLAUDE_ALARM_HUB_TOKEN": "your-token"
      }
    }
  }
}
```

## Platform Support

Desktop notifications work across all major platforms via [node-notifier](https://github.com/mikaelbr/node-notifier):

| Platform | Notification Engine | Click to Open |
|----------|-------------------|---------------|
| Windows  | SnoreToast (built-in) | `Start-Process` |
| macOS    | terminal-notifier | `open` |
| Linux    | notify-send (libnotify) | `xdg-open` |

No additional setup needed — `node-notifier` automatically detects your OS and uses the appropriate tool.

## Requirements

- Node.js >= 18
- Claude Code with MCP Channels support

## License

MIT
