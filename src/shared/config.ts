import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_HUB_HOST, DEFAULT_HUB_PORT } from './constants.js';
import type { AppConfig } from './types.js';

const DEFAULT_CONFIG: AppConfig = {
  hub: {
    host: DEFAULT_HUB_HOST,
    port: DEFAULT_HUB_PORT,
  },
  notifications: {
    desktop: true,
    sound: true,
  },
  webhooks: [],
};

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): AppConfig {
  ensureConfigDir();
  let config: AppConfig;
  if (!fs.existsSync(CONFIG_FILE)) {
    config = { ...DEFAULT_CONFIG, hub: { ...DEFAULT_CONFIG.hub } };
  } else {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      config = { ...DEFAULT_CONFIG, ...parsed, hub: { ...DEFAULT_CONFIG.hub, ...parsed.hub }, ...(parsed.telegram ? { telegram: parsed.telegram } : {}) };
    } catch {
      config = { ...DEFAULT_CONFIG, hub: { ...DEFAULT_CONFIG.hub } };
    }
  }

  // Auto-generate token if missing
  if (!config.hub.token) {
    config.hub.token = randomUUID();
    saveConfig(config);
  }

  return config;
}

/** Get the current token, generating one if needed */
export function getOrCreateToken(): string {
  const config = loadConfig();
  return config.hub.token!;
}

const MIN_TOKEN_LENGTH = 16;

export function setHubToken(token: string = randomUUID()): string {
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`The token must be at least ${MIN_TOKEN_LENGTH} characters long.`);
  if (/\s/.test(token)) throw new Error('The token must not contain spaces.');
  const config = loadConfig();
  config.hub.token = token;
  saveConfig(config);
  return token;
}

// Unlike loadConfig this never writes: a config caught mid-write would otherwise be replaced by defaults and a new token.
export function readSavedToken(): string | undefined {
  try {
    const token = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))?.hub?.token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

export type TokenSource = string | (() => string | undefined);

export function hubTokenSource(envToken: string | undefined, startToken: string | undefined): TokenSource | undefined {
  if (envToken !== undefined) return envToken;
  return () => readSavedToken() ?? startToken;
}

export function currentToken(source: TokenSource | undefined): string | undefined {
  return typeof source === 'function' ? source() : source;
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function setCodexEnabled(enabled: boolean): AppConfig {
  const config = loadConfig();
  config.codex = { ...config.codex, enabled };
  saveConfig(config);
  return config;
}

export function shouldOfferCodex(config: AppConfig, installed: boolean): boolean {
  return installed && config.codex === undefined;
}

/**
 * Add claude-alarm as an MCP channel server to .mcp.json
 */
export function setupMcpConfig(targetDir?: string): string {
  const dir = targetDir ?? process.cwd();
  const mcpPath = path.join(dir, '.mcp.json');

  let mcpConfig: Record<string, any> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    } catch {
      mcpConfig = {};
    }
  }

  if (!mcpConfig.mcpServers) {
    mcpConfig.mcpServers = {};
  }

  mcpConfig.mcpServers['claude-alarm'] = {
    command: 'npx',
    args: ['-y', '@delt/claude-alarm', 'serve'],
    env: {
      CLAUDE_ALARM_SESSION_NAME: path.basename(dir),
    },
  };

  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  return mcpPath;
}
