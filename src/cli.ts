import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureConfigDir, setupMcpConfig, getOrCreateToken } from './shared/config.js';
import { PID_FILE, LOG_FILE, DEFAULT_HUB_HOST, DEFAULT_HUB_PORT } from './shared/constants.js';
import { logger } from './shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printUsage() {
  console.log(`
claude-alarm - Monitor Claude Code sessions with notifications

Usage:
  claude-alarm init             Setup everything and show next steps
  claude-alarm hub start [-d]   Start the hub server (-d for daemon)
  claude-alarm hub stop         Stop the hub daemon
  claude-alarm hub status       Show hub status
  claude-alarm setup [dir]      Add claude-alarm to .mcp.json
  claude-alarm test             Send a test notification
  claude-alarm token            Show current auth token
  claude-alarm help             Show this help

Quick start:
  claude-alarm init
`);
}

async function checkForUpdates() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const currentVersion = pkg.version;

    const res = await fetch('https://registry.npmjs.org/@delt/claude-alarm/latest', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = await res.json() as { version: string };
    const latestVersion = data.version;

    if (latestVersion !== currentVersion) {
      console.log(`\n⚠ New version available: ${currentVersion} → ${latestVersion}`);
      console.log(`  Run: npm install -g @delt/claude-alarm\n`);
    }
  } catch {
    // Silent fail - don't block startup
  }
}

async function hubStart(daemon: boolean) {
  const config = loadConfig();
  const host = config.hub.host ?? DEFAULT_HUB_HOST;
  const port = config.hub.port ?? DEFAULT_HUB_PORT;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  // Check for updates (non-blocking)
  checkForUpdates();

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`Hub is already running (PID: ${pid}) on http://${displayHost}:${port}`);
      return;
    }
    // Stale PID file
    fs.unlinkSync(PID_FILE);
  }

  if (daemon) {
    ensureConfigDir();
    const logFd = fs.openSync(LOG_FILE, 'a');
    const hubScript = path.join(__dirname, 'hub', 'server.js');

    const child = spawn(process.execPath, [hubScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });

    if (child.pid) {
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8');
      child.unref();
      console.log(`Hub started as daemon (PID: ${child.pid})`);
      console.log(`Dashboard: http://${displayHost}:${port}`);
      console.log(`Token: ${config.hub.token}`);
      console.log(`Logs: ${LOG_FILE}`);
    } else {
      console.error('Failed to start hub daemon');
      process.exit(1);
    }
  } else {
    // Foreground mode - import and run directly
    console.log(`Starting hub on http://${displayHost}:${port} (press Ctrl+C to stop)`);
    console.log(`Token: ${config.hub.token}`);
    const { HubServer } = await import('./hub/server.js');
    const hub = new HubServer(config);
    await hub.start();

    // Write PID file even in foreground
    ensureConfigDir();
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');

    const shutdown = async () => {
      console.log('\nShutting down...');
      await hub.stop();
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

function hubStop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Hub is not running (no PID file found)');
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Hub stopped (PID: ${pid})`);
  } catch {
    console.log('Hub process not found (may have already stopped)');
  }
  fs.unlinkSync(PID_FILE);
}

async function hubStatus() {
  const config = loadConfig();
  const host = config.hub.host ?? DEFAULT_HUB_HOST;
  const port = config.hub.port ?? DEFAULT_HUB_PORT;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  // Check PID file
  let pidInfo = 'not running';
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      pidInfo = `running (PID: ${pid})`;
    } else {
      pidInfo = 'not running (stale PID file)';
    }
  }

  // Try to reach the hub HTTP API
  try {
    const res = await fetch(`http://${host}:${port}/api/status`);
    if (res.ok) {
      const data = await res.json() as any;
      console.log(`Hub: running (PID: ${data.pid})`);
      console.log(`Port: ${data.port}`);
      console.log(`Sessions: ${data.sessions}`);
      console.log(`Uptime: ${Math.round(data.uptime / 1000)}s`);
      console.log(`Dashboard: http://${displayHost}:${port}`);
      const token = config.hub.token;
      if (token) {
        console.log(`Token: ${token.slice(0, 8)}...(masked)`);
      }
      return;
    }
  } catch {
    // Hub not reachable
  }

  console.log(`Hub: ${pidInfo}`);
  console.log(`Configured: http://${displayHost}:${port}`);
}

function setup(targetDir?: string) {
  const mcpPath = setupMcpConfig(targetDir);
  console.log(`Added claude-alarm to ${mcpPath}`);
  console.log('\nTo use with Claude Code:');
  console.log('  1. Start the hub: claude-alarm hub start -d');
  console.log('  2. Run Claude Code: claude --dangerously-load-development-channels server:claude-alarm');
}

async function test() {
  const config = loadConfig();
  const host = config.hub.host ?? DEFAULT_HUB_HOST;
  const port = config.hub.port ?? DEFAULT_HUB_PORT;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.hub.token) {
      headers['Authorization'] = `Bearer ${config.hub.token}`;
    }
    const res = await fetch(`http://${host}:${port}/api/notify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Test Notification',
        message: 'Claude Alarm is working! This is a test notification.',
        level: 'success',
      }),
    });

    if (res.ok) {
      console.log('Test notification sent! Check your desktop for the toast.');
    } else {
      console.error(`Hub returned ${res.status}. Is the hub running?`);
    }
  } catch {
    console.error('Could not reach hub. Start it first: claude-alarm hub start');
  }
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function init() {
  const dir = process.cwd();
  const projectName = path.basename(dir);

  console.log(`\nclaude-alarm init for "${projectName}"\n`);

  const remote = await ask('Connect to a remote hub? (y/N): ');

  let env: Record<string, string> = {
    CLAUDE_ALARM_SESSION_NAME: projectName,
  };

  if (remote.toLowerCase() === 'y') {
    const host = await ask('Hub host (e.g. 192.168.1.100): ');
    const port = await ask('Hub port (default: 7900): ');
    const token = await ask('Hub token: ');

    if (!host) {
      console.error('Host is required.');
      process.exit(1);
    }
    env.CLAUDE_ALARM_HUB_HOST = host;
    if (port) env.CLAUDE_ALARM_HUB_PORT = port;
    if (token) env.CLAUDE_ALARM_HUB_TOKEN = token;
  }

  // Write .mcp.json
  const mcpPath = path.join(dir, '.mcp.json');
  let mcpConfig: Record<string, any> = {};
  if (fs.existsSync(mcpPath)) {
    try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); } catch { mcpConfig = {}; }
  }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  mcpConfig.mcpServers['claude-alarm'] = {
    command: 'npx',
    args: ['-y', '@delt/claude-alarm', 'serve'],
    env,
  };
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');

  console.log(`\n✓ Created ${mcpPath}`);

  if (remote.toLowerCase() !== 'y') {
    // Check if hub is running locally
    const config = loadConfig();
    const host = config.hub.host ?? DEFAULT_HUB_HOST;
    const port = config.hub.port ?? DEFAULT_HUB_PORT;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    let hubRunning = false;
    try {
      const res = await fetch(`http://${host}:${port}/api/status`);
      hubRunning = res.ok;
    } catch {}

    if (hubRunning) {
      console.log('✓ Hub is running');
    } else {
      console.log('✗ Hub is not running. Start it with:');
      console.log(`  claude-alarm hub start`);
    }
    console.log(`  Dashboard: http://${displayHost}:${port}`);
  }

  console.log(`\nNext step:`);
  console.log(`  claude --dangerously-load-development-channels server:claude-alarm`);
  console.log(`\nTo skip permission prompts (allows remote control without approval):`);
  console.log(`  claude --dangerously-load-development-channels server:claude-alarm --dangerously-skip-permissions`);
  console.log(`\n  WARNING: --dangerously-skip-permissions allows Claude to execute any action`);
  console.log(`  without your approval. Only use in trusted, isolated environments.\n`);
}

function showToken() {
  const token = getOrCreateToken();
  console.log(`Token: ${token}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Main CLI ---
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  if (cmd === 'serve') {
    // Start channel server (used by MCP)
    await import('./channel/server.js');
    return;
  }

  if (cmd === 'init') {
    await init();
    return;
  }

  if (cmd === 'hub') {
    if (sub === 'start') {
      const daemon = args.includes('-d') || args.includes('--daemon');
      await hubStart(daemon);
    } else if (sub === 'stop') {
      hubStop();
    } else if (sub === 'status') {
      await hubStatus();
    } else {
      console.error(`Unknown hub command: ${sub}`);
      printUsage();
      process.exit(1);
    }
    return;
  }

  if (cmd === 'setup') {
    setup(args[1]);
    return;
  }

  if (cmd === 'test') {
    await test();
    return;
  }

  if (cmd === 'token') {
    showToken();
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  logger.error('CLI error:', err);
  process.exit(1);
});
