import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { UPLOADS_DIR } from '../shared/constants.js';
import type { TelegramConfig, SessionInfo } from '../shared/types.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_to_message?: { message_id: number };
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export class TelegramBot {
  private config: TelegramConfig;
  private offset = 0;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  // message_id -> sessionId mapping for reply-based routing
  private messageSessionMap = new Map<number, string>();

  // Callback: when a text message arrives from Telegram for a session
  public onMessageToSession?: (sessionId: string, content: string) => void;
  // Callback: when an image arrives from Telegram for a session
  public onImageToSession?: (sessionId: string, imagePath: string, mimeType: string, caption?: string) => void;
  // Callback: when a permission verdict arrives from Telegram
  public onPermissionVerdict?: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  // Callback: get current sessions list
  public getSessions?: () => SessionInfo[];
  // Pending messages for session selection
  private pendingMessages = new Map<number, { text?: string; photoFileId?: string; caption?: string }>(); // chatId -> pending

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  private get apiUrl(): string {
    return `${TELEGRAM_API}${this.config.botToken}`;
  }

  /** Send a notification message to Telegram */
  async sendNotification(sessionId: string, _sessionLabel: string, title: string, message: string): Promise<void> {
    const text = `<b>${this.escHtml(title)}</b>\n${this.mdToHtml(message)}`;
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
          if (update.callback_query) {
            this.handleCallbackQuery(update.callback_query);
          } else if (update.message) {
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

  private async handleIncomingMessage(msg: TelegramMessage): Promise<void> {
    // Only process messages from the configured chat
    if (String(msg.chat.id) !== String(this.config.chatId)) return;

    const hasPhoto = msg.photo && msg.photo.length > 0;
    const text = (msg.text || msg.caption || '').trim();

    if (!text && !hasPhoto) return;

    // Check if it's a reply to a known message
    if (msg.reply_to_message) {
      const sessionId = this.messageSessionMap.get(msg.reply_to_message.message_id);
      if (sessionId) {
        if (hasPhoto) {
          await this.deliverPhotoToSession(sessionId, msg.photo!, text);
        } else {
          this.deliverToSession(sessionId, text);
        }
        return;
      }
    }

    // Check if it's a session selection command: /s_<index>
    if (text) {
      const selectMatch = text.match(/^\/s_(\d+)$/);
      if (selectMatch) {
        const pending = this.pendingMessages.get(msg.chat.id);
        if (pending) {
          this.pendingMessages.delete(msg.chat.id);
          const sessions = this.getSessions?.() ?? [];
          const idx = parseInt(selectMatch[1], 10) - 1;
          if (idx >= 0 && idx < sessions.length) {
            if (pending.photoFileId) {
              await this.deliverPhotoToSessionByFileId(sessions[idx].id, pending.photoFileId, pending.caption);
            } else if (pending.text) {
              this.deliverToSession(sessions[idx].id, pending.text);
            }
            this.sendMessage(`Sent to [${this.getLabel(sessions[idx])}]`);
          } else {
            this.sendMessage('Invalid session number.');
          }
          return;
        }
      }
    }

    // No reply context — check sessions count
    const sessions = this.getSessions?.() ?? [];

    if (sessions.length === 0) {
      this.sendMessage('No active sessions connected.');
      return;
    }

    if (sessions.length === 1) {
      if (hasPhoto) {
        await this.deliverPhotoToSession(sessions[0].id, msg.photo!, text);
      } else {
        this.deliverToSession(sessions[0].id, text);
      }
      return;
    }

    // Multiple sessions — ask user to pick with inline buttons
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      this.pendingMessages.set(msg.chat.id, { photoFileId: largest.file_id, caption: text });
    } else {
      this.pendingMessages.set(msg.chat.id, { text });
    }
    const buttons = sessions.map((s, i) => ({
      text: this.getLabel(s),
      callback_data: `sess:${i}:${msg.chat.id}`,
    }));
    // Arrange buttons in rows of 2
    const rows: Array<typeof buttons> = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    this.sendMessage('Multiple sessions active. Select one:', undefined, { inline_keyboard: rows });
  }

  private deliverToSession(sessionId: string, content: string): void {
    if (this.onMessageToSession) {
      this.onMessageToSession(sessionId, content);
    }
  }

  private async deliverPhotoToSession(sessionId: string, photos: TelegramPhotoSize[], caption?: string): Promise<void> {
    // Get the largest photo (last in array)
    const largest = photos[photos.length - 1];
    await this.deliverPhotoToSessionByFileId(sessionId, largest.file_id, caption);
  }

  private async deliverPhotoToSessionByFileId(sessionId: string, fileId: string, caption?: string): Promise<void> {
    try {
      // Get file path from Telegram
      const fileRes = await fetch(`${this.apiUrl}/getFile?file_id=${fileId}`);
      if (!fileRes.ok) { logger.warn('Failed to get Telegram file info'); return; }
      const fileData = await fileRes.json() as { ok: boolean; result: { file_path: string } };
      if (!fileData.ok) return;

      // Download the file
      const downloadUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileData.result.file_path}`;
      const imgRes = await fetch(downloadUrl);
      if (!imgRes.ok) { logger.warn('Failed to download Telegram photo'); return; }
      const buffer = Buffer.from(await imgRes.arrayBuffer());

      // Determine extension
      const ext = fileData.result.file_path.split('.').pop() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      // Save to uploads dir
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      logger.info(`Telegram photo saved: ${filename} (${buffer.length} bytes)`);

      // Deliver to session
      if (this.onImageToSession) {
        this.onImageToSession(sessionId, filePath, mimeType, caption);
      }

      // Cleanup after 5 minutes
      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5 * 60 * 1000);
    } catch (err) {
      logger.warn(`Telegram photo download failed: ${(err as Error).message}`);
    }
  }

  private getLabel(session: SessionInfo): string {
    return session.displayName || session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  }

  /** Send a permission request with inline buttons */
  async sendPermissionRequest(sessionId: string, sessionLabel: string, requestId: string, toolName: string, description: string, inputPreview: string): Promise<void> {
    // Parse inputPreview for readable display
    let preview = inputPreview;
    let truncated = false;
    try {
      const p = JSON.parse(inputPreview);
      if (p.command) preview = `$ ${p.command}`;
      else if (p.title && p.message) preview = p.message;
      else if (p.file_path) {
        preview = p.file_path;
        if (p.content) { preview += '\n' + p.content.slice(0, 3000); if (p.content.length > 500) truncated = true; }
      } else if (p.content && typeof p.content === 'string') {
        preview = p.content.slice(0, 3000);
        if (p.content.length > 500) truncated = true;
      }
    } catch {
      truncated = true;
      const cmdMatch = inputPreview.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const contentMatch = inputPreview.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cmdMatch) preview = `$ ${cmdMatch[1]}`;
      else if (contentMatch) preview = contentMatch[1].slice(0, 3000);
    }

    const truncNote = truncated ? '\n\n<i>...truncated</i>' : '';
    const previewSlice = preview.slice(0, 3000);
    // Use <code> for short single-line (commands), plain text for longer content
    const isShort = !previewSlice.includes('\n') && previewSlice.length < 100;
    const previewHtml = isShort
      ? `<code>${this.escHtml(previewSlice)}</code>`
      : this.escHtml(previewSlice);
    // Friendly tool name for Telegram — use title for notify tools
    let displayTool = toolName;
    if ((toolName.endsWith('__notify') || toolName === 'notify') && inputPreview) {
      try { const pp = JSON.parse(inputPreview); if (pp.title) displayTool = pp.title; } catch {
        const tm = inputPreview.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (tm) displayTool = tm[1];
      }
    } else {
      const mcpMatch = toolName.match(/__([^_]+)$/);
      if (mcpMatch) displayTool = mcpMatch[1].charAt(0).toUpperCase() + mcpMatch[1].slice(1);
    }

    const text = `⚠️ <b>Permission Request</b> — ${this.escHtml(sessionLabel)}\n\n` +
      `🔧 <b>${this.escHtml(displayTool)}</b>\n` +
      `${previewHtml}${truncNote}`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Allow', callback_data: `perm:allow:${sessionId}:${requestId}` },
        { text: '❌ Deny', callback_data: `perm:deny:${sessionId}:${requestId}` },
      ]],
    };

    await this.sendMessage(text, undefined, replyMarkup);
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;

    if (query.data.startsWith('sess:')) {
      await this.handleSessionSelectCallback(query);
      return;
    }

    if (!query.data.startsWith('perm:')) return;

    const parts = query.data.split(':');
    if (parts.length < 4) return;
    const [, action, sessionId, requestId] = parts;
    const behavior = action === 'allow' ? 'allow' : 'deny';

    // Send verdict
    if (this.onPermissionVerdict) {
      this.onPermissionVerdict(sessionId, requestId, behavior as 'allow' | 'deny');
    }

    // Answer callback to remove loading state
    await this.answerCallbackQuery(query.id, behavior === 'allow' ? '✅ Allowed' : '❌ Denied');

    // Update message to show result (use escaped original text since it's plain)
    if (query.message) {
      const label = behavior === 'allow' ? '✅ <b>Allowed</b>' : '❌ <b>Denied</b>';
      const original = this.escHtml(query.message.text || '');
      await this.editMessageText(query.message.chat.id, query.message.message_id, original + `\n\n${label}`);
    }
  }

  private async handleSessionSelectCallback(query: TelegramCallbackQuery): Promise<void> {
    const parts = query.data!.split(':');
    if (parts.length < 3) return;
    const [, idxStr, chatIdStr] = parts;
    const idx = parseInt(idxStr, 10);
    const chatId = parseInt(chatIdStr, 10);

    const sessions = this.getSessions?.() ?? [];
    if (idx < 0 || idx >= sessions.length) {
      await this.answerCallbackQuery(query.id, 'Session not found');
      return;
    }

    const session = sessions[idx];
    const pending = this.pendingMessages.get(chatId);
    this.pendingMessages.delete(chatId);

    if (pending) {
      if (pending.photoFileId) {
        await this.deliverPhotoToSessionByFileId(session.id, pending.photoFileId, pending.caption);
      } else if (pending.text) {
        this.deliverToSession(session.id, pending.text);
      }
    }

    await this.answerCallbackQuery(query.id, `Sent to ${this.getLabel(session)}`);
    // Update message to show which session was selected
    if (query.message) {
      await this.editMessageText(query.message.chat.id, query.message.message_id, `✅ Sent to <b>${this.escHtml(this.getLabel(session))}</b>`);
    }
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch (err) {
      logger.warn(`Telegram answerCallbackQuery error: ${(err as Error).message}`);
    }
  }

  private async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageText error: ${(err as Error).message}`);
    }
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Convert markdown to Telegram HTML (escape first, then apply formatting) */
  private mdToHtml(s: string): string {
    // Handle tables before escaping (convert to clean text format)
    let text = s.replace(
      /^(\|.+\|)\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm,
      (_match, header: string, body: string) => {
        const headerCells = header.split('|').filter((c: string) => c.trim()).map((c: string) => c.trim());
        const headerLine = headerCells.join(' | ');
        const bodyLines = body.trim().split('\n').map((row: string) => {
          return row.split('|').filter((c: string) => c.trim()).map((c: string) => c.trim()).join(' | ');
        });
        return `**${headerLine}**\n${bodyLines.join('\n')}`;
      },
    );
    let html = this.escHtml(text);
    // Code blocks: ```...```
    html = html.replace(/```(?:\w*)\n?([\s\S]*?)```/g, '<pre>$1</pre>');
    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Headings: # / ## / ### → bold (Telegram has no heading tags)
    html = html.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');
    // Bold: **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // Italic: *...*
    html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
    return html;
  }

  /** Update config (e.g., from dashboard settings) */
  updateConfig(config: TelegramConfig): void {
    const wasPolling = this.polling;
    if (wasPolling) this.stopPolling();
    this.config = config;
    if (wasPolling && config.enabled) this.startPolling();
  }
}
