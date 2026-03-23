import { logger } from '../shared/logger.js';
import type { TelegramConfig, SessionInfo } from '../shared/types.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramBot {
  private config: TelegramConfig;
  private offset = 0;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  // message_id -> sessionId mapping for reply-based routing
  private messageSessionMap = new Map<number, string>();

  // Callback: when a message arrives from Telegram for a session
  public onMessageToSession?: (sessionId: string, content: string) => void;
  // Callback: get current sessions list
  public getSessions?: () => SessionInfo[];
  // Callback: when user needs to select a session (sends inline keyboard)
  private pendingMessages = new Map<number, string>(); // chatId -> pending message text

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  private get apiUrl(): string {
    return `${TELEGRAM_API}${this.config.botToken}`;
  }

  /** Send a notification message to Telegram */
  async sendNotification(sessionId: string, _sessionLabel: string, title: string, message: string): Promise<void> {
    const text = `${title}\n${message}`;
    const result = await this.sendMessage(text);
    if (result?.message_id) {
      this.messageSessionMap.set(result.message_id, sessionId);
      // Cleanup old mappings (keep last 200)
      if (this.messageSessionMap.size > 200) {
        const keys = [...this.messageSessionMap.keys()];
        for (let i = 0; i < keys.length - 200; i++) {
          this.messageSessionMap.delete(keys[i]);
        }
      }
    }
  }

  /** Send a text message to the configured chat */
  private async sendMessage(text: string, replyToMessageId?: number, replyMarkup?: unknown): Promise<{ message_id: number } | null> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.config.chatId,
        text,
        parse_mode: 'HTML',
      };
      if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
      if (replyMarkup) body.reply_markup = replyMarkup;

      const res = await fetch(`${this.apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        logger.warn(`Telegram sendMessage failed: ${res.status} ${err}`);
        return null;
      }

      const data = await res.json() as { ok: boolean; result: { message_id: number } };
      return data.ok ? data.result : null;
    } catch (err) {
      logger.warn(`Telegram sendMessage error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Start long polling for incoming messages */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    logger.info('Telegram bot polling started');
    this.poll();
  }

  /** Stop polling */
  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Telegram bot polling stopped');
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const res = await fetch(`${this.apiUrl}/getUpdates?offset=${this.offset}&timeout=30`, {
        signal: AbortSignal.timeout(35000),
      });

      if (!res.ok) {
        logger.warn(`Telegram getUpdates failed: ${res.status}`);
        this.scheduleNextPoll(5000);
        return;
      }

      const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (update.message) {
            this.handleIncomingMessage(update.message);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        logger.warn(`Telegram poll error: ${(err as Error).message}`);
      }
    }

    this.scheduleNextPoll(1000);
  }

  private scheduleNextPoll(delay: number): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  private handleIncomingMessage(msg: TelegramMessage): void {
    if (!msg.text) return;

    // Only process messages from the configured chat
    if (String(msg.chat.id) !== String(this.config.chatId)) return;

    const text = msg.text.trim();

    // Check if it's a reply to a known message
    if (msg.reply_to_message) {
      const sessionId = this.messageSessionMap.get(msg.reply_to_message.message_id);
      if (sessionId) {
        this.deliverToSession(sessionId, text);
        return;
      }
    }

    // Check if it's a session selection command: /s_<index>
    const selectMatch = text.match(/^\/s_(\d+)$/);
    if (selectMatch) {
      const pendingText = this.pendingMessages.get(msg.chat.id);
      if (pendingText) {
        this.pendingMessages.delete(msg.chat.id);
        const sessions = this.getSessions?.() ?? [];
        const idx = parseInt(selectMatch[1], 10) - 1;
        if (idx >= 0 && idx < sessions.length) {
          this.deliverToSession(sessions[idx].id, pendingText);
          this.sendMessage(`Sent to [${this.getLabel(sessions[idx])}]`);
        } else {
          this.sendMessage('Invalid session number.');
        }
        return;
      }
    }

    // No reply context — check sessions count
    const sessions = this.getSessions?.() ?? [];

    if (sessions.length === 0) {
      this.sendMessage('No active sessions connected.');
      return;
    }

    if (sessions.length === 1) {
      this.deliverToSession(sessions[0].id, text);
      return;
    }

    // Multiple sessions — ask user to pick
    this.pendingMessages.set(msg.chat.id, text);
    const sessionList = sessions
      .map((s, i) => `/s_${i + 1} - ${this.getLabel(s)}`)
      .join('\n');
    this.sendMessage(`Multiple sessions active. Reply with a command to select:\n\n${sessionList}`);
  }

  private deliverToSession(sessionId: string, content: string): void {
    if (this.onMessageToSession) {
      this.onMessageToSession(sessionId, content);
    }
  }

  private getLabel(session: SessionInfo): string {
    return session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  }

  /** Update config (e.g., from dashboard settings) */
  updateConfig(config: TelegramConfig): void {
    const wasPolling = this.polling;
    if (wasPolling) this.stopPolling();
    this.config = config;
    if (wasPolling && config.enabled) this.startPolling();
  }
}
