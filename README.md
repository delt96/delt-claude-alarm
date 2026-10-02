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
- **Codex Sessions** — See and message OpenAI Codex conversations next to Claude sessions

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
| `claude-alarm codex enable` / `disable` | Start (or stop starting) the Codex adapter with the hub |
| `claude-alarm codex start` / `stop` / `status` | Run the Codex adapter on its own, e.g. when Codex runs on another PC |

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

## Codex Sessions

claude-alarm can show OpenAI Codex conversations on the dashboard and in Telegram, next to your Claude sessions.

```bash
claude-alarm codex enable
claude-alarm hub stop
claude-alarm hub start
```

`claude-alarm init` also offers this once when it finds `codex` on `PATH`. Your answer is saved, and `codex enable` / `codex disable` change it later.

- Requires the Codex CLI with its app-server daemon (`codex app-server daemon version` shows `running`). On Windows, when `codex` is not on `PATH`, the adapter also looks in the standard install locations (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, then `%APPDATA%\npm\codex.cmd`). Anywhere else, set `"codex": { "command": "C:/path/to/codex.exe" }` in `~/.claude-alarm/config.json`.
- If `codex` cannot be found at all, the hub sends one `Codex not found` notification (desktop and webhooks) and the console keeps printing `Codex daemon connection failed: spawn codex ENOENT`. A terminal opened before Codex was installed still has the old `PATH`, so open a new terminal and restart the hub, or set `codex.command`.
- Every loaded Codex conversation appears as a session with a **Codex** badge. Replies, failures and approval requests are relayed to the dashboard and Telegram.
- Messages you send show up in Codex prefixed with `[claude-alarm · Dashboard]` or `[claude-alarm · Telegram]`. If Codex is idle they start a new task; if it is working they join the current task and Codex reads them after its current step (you get a **Queued** notice). While Codex waits for an approval or for your answer, messages are not delivered; answer that first.
- Images work the same way: paste, drag & drop or 📎 on the dashboard, or send a photo to the Telegram bot (PNG, JPEG, GIF or WebP). The Codex adapter must run on the same PC as the hub to read them.
- Approvals for commands, file changes and MCP tools can be answered from the dashboard or Telegram with the choices Codex offers (for example **Allow once**, **Always allow this command**, **Cancel task**). Whoever answers first wins, in Codex or here; the other buttons close as **Resolved**, which does not say what was chosen. Buttons from before a hub or adapter restart show **Expired**; if Codex is still waiting, a new request appears.
- After updating claude-alarm, reload open dashboard tabs so they pick up the changes.
- Questions Codex asks you (not approvals) still have to be answered in Codex; claude-alarm tells you one is waiting.
- A conversation is followed only while Codex is working on it, so a closed Codex window drops off the dashboard about a minute later. If a reply could not be picked up, you get a **Reply not relayed** warning; read it in the Codex window.
- If Codex runs on another PC, run `claude-alarm codex start` there with that PC's config pointing at your hub. Keep claude-alarm at the same version on both PCs; an older hub cannot show Codex's choices.

## Permission Relay

Approve or deny Claude's tool calls remotely — from the dashboard or your phone — without `--dangerously-skip-permissions`.

When Claude wants to run a tool (Bash, Write, Edit, etc.), a permission request appears on the dashboard with **Allow / Deny** buttons. Keyboard shortcuts: **Enter** = Allow, **Esc** = Deny.

- Works with Claude Code **v2.1.81+**
- No extra setup needed — automatically enabled
- Local terminal prompt stays open; whichever answer arrives first (local or dashboard) is applied
- Parsed previews: Bash commands show `$ command`, file operations show file paths

## Authentication

Every connection to the hub needs the hub token — including ones from the same machine.

- **Channel servers** read it from `~/.claude-alarm/config.json` automatically (or `CLAUDE_ALARM_HUB_TOKEN`).
- **Dashboard**: open the login link printed by `claude-alarm hub start` (`http://127.0.0.1:7900/?token=…`), or paste the token from `claude-alarm token` into the login form. The browser keeps an HttpOnly cookie for 30 days, and the token is removed from the URL.
- **CLI / scripts**: send `Authorization: Bearer <token>`.

> Upgrading from 0.9.x: a local session that sets `CLAUDE_ALARM_HUB_TOKEN` to a different value than the hub's token no longer connects. Scripts that called the local API without a token now get `401`.

## Remote Access

<p align="center">
  <img src="https://raw.githubusercontent.com/delt96/delt-claude-alarm/main/docs/remote-access.svg" alt="Remote Access" width="600">
</p>

Pick one:

1. **Tailscale (recommended)** — set `host` to the hub machine's Tailscale IP and use that address from other machines. Traffic is encrypted and never exposed to the internet.
2. **Cloudflare Tunnel / nginx with HTTPS** — keep `host: "127.0.0.1"` and point the tunnel or proxy at `http://127.0.0.1:7900`. The proxy must keep the browser's `Host` header (the hub rejects requests whose `Origin` doesn't match it), pass WebSocket upgrades, and forward `X-Forwarded-Proto` so the dashboard cookie is marked `Secure`. For nginx:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:7900;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```
3. **Direct `0.0.0.0`** — set `host` to `0.0.0.0` and open port 7900. Traffic, including the token, is plain HTTP: use only on networks you trust.

On the remote machine run `claude-alarm init` → select remote hub (Y), or configure:

```json
{
  "mcpServers": {
    "claude-alarm": {
      "command": "npx",
      "args": ["-y", "@delt/claude-alarm", "serve"],
      "env": {
        "CLAUDE_ALARM_HUB_HOST": "your-hub-address",
        "CLAUDE_ALARM_HUB_PORT": "7900",
        "CLAUDE_ALARM_HUB_TOKEN": "your-token"
      }
    }
  }
}
```

## Mentioning Other Sessions

In the dashboard input, type `@<session name>` to have the selected session send something to another session through Claude Code's built-in `SendMessage`:

```
@front The UserVo response gained a deptNm field — let them know
```

- Names are the ones shown in the dashboard (your custom name, or the folder name). Names with spaces are written `@[my name]`.
- The dashboard resolves each mention to the target's `SendMessage` name and appends a routing line. A mention that looks like a session name but doesn't resolve to exactly one local session blocks the send; other `@words` (e.g. `@Override`, code spans) are left alone.
- Only sessions on the hub's machine can be mentioned.
- Messages exchanged between sessions are not shown in the dashboard.
- Requires Claude Code with cross-session messaging (2.1.239+ on Windows).

## Image Support

**Dashboard (local sessions):**
- **Ctrl+V** — Paste from clipboard
- **Drag & Drop** — Drop image onto message area
- **Attach button** — Click 📎 to browse files
- Images + text sent together as one message

**Telegram:**
- Send photos to the bot → forwarded to the Claude or Codex session
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
- Optional, for Codex sessions: OpenAI Codex CLI with the app-server daemon (tested with 0.159.3; approvals, steering and images also with app-server 0.160.0)

## License

MIT
