import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { UPLOADS_DIR } from '../shared/constants.js';
import type { TelegramConfig, SessionInfo, PermissionChoice, MessageSource, Question, QuestionAnswers, QuestionRequest, QuestionState } from '../shared/types.js';
import { sessionLabel } from '../shared/session-label.js';
import { permissionKey } from '../shared/permission-key.js';
import { readAnswers } from '../shared/questions.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MAX_CHOICE_MESSAGES = 200;
const MAX_SELECTIONS = 20;
const MAX_VISIBLE_CHARS = 4000;
const TRUNCATED = '…(truncated)';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const NO_LONGER_CONNECTED = 'the session is no longer connected';
const MAX_QUESTION_REQUESTS = 100;
const SHOWN_ANSWER = 300;
// Room kept free in a question message for the "Selected" or result line added when it is edited.
const QUESTION_EDIT_ROOM = 400;
const SOURCE_NAMES: Record<MessageSource, string> = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

// Telegram's 4096 limit counts the text left after parsing entities: tags are free and each escape is one character.
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt);/g, '&').length;
}

interface ChoiceMessage {
  html: string;
  messageId?: number;
  outcome?: string;
}

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

interface QuestionMessage {
  html: string;
  keyboard: InlineKeyboard | null;
  id?: number;
}

interface TelegramQuestion {
  key: string;
  sessionId: string;
  requestId: string;
  questions: Question[];
  answers: Map<string, string>;
  messages: Map<string, QuestionMessage>;
  state: 'open' | 'sending' | 'done';
  final?: { state: QuestionState; answers?: QuestionAnswers; source?: MessageSource };
}

interface PendingSelection {
  text?: string;
  photoFileId?: string;
  caption?: string;
  sessionIds: string[];
}

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
  public onMessageToSession?: (sessionId: string, content: string) => boolean;
  // Callback: when an image arrives from Telegram for a session
  public onImageToSession?: (sessionId: string, imagePath: string, mimeType: string, caption?: string) => boolean;
  // Callback: when a permission verdict arrives from Telegram
  public onPermissionVerdict?: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') => void;
  // Callback: when a Codex approval choice arrives from Telegram
  public onChoiceVerdict?: (sessionId: string, requestId: string, choiceId: string) => void;
  // Telegram caps callback_data at 64 bytes, so buttons carry a short token instead of the ids.
  private choiceTokens = new Map<string, { sessionId: string; requestId: string; choiceId: string; label: string }>();
  private choiceMessages = new Map<string, ChoiceMessage>();
  // Callback: all questions of a request are answered here; returns 'ok' or why the hub refused
  public onQuestionAnswer?: (sessionId: string, requestId: string, answers: QuestionAnswers) => string;
  private questionRequests = new Map<string, TelegramQuestion>();
  private questionTokens = new Map<string, { key: string; qid: string; label: string }>();
  private questionReplies = new Map<number, { key: string; qid: string }>();
  // Callback: get current sessions list
  public getSessions?: () => SessionInfo[];
  private latestSelection: string | undefined;
  // Keyed by prompt, not by chat: buttons from an older prompt must still send that prompt's message.
  private selections = new Map<string, PendingSelection>();

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  private get apiUrl(): string {
    return `${TELEGRAM_API}${this.config.botToken}`;
  }

  /** Send a notification message to Telegram */
  async sendNotification(sessionId: string, _sessionLabel: string, title: string, message: string): Promise<void> {
    const text = this.fitNotification(title, message);
    const result = await this.sendMessage(text);
    if (result?.message_id) this.rememberSession(result.message_id, sessionId);
  }

  private rememberSession(messageId: number, sessionId: string): void {
    this.messageSessionMap.set(messageId, sessionId);
    // Cleanup old mappings (keep last 200)
    if (this.messageSessionMap.size > 200) {
      const keys = [...this.messageSessionMap.keys()];
      for (let i = 0; i < keys.length - 200; i++) {
        this.messageSessionMap.delete(keys[i]);
      }
    }
  }

  private fitNotification(title: string, message: string): string {
    return this.fit((body) => `<b>${this.escHtml(title)}</b>\n${this.mdToHtml(body)}`, message);
  }

  private fit(render: (body: string) => string, body: string, max = MAX_VISIBLE_CHARS): string {
    const full = render(body);
    if (visibleLength(full) <= max) return full;
    const cut = (n: number) => {
      // Cutting between the halves of a surrogate pair would send invalid UTF-16.
      const end = n > 0 && /[\uD800-\uDBFF]/.test(body[n - 1]) ? n - 1 : n;
      return render(`${body.slice(0, end)}\n${TRUNCATED}`);
    };
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (visibleLength(cut(mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    return cut(lo);
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
    if (hasPhoto) {
      const size = msg.photo![msg.photo!.length - 1].file_size;
      if (size !== undefined && size > MAX_PHOTO_BYTES) {
        this.photoNotDelivered('it is larger than 10 MB');
        return;
      }
    }

    // A reply to an open question is its typed answer, not a message to the session.
    if (msg.reply_to_message && text && !hasPhoto && (await this.answerByReply(msg.reply_to_message.message_id, text))) return;

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

    if (text) {
      const selectMatch = text.match(/^\/s_(\d+)$/);
      const latest = this.latestSelection;
      if (selectMatch && latest !== undefined) {
        const pending = this.selections.get(latest);
        if (pending) {
          this.selections.delete(latest);
          const session = this.pendingSession(pending, parseInt(selectMatch[1], 10) - 1);
          if (session) {
            if (await this.deliverPending(session.id, pending)) this.sendMessage(`Sent to [${this.getLabel(session)}]`);
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

    const selectionId = randomUUID().replace(/-/g, '').slice(0, 8);
    this.latestSelection = selectionId;
    const sessionIds = sessions.map((s) => s.id);
    if (hasPhoto) {
      const largest = msg.photo![msg.photo!.length - 1];
      this.selections.set(selectionId, { photoFileId: largest.file_id, caption: text, sessionIds });
    } else {
      this.selections.set(selectionId, { text, sessionIds });
    }
    while (this.selections.size > MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value as string);
    const buttons = sessions.map((s, i) => ({
      text: this.getLabel(s),
      callback_data: `sel:${selectionId}:${i}`,
    }));
    // Arrange buttons in rows of 2
    const rows: Array<typeof buttons> = [];
    for (let i = 0; i < buttons.length; i += 2) {
      rows.push(buttons.slice(i, i + 2));
    }
    this.sendMessage('Multiple sessions active. Select one:', undefined, { inline_keyboard: rows });
  }

  private deliverToSession(sessionId: string, content: string): boolean {
    const delivered = this.onMessageToSession?.(sessionId, content) === true;
    if (!delivered) void this.sendMessage(`Not delivered: ${NO_LONGER_CONNECTED}`);
    return delivered;
  }

  private async deliverPending(sessionId: string, pending: PendingSelection): Promise<boolean> {
    if (pending.photoFileId) return this.deliverPhotoToSessionByFileId(sessionId, pending.photoFileId, pending.caption);
    return pending.text ? this.deliverToSession(sessionId, pending.text) : false;
  }

  private async deliverPhotoToSession(sessionId: string, photos: TelegramPhotoSize[], caption?: string): Promise<boolean> {
    // Get the largest photo (last in array)
    const largest = photos[photos.length - 1];
    return this.deliverPhotoToSessionByFileId(sessionId, largest.file_id, caption);
  }

  private async deliverPhotoToSessionByFileId(sessionId: string, fileId: string, caption?: string): Promise<boolean> {
    try {
      const fileRes = await fetch(`${this.apiUrl}/getFile?file_id=${fileId}`);
      const fileData = fileRes.ok ? ((await fileRes.json()) as { ok: boolean; result?: { file_path: string } }) : undefined;
      if (!fileData?.ok || !fileData.result) {
        this.photoNotDelivered('Telegram did not return the file');
        return false;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileData.result.file_path}`;
      const imgRes = await fetch(downloadUrl);
      if (!imgRes.ok) {
        this.photoNotDelivered('the download failed');
        return false;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length > MAX_PHOTO_BYTES) {
        this.photoNotDelivered('it is larger than 10 MB');
        return false;
      }

      const ext = fileData.result.file_path.split('.').pop() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, buffer);
      logger.info(`Telegram photo saved: ${filename} (${buffer.length} bytes)`);

      let accepted = false;
      try {
        accepted = this.onImageToSession?.(sessionId, filePath, mimeType, caption) === true;
      } catch (err) {
        logger.warn(`Telegram photo hand-off failed: ${(err as Error).message}`);
      }
      if (!accepted) {
        try { fs.unlinkSync(filePath); } catch {}
        this.photoNotDelivered(NO_LONGER_CONNECTED);
        return false;
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5 * 60 * 1000).unref();
      return true;
    } catch (err) {
      logger.warn(`Telegram photo download failed: ${(err as Error).message}`);
      this.photoNotDelivered('the download failed');
      return false;
    }
  }

  private photoNotDelivered(reason: string): void {
    logger.warn(`Telegram photo not delivered: ${reason}`);
    void this.sendMessage(`Photo not delivered: ${reason}`);
  }

  // Buttons are numbered against the list shown when they were sent; Codex sessions come and go, so the live list may have shifted.
  private pendingSession(pending: { sessionIds: string[] }, idx: number): SessionInfo | undefined {
    const id = pending.sessionIds[idx];
    return id ? this.getSessions?.().find((s) => s.id === id) : undefined;
  }

  private getLabel(session: SessionInfo): string {
    return sessionLabel(session);
  }

  /** Send a permission request with inline buttons */
  async sendPermissionRequest(sessionId: string, sessionLabel: string, requestId: string, toolName: string, description: string, inputPreview: string): Promise<void> {
    // Parse inputPreview for readable display.
    // kind 'code' must stay byte-exact: running it through mdToHtml would swallow the
    // ** and ` characters the approver needs to judge what actually gets executed.
    // Only notify-style messages (prose Claude wrote) are safe to render as markdown.
    const isNotify = toolName.endsWith('__notify') || toolName === 'notify';
    let preview = inputPreview;
    let kind: 'code' | 'prose' = 'code';
    let lang = '';
    let truncated = false;
    try {
      const p = JSON.parse(inputPreview);
      if (p.command) { preview = `$ ${p.command}`; lang = 'bash'; }
      else if (p.title && p.message) { preview = p.message; kind = 'prose'; }
      else if (p.file_path) {
        preview = p.file_path;
        lang = this.langOf(p.file_path);
        if (p.content) { preview += '\n' + p.content.slice(0, 3000); if (p.content.length > 500) truncated = true; }
      } else if (p.content && typeof p.content === 'string') {
        preview = p.content.slice(0, 3000);
        if (isNotify) kind = 'prose';
        if (p.content.length > 500) truncated = true;
      }
    } catch {
      truncated = true;
      const cmdMatch = inputPreview.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const contentMatch = inputPreview.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cmdMatch) { preview = `$ ${cmdMatch[1]}`; lang = 'bash'; }
      else if (contentMatch) preview = contentMatch[1].slice(0, 3000);
    }

    const truncNote = truncated ? '\n\n<i>...truncated</i>' : '';
    const previewSlice = preview.slice(0, 3000);
    // Short single-line commands read better inline; anything longer gets a code block
    const isShort = !previewSlice.includes('\n') && previewSlice.length < 100;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    const previewHtml = kind === 'prose'
      ? this.mdToHtml(previewSlice)
      : isShort
        ? `<code>${this.escHtml(previewSlice)}</code>`
        : `<pre><code${langAttr}>${this.escHtml(previewSlice)}</code></pre>`;
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

  async sendChoiceRequest(
    sessionId: string,
    sessionLabel: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
    choices: PermissionChoice[],
  ): Promise<void> {
    let preview = inputPreview;
    try {
      const p = JSON.parse(inputPreview);
      if (typeof p.command === 'string') preview = `$ ${p.command}`;
      else if (typeof p.content === 'string') preview = p.content;
    } catch {}
    const slice = preview.slice(0, 3000);
    const html =
      `⚠️ <b>Permission Request</b> — ${this.escHtml(sessionLabel)}\n\n` +
      `🔧 <b>${this.escHtml(toolName)}</b>` +
      (description ? `\n${this.escHtml(description)}` : '') +
      (slice ? `\n<pre>${this.escHtml(slice)}</pre>` : '') +
      (preview.length > slice.length ? '\n<i>...truncated</i>' : '');

    const entry: ChoiceMessage = { html };
    this.choiceMessages.set(permissionKey(sessionId, requestId), entry);
    const rows = choices.map((c) => {
      const token = randomUUID().replace(/-/g, '').slice(0, 16);
      this.choiceTokens.set(token, { sessionId, requestId, choiceId: c.id, label: c.label });
      return [{ text: c.label, callback_data: `pc:${token}` }];
    });
    this.trimChoiceMessages();

    const sent = await this.sendMessage(html, undefined, { inline_keyboard: rows });
    if (!sent) return;
    entry.messageId = sent.message_id;
    if (entry.outcome) await this.editMessageText(this.config.chatId, sent.message_id, html + entry.outcome);
  }

  async resolveChoiceRequest(sessionId: string, requestId: string, state: 'resolved' | 'expired'): Promise<void> {
    this.dropChoiceTokens(sessionId, requestId);
    const key = permissionKey(sessionId, requestId);
    const entry = this.choiceMessages.get(key);
    if (!entry) return;
    this.choiceMessages.delete(key);
    entry.outcome = state === 'resolved' ? '\n\n✅ <b>Resolved</b>' : '\n\n⌛ <b>Expired</b>';
    if (entry.messageId !== undefined) await this.editMessageText(this.config.chatId, entry.messageId, entry.html + entry.outcome);
  }

  private async handleChoiceCallback(query: TelegramCallbackQuery): Promise<void> {
    const choice = this.choiceTokens.get(query.data!.slice('pc:'.length));
    if (!choice) {
      await this.expire(query);
      return;
    }
    this.dropChoiceTokens(choice.sessionId, choice.requestId);
    this.onChoiceVerdict?.(choice.sessionId, choice.requestId, choice.choiceId);
    await this.answerCallbackQuery(query.id, `Sent: ${choice.label}`);
    const entry = this.choiceMessages.get(permissionKey(choice.sessionId, choice.requestId));
    if (entry?.messageId !== undefined && !entry.outcome) {
      await this.editMessageText(this.config.chatId, entry.messageId, `${entry.html}\n\n⏳ <b>Sent: ${this.escHtml(choice.label)}</b>`);
    }
  }

  private dropChoiceTokens(sessionId: string, requestId: string): void {
    for (const [token, c] of this.choiceTokens) {
      if (c.sessionId === sessionId && c.requestId === requestId) this.choiceTokens.delete(token);
    }
  }

  private trimChoiceMessages(): void {
    while (this.choiceMessages.size > MAX_CHOICE_MESSAGES) {
      const oldest = this.choiceMessages.keys().next().value as string;
      this.choiceMessages.delete(oldest);
      const [sessionId, requestId] = oldest.split('\n');
      this.dropChoiceTokens(sessionId, requestId);
    }
  }

  async sendQuestion(sessionId: string, sessionLabel: string, request: QuestionRequest): Promise<void> {
    const key = permissionKey(sessionId, request.requestId);
    const entry: TelegramQuestion = { key, sessionId, requestId: request.requestId, questions: request.questions, answers: new Map(), messages: new Map(), state: 'open' };
    this.questionRequests.set(key, entry);
    this.trimQuestions();
    const count = request.questions.length;
    const head = `❓ <b>${count === 1 ? 'Question' : `Questions (${count})`}</b> — ${this.escHtml(sessionLabel)}`;
    const context = request.context ?? '';
    if (count > 1) {
      const heading = await this.sendMessage(this.fit((body) => (body ? `${head}\n\n${this.mdToHtml(body)}` : head), context));
      if (heading) this.rememberSession(heading.message_id, sessionId);
    }
    const budget = MAX_VISIBLE_CHARS - QUESTION_EDIT_ROOM;
    for (const [i, q] of request.questions.entries()) {
      const hint = q.options ? (q.allowOther ? 'Or reply to this message with your own answer.' : '') : 'Reply to this message with your answer.';
      const bodyWith = (lines: string) => `${q.header ? `<b>[${this.escHtml(q.header)}]</b> ` : ''}${this.mdToHtml(q.question)}${lines}${hint ? `\n\n<i>${hint}</i>` : ''}`;
      const render = (body: string) => count === 1
        ? this.fit((ctx) => `${head}${ctx ? `\n\n${this.mdToHtml(ctx)}` : ''}\n\n${body}`, context, budget)
        : this.fit((text) => `<b>${i + 1}/${count}</b> ${text}`, body, budget);
      const lines = this.optionLines(q);
      const described = lines ? render(bodyWith(lines)) : '';
      // Option lines are kept whole or left out; fit would otherwise cut them mid-list.
      const html = described && visibleLength(described) <= budget && described.includes(bodyWith(lines)) ? described : render(bodyWith(''));
      const keyboard = q.options && entry.state !== 'done' ? q.options.map((o) => {
        const token = randomUUID().replace(/-/g, '').slice(0, 16);
        this.questionTokens.set(token, { key, qid: q.id, label: o.label });
        return [{ text: o.label, callback_data: `qa:${token}` }];
      }) : null;
      const message: QuestionMessage = { html, keyboard };
      entry.messages.set(q.id, message);
      const sent = await this.sendMessage(html, undefined, keyboard ? { inline_keyboard: keyboard } : undefined);
      if (!sent) continue;
      message.id = sent.message_id;
      this.rememberSession(sent.message_id, sessionId);
      if (entry.state === 'done') {
        await this.editMessageText(this.config.chatId, sent.message_id, this.finalHtml(entry, q.id, message));
      } else {
        this.questionReplies.set(sent.message_id, { key, qid: q.id });
      }
    }
  }

  private optionLines(q: Question): string {
    if (!q.options?.some((o) => o.description)) return '';
    const lines = q.options.map((o) => `• <b>${this.escHtml(o.label)}</b>${o.description ? ` — ${this.escHtml(o.description)}` : ''}`);
    return `\n\n${lines.join('\n')}`;
  }

  async resolveQuestion(sessionId: string, requestId: string, state: QuestionState, answers?: QuestionAnswers, source?: MessageSource): Promise<void> {
    const key = permissionKey(sessionId, requestId);
    const entry = this.questionRequests.get(key);
    if (!entry) return;
    this.questionRequests.delete(key);
    this.dropQuestionRefs(key);
    entry.state = 'done';
    entry.final = { state, answers, source };
    for (const [qid, message] of entry.messages) {
      if (message.id !== undefined) await this.editMessageText(this.config.chatId, message.id, this.finalHtml(entry, qid, message));
    }
  }

  async reopenQuestion(sessionId: string, requestId: string, reason: string): Promise<void> {
    const entry = this.questionRequests.get(permissionKey(sessionId, requestId));
    if (!entry || entry.state !== 'sending') return;
    entry.state = 'open';
    entry.answers.clear();
    for (const message of entry.messages.values()) {
      if (message.id !== undefined) await this.editMessageText(this.config.chatId, message.id, message.html, message.keyboard ? { inline_keyboard: message.keyboard } : undefined);
    }
    await this.sendMessage(`Not delivered: ${this.escHtml(reason)}`);
  }

  private finalHtml(entry: TelegramQuestion, qid: string, message: QuestionMessage): string {
    const final = entry.final!;
    if (final.state === 'answered') {
      const from = final.source && final.source !== 'telegram' ? ` (${SOURCE_NAMES[final.source]})` : '';
      return `${message.html}\n\n✅ <b>${this.shown(final.answers?.[qid] ?? '')}</b>${from}`;
    }
    return `${message.html}\n\n${final.state === 'closed' ? '<i>Closed — a message was sent instead</i>' : '⌛ <b>Expired</b>'}`;
  }

  private shown(answer: string): string {
    return this.escHtml(answer.length > SHOWN_ANSWER ? `${answer.slice(0, SHOWN_ANSWER)}…` : answer);
  }

  private async handleQuestionCallback(query: TelegramCallbackQuery): Promise<void> {
    const token = this.questionTokens.get(query.data!.slice('qa:'.length));
    const entry = token && this.questionRequests.get(token.key);
    if (!token || !entry) {
      await this.expire(query);
      return;
    }
    if (entry.state !== 'open') {
      await this.answerCallbackQuery(query.id, 'Sending…');
      return;
    }
    const result = await this.recordAnswer(entry, token.qid, token.label);
    await this.answerCallbackQuery(query.id, result === 'sending' ? 'Sending…' : result === 'failed' ? 'Not delivered' : 'Selected');
  }

  private async answerByReply(messageId: number, text: string): Promise<boolean> {
    const ref = this.questionReplies.get(messageId);
    const entry = ref && this.questionRequests.get(ref.key);
    if (!ref || !entry || entry.state !== 'open') return false;
    if (!entry.questions.find((q) => q.id === ref.qid)?.allowOther) return false;
    await this.recordAnswer(entry, ref.qid, text);
    return true;
  }

  private async recordAnswer(entry: TelegramQuestion, qid: string, answer: string): Promise<'selected' | 'sending' | 'failed'> {
    entry.answers.set(qid, answer);
    const message = entry.messages.get(qid);
    if (message?.id !== undefined) {
      await this.editMessageText(this.config.chatId, message.id, `${message.html}\n\n☑️ <b>Selected:</b> ${this.shown(answer)}`, message.keyboard ? { inline_keyboard: message.keyboard } : undefined);
    }
    if (entry.answers.size < entry.questions.length || entry.state !== 'open') return 'selected';
    entry.state = 'sending';
    const read = readAnswers(entry.questions, Object.fromEntries(entry.answers));
    const outcome = read.ok ? (this.onQuestionAnswer?.(entry.sessionId, entry.requestId, read.answers) ?? 'the hub is not listening') : read.error;
    if (outcome === 'ok') return 'sending';
    if (entry.state === 'sending') entry.state = 'open';
    await this.sendMessage(`Not delivered: ${this.escHtml(outcome)}`);
    return 'failed';
  }

  private dropQuestionRefs(key: string): void {
    for (const [token, ref] of this.questionTokens) if (ref.key === key) this.questionTokens.delete(token);
    for (const [messageId, ref] of this.questionReplies) if (ref.key === key) this.questionReplies.delete(messageId);
  }

  private trimQuestions(): void {
    while (this.questionRequests.size > MAX_QUESTION_REQUESTS) {
      const oldest = this.questionRequests.keys().next().value as string;
      this.questionRequests.delete(oldest);
      this.dropQuestionRefs(oldest);
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;
    if (String(query.message?.chat.id) !== String(this.config.chatId)) return;

    if (query.data.startsWith('sel:')) {
      await this.handleSessionSelectCallback(query);
      return;
    }

    if (query.data.startsWith('sess:')) {
      await this.expire(query);
      return;
    }

    if (query.data.startsWith('pc:')) {
      await this.handleChoiceCallback(query);
      return;
    }

    if (query.data.startsWith('qa:')) {
      await this.handleQuestionCallback(query);
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
    const [, selectionId, idxStr] = query.data!.split(':');
    const pending = this.selections.get(selectionId);
    if (!pending) {
      await this.expire(query);
      return;
    }
    const session = this.pendingSession(pending, parseInt(idxStr, 10));
    if (!session) {
      await this.answerCallbackQuery(query.id, 'Session not found');
      return;
    }
    this.selections.delete(selectionId);

    if (!(await this.deliverPending(session.id, pending))) {
      await this.answerCallbackQuery(query.id, pending.photoFileId ? 'Photo not delivered' : 'Not delivered');
      if (query.message) await this.removeButtons(query.message.chat.id, query.message.message_id);
      return;
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

  private async expire(query: TelegramCallbackQuery): Promise<void> {
    await this.answerCallbackQuery(query.id, 'Expired');
    if (query.message) await this.removeButtons(query.message.chat.id, query.message.message_id);
  }

  private async removeButtons(chatId: number | string, messageId: number): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageReplyMarkup error: ${(err as Error).message}`);
    }
  }

  // Telegram drops the buttons of an edited message unless reply_markup is sent again.
  private async editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: { inline_keyboard: InlineKeyboard }): Promise<void> {
    try {
      await fetch(`${this.apiUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      });
    } catch (err) {
      logger.warn(`Telegram editMessageText error: ${(err as Error).message}`);
    }
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private static readonly LANG_BY_EXT: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
    java: 'java', kt: 'kotlin', rs: 'rust', php: 'php', cs: 'csharp',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
    md: 'markdown', html: 'html', vue: 'html', css: 'css', scss: 'scss',
  };

  private langOf(path: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(path || '');
    return m ? (TelegramBot.LANG_BY_EXT[m[1].toLowerCase()] ?? '') : '';
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
    // Extract code spans/blocks BEFORE escaping/formatting so that bold/italic
    // regexes can't cross into them and produce overlapping tags (Telegram rejects).
    const tokens: string[] = [];
    const placeholder = (i: number) => `\u0000CODE${i}\u0000`;
    text = text.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_m, body: string) => {
      const i = tokens.push(`<pre>${this.escHtml(body)}</pre>`) - 1;
      return placeholder(i);
    });
    text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
      const i = tokens.push(`<code>${this.escHtml(body)}</code>`) - 1;
      return placeholder(i);
    });

    let html = this.escHtml(text);
    // Headings: # / ## / ### → bold (Telegram has no heading tags)
    html = html.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');
    // Bold: **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // Italic: *...* (single line only, to avoid swallowing across blocks)
    html = html.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');

    // Restore code tokens
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, n: string) => tokens[Number(n)] ?? '');
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
