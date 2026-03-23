# claude-alarm

> Multi-session monitoring dashboard for Claude Code via MCP Channels

Monitor and interact with multiple Claude Code sessions from a web dashboard. Get desktop notifications when tasks complete, send messages to Claude, and track session status.

## Architecture

```mermaid
graph LR
    subgraph "Your Machine"
        CC1["Claude Code<br/>(Session 1)"] --> CS1["Channel Server"]
        CC2["Claude Code<br/>(Session 2)"] --> CS2["Channel Server"]
        CC3["Claude Code<br/>(Session 3)"] --> CS3["Channel Server"]
    end

    CS1 -->|WebSocket| HUB["Hub Server<br/>:7900"]
    CS2 -->|WebSocket| HUB
    CS3 -->|WebSocket| HUB

    HUB -->|HTTP| DASH["Web Dashboard"]
    HUB -->|Toast| NOTIF["Desktop<br/>Notifications"]

    subgraph "Remote Machine (optional)"
        CC4["Claude Code<br/>(Session 4)"] --> CS4["Channel Server"]
    end
    CS4 -->|WebSocket| HUB

    style HUB fill:#7c6aef,stroke:#5a4db8,color:#fff
    style DASH fill:#3dd68c,stroke:#22a06b,color:#000
    style NOTIF fill:#f5c542,stroke:#d4a72c,color:#000
```

## Features

```mermaid
graph TD
    A["Multi-Session<br/>Monitoring"] --> |"real-time"| B["Session Status<br/>idle · working · waiting"]
    A --> |"two-way"| C["Message Exchange<br/>text + markdown + images"]
    A --> |"alerts"| D["Desktop Notifications<br/>Windows · macOS · Linux"]
    A --> |"security"| E["Token Auth<br/>auto-generated"]
    A --> |"theme"| F["Dark / Light Mode"]
    A --> |"remote"| G["Multi-Machine<br/>Support"]

    style A fill:#7c6aef,stroke:#5a4db8,color:#fff
    style B fill:#60a5fa,stroke:#3b82f6,color:#000
    style C fill:#3dd68c,stroke:#22a06b,color:#000
    style D fill:#f5c542,stroke:#d4a72c,color:#000
    style E fill:#ef4444,stroke:#dc2626,color:#fff
    style F fill:#8b8fa3,stroke:#6b7280,color:#fff
    style G fill:#a78bfa,stroke:#7c3aed,color:#000
```

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

```mermaid
sequenceDiagram
    participant D as Dashboard
    participant H as Hub Server
    participant C as Channel Server
    participant CC as Claude Code

    D->>H: Send message
    H->>C: Forward via WebSocket
    C->>CC: MCP Channel notification
    CC->>CC: Process & execute
    CC->>C: Call reply tool
    C->>H: Forward reply
    H->>D: Display in chat
    H->>H: Desktop notification
```

## Dashboard Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Alarm                              ☽  ● Connected  │
├──────────────┬──────────────────────┬───────────────────────┤
│  SESSIONS    │  Messages            │  NOTIFICATIONS        │
│              │                      │                       │
│ ┌──────────┐ │  ┌─────────────────┐ │  ┌─────────────────┐ │
│ │ my-app   │ │  │ Claude · 14:30  │ │  │ ● Task complete │ │
│ │ idle     │ │  │ Build succeeded │ │  │   my-app · 14:30│ │
│ └──────────┘ │  └─────────────────┘ │  └─────────────────┘ │
│ ┌──────────┐ │                      │  ┌─────────────────┐ │
│ │ api-svc  │ │       ┌────────────┐ │  │ ● Error found   │ │
│ │ working  │ │       │ You · 14:31│ │  │   api-svc · 14:2│ │
│ └──────────┘ │       │ Fix the bug│ │  └─────────────────┘ │
│ ┌──────────┐ │       └────────────┘ │                       │
│ │ frontend │ │                      │                       │
│ │ waiting  │ │                      │                       │
│ └──────────┘ │                      │                       │
├──────────────┴──────────────────────┴───────────────────────┤
│  📎 [Message input...  Shift+Enter ↵]           [ Send ]   │
└─────────────────────────────────────────────────────────────┘
```

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
  "webhooks": []
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

```mermaid
graph LR
    subgraph "Hub PC"
        HUB["Hub Server<br/>0.0.0.0:7900"]
    end

    subgraph "Remote PC"
        RC["Claude Code"] --> RCS["Channel Server"]
    end

    subgraph "Browser (any device)"
        DASH["Dashboard"]
    end

    RCS -->|"WS + token"| HUB
    DASH -->|"HTTP + token"| HUB

    style HUB fill:#7c6aef,stroke:#5a4db8,color:#fff
```

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
