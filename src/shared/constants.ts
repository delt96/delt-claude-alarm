import path from 'node:path';
import os from 'node:os';

export const DEFAULT_HUB_HOST = '127.0.0.1';
export const DEFAULT_HUB_PORT = 7900;

export const CONFIG_DIR = path.join(os.homedir(), '.claude-alarm');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PID_FILE = path.join(CONFIG_DIR, 'hub.pid');
export const LOG_FILE = path.join(CONFIG_DIR, 'hub.log');
export const UPLOADS_DIR = path.join(CONFIG_DIR, 'uploads');
export const CODEX_PID_FILE = path.join(CONFIG_DIR, 'codex.pid');
export const CODEX_LOG_FILE = path.join(CONFIG_DIR, 'codex.log');
export const CLAUDE_LIMITS_FILE = path.join(CONFIG_DIR, 'limits-claude.json');
export const STATUSLINE_ORIGINAL_FILE = path.join(CONFIG_DIR, 'statusline-original.json');

export const WS_PATH_CHANNEL = '/ws/channel';
export const WS_PATH_DASHBOARD = '/ws/dashboard';
export const WS_PATH_CODEX = '/ws/codex';

export const HUB_FEATURES: readonly string[] = ['questions', 'context_tokens'];

export const CHANNEL_SERVER_NAME = 'claude-alarm';
export const CHANNEL_SERVER_VERSION = '0.1.0';
