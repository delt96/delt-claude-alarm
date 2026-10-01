/** Session status */
export type SessionStatus = 'idle' | 'working' | 'waiting_input';

export type AgentKind = 'claude' | 'codex';

export type MessageSource = 'dashboard' | 'telegram' | 'api';

export interface PermissionChoice {
  id: string;
  label: string;
}

/** Session info tracked by the hub */
export interface SessionInfo {
  id: string;
  name: string;
  displayName?: string;
  status: SessionStatus;
  connectedAt: number;
  lastActivity: number;
  cwd?: string;
  channelEnabled?: boolean;
  isLocal?: boolean;
  peerName?: string;
  agentKind?: AgentKind;
  title?: string;
}

/** Messages sent between channel server and hub */
export type ChannelMessage =
  | { type: 'register'; session: SessionInfo }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'peer_name'; sessionId: string; peerName?: string }
  | { type: 'notify'; sessionId: string; title: string; message: string; level?: NotifyLevel }
  | { type: 'reply'; sessionId: string; content: string }
  | { type: 'message_to_session'; sessionId: string; content: string; source?: MessageSource }
  | { type: 'image_upload'; sessionId: string; imageData: string; mimeType: string; originalName?: string; content?: string }
  | { type: 'image_to_session'; sessionId: string; imagePath: string; mimeType: string; originalName?: string; content?: string }
  | { type: 'sessions_list'; sessions: SessionInfo[] }
  | { type: 'session_connected'; session: SessionInfo }
  | { type: 'session_disconnected'; sessionId: string }
  | { type: 'session_updated'; session: SessionInfo }
  | { type: 'notification'; sessionId: string; title: string; message: string; level?: NotifyLevel; timestamp: number }
  | { type: 'reply_from_session'; sessionId: string; content: string; timestamp: number }
  | { type: 'permission_request'; sessionId: string; requestId: string; toolName: string; description: string; inputPreview: string; timestamp: number; choices?: PermissionChoice[] }
  | { type: 'permission_response'; sessionId: string; requestId: string; behavior?: 'allow' | 'deny'; choiceId?: string }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; state: 'resolved' | 'expired' }
  | { type: 'error'; message: string };

export type NotifyLevel = 'info' | 'warning' | 'error' | 'success';

/** Webhook configuration */
export interface WebhookConfig {
  url: string;
  events?: string[];
  headers?: Record<string, string>;
}

/** Telegram bot configuration */
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

/** Codex adapter configuration */
export interface CodexConfig {
  enabled: boolean;
  command?: string;
}

/** App configuration stored in ~/.claude-alarm/config.json */
export interface AppConfig {
  hub: {
    host: string;
    port: number;
    token?: string;
  };
  notifications: {
    desktop: boolean;
    sound: boolean;
  };
  webhooks: WebhookConfig[];
  telegram?: TelegramConfig;
  codex?: CodexConfig;
}

/** Hub status response */
export interface HubStatus {
  running: boolean;
  pid?: number;
  port?: number;
  sessions?: number;
  uptime?: number;
}
