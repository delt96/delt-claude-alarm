import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureConfigDir, setupMcpConfig, getOrCreateToken, setCodexEnabled, shouldOfferCodex } from './shared/config.js';
import { findCodex } from './codex/transport.js';
import { runFromCli } from './codex/run.js';
import { exitAfterFlush } from './codex/shutdown.js';
import { PID_FILE, LOG_FILE, DEFAULT_HUB_HOST, DEFAULT_HUB_PORT, CODEX_PID_FILE, CODEX_LOG_FILE, CONFIG_DIR, CONFIG_FILE } from './shared/constants.js';
import { logger } from './shared/logger.js';
import { installCrashGuard, logStartup } from './shared/crash-guard.js';
import { waitForHub, HUB_START_TIMEOUT_MS } from './hub/readiness.js';
import { hubUrlHost } from './shared/hub-url.js';
import { resolveAdapterHub } from './codex/hub-target.js';
import { startAdapter } from './codex/start-check.js';
import { controlEndpoint, queryOwner, requestStop } from './codex/instance-lock.js';
import { adapterStatus, legacyNote, stopAdapter, type ControlDeps } from './codex/control-cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function loginLink(displayHost: string, port: number, token?: string): string {
  return `http://${displayHost}:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

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
  claude-alarm codex enable     Start the Codex adapter together with the hub
  claude-alarm codex disable    Stop starting the Codex adapter with the hub
  claude-alarm codex start      Run the Codex adapter on its own (e.g. Codex on another PC)
  claude-alarm codex stop       Stop a running Codex adapter
  claude-alarm codex status     Show Codex adapter status
  claude-alarm codex run --brief <file|-> [--cwd <dir>] [--thread <id>] [--name <title>]
                         [--output-schema <file>] [--effort <level>] [--approval-timeout <min>] [--timeout <min>] [--yolo]
                                Hand a task to Codex through the shared daemon and print the result as JSON
                                (--effort: the turn's reasoning effort, one the model offers, e.g. low, medium, high, xhigh;
                                 it carries over to later turns on the thread)
                                (--yolo: no sandbox and no approvals, like codex --yolo)
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
  const displayHost = hubUrlHost(host);

  // Check for updates (non-blocking)
  checkForUpdates();

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      console.log(`Hub is already running (PID: ${pid}). Dashboard: ${loginLink(displayHost, port, config.hub.token)}`);
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

    const pid = child.pid;
    if (!pid) {
      console.error('Failed to start hub daemon');
      process.exit(1);
    }
    fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
    let exited = false;
    child.once('exit', () => { exited = true; });
    child.unref();

    const startup = await waitForHub({
      url: `http://${displayHost}:${port}/api/status`,
      token: config.hub.token,
      pid,
      isAlive: () => !exited,
    });
    if (startup !== 'ready') {
      if (!exited) child.kill();
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      console.error(startup === 'exited'
        ? `Hub exited during startup. See ${LOG_FILE}`
        : `Hub did not answer at http://${displayHost}:${port} within ${HUB_START_TIMEOUT_MS / 1000}s and was stopped. See ${LOG_FILE}`);
      process.exit(1);
    }

    console.log(`Hub started as daemon (PID: ${pid})`);
    console.log(`Dashboard: ${loginLink(displayHost, port, config.hub.token)}`);
    console.log(`Token: ${config.hub.token}`);
    console.log(`Logs: ${LOG_FILE}`);
  } else {
    // Foreground mode - import and run directly
    console.log(`Starting hub on http://${displayHost}:${port} (press Ctrl+C to stop)`);
    console.log(`Dashboard: ${loginLink(displayHost, port, config.hub.token)}`);
    console.log(`Token: ${config.hub.token}`);
    console.log(`Logs: ${LOG_FILE}`);
    installCrashGuard('hub foreground');
    logStartup('Hub foreground');
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
  const displayHost = hubUrlHost(host);

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
    const res = await fetch(`http://${displayHost}:${port}/api/status`, { headers: authHeaders(config.hub.token) });
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
    const res = await fetch(`http://${hubUrlHost(host)}:${port}/api/notify`, {
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
    const displayHost = hubUrlHost(host);
    let hubRunning = false;
    try {
      const res = await fetch(`http://${displayHost}:${port}/api/status`, { headers: authHeaders(config.hub.token) });
      hubRunning = res.ok;
    } catch {}

    if (hubRunning) {
      console.log('✓ Hub is running');
    } else {
      console.log('✗ Hub is not running. Start it with:');
      console.log(`  claude-alarm hub start`);
    }
    console.log(`  Dashboard: http://${displayHost}:${port}`);

    if (shouldOfferCodex(config, findCodex('codex') !== undefined)) {
      const answer = await ask('\nCodex is installed. Show Codex conversations on the dashboard too? (y/N): ');
      if (answer.toLowerCase() === 'y') codexEnable(true);
      else setCodexEnabled(false);
    }
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

function readCodexPid(): number | undefined {
  if (!fs.existsSync(CODEX_PID_FILE)) return undefined;
  const pid = parseInt(fs.readFileSync(CODEX_PID_FILE, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? undefined : pid;
}

function codexEnable(enabled: boolean) {
  setCodexEnabled(enabled);
  console.log(enabled
    ? 'Codex adapter enabled. Restart the hub to apply: claude-alarm hub stop, then claude-alarm hub start'
    : 'Codex adapter disabled. Restart the hub to apply.');
}

async function codexStart() {
  // Before spawning: on a fresh PC this creates and saves the token, so the adapter reads the same one.
  const config = loadConfig();
  ensureConfigDir();
  legacyNote(controlDeps());
  const code = await startAdapter({
    hub: resolveAdapterHub(config),
    command: config.codex?.command ?? 'codex',
    logFile: CODEX_LOG_FILE,
    queryOwner: () => queryOwner(controlEndpoint(CONFIG_DIR)),
    spawnAdapter: () => {
      const logFd = fs.openSync(CODEX_LOG_FILE, 'a');
      return spawn(process.execPath, [path.join(__dirname, 'codex', 'main.js')], {
        detached: true,
        stdio: ['ignore', logFd, logFd, 'ipc'],
        windowsHide: true,
        env: { ...process.env },
      });
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  if (code !== 0) process.exit(code);
}

function controlDeps(): ControlDeps {
  const endpoint = controlEndpoint(CONFIG_DIR);
  const token = loadConfig().hub.token ?? '';
  return {
    queryOwner: () => queryOwner(endpoint),
    requestStop: () => requestStop(endpoint, token),
    legacyPid: readCodexPid,
    isRunning: isProcessRunning,
    removeLegacyPidFile: () => {
      try { fs.unlinkSync(CODEX_PID_FILE); } catch {}
    },
    legacyPidFile: CODEX_PID_FILE,
    configFile: CONFIG_FILE,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

async function codexRun(argv: string[]): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await runFromCli(argv, {
      readFile: (file) => fs.promises.readFile(file, 'utf-8'),
      readStdin: async () => {
        let text = '';
        for await (const chunk of process.stdin) text += chunk;
        return text;
      },
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
      cwd: process.cwd(),
      signal: abort.signal,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
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

  if (cmd === 'codex') {
    if (sub === 'enable') codexEnable(true);
    else if (sub === 'disable') codexEnable(false);
    else if (sub === 'start') await codexStart();
    else if (sub === 'stop') process.exitCode = await stopAdapter(controlDeps(), loadConfig().codex?.enabled === true);
    else if (sub === 'status') process.exitCode = await adapterStatus(controlDeps(), loadConfig().codex?.enabled === true);
    else if (sub === 'run') {
      const code = await codexRun(args.slice(2));
      // A surviving proxy can retain pipe handles even after cleanup resolves.
      exitAfterFlush(code, process.stdout, process.stderr);
    }
    else {
      console.error(`Unknown codex command: ${sub}`);
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
