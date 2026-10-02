import type { MessageSource, SessionStatus } from '../shared/types.js';

export type CodexThreadStatus =
  | { type: 'notLoaded' | 'idle' | 'systemError' }
  | { type: 'active'; activeFlags: string[] };

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  status: CodexThreadStatus;
  parentThreadId?: string | null;
  ephemeral?: boolean;
}

export interface AgentMessage {
  text: string;
  phase?: string | null;
}

const TITLE_MAX = 30;
const SOURCE_LABEL: Record<MessageSource, string> = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

export function codexSessionId(threadId: string): string {
  return `codex:${threadId}`;
}

export function isTrackable(thread: CodexThread): boolean {
  return !thread.parentThreadId && !thread.ephemeral && thread.status.type !== 'notLoaded';
}

export function threadTitle(thread: CodexThread): string {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = (thread.preview ?? '').replace(/\s+/g, ' ').trim();
  if (preview) return preview.length > TITLE_MAX ? `${preview.slice(0, TITLE_MAX)}…` : preview;
  return thread.cwd.replace(/^.*[/\\]/, '') || thread.id.slice(0, 8);
}

export function hubStatus(status: CodexThreadStatus): SessionStatus {
  if (status.type !== 'active') return 'idle';
  return status.activeFlags.some((f) => f === 'waitingOnApproval' || f === 'waitingOnUserInput') ? 'waiting_input' : 'working';
}

export function withSourcePrefix(content: string, source?: MessageSource): string {
  return source ? `[claude-alarm · ${SOURCE_LABEL[source]}] ${content}` : `[claude-alarm] ${content}`;
}

export function finalAnswer(messages: AgentMessage[]): string | null {
  const finals = messages.filter((m) => m.phase === 'final_answer').map((m) => m.text);
  if (finals.length) return finals.join('\n\n');
  return messages.at(-1)?.text ?? null;
}

// Explorer's "Copy as path" wraps the path in double quotes.
export function cleanFolder(input: string): string {
  const s = input.trim();
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).trim() : s;
}
