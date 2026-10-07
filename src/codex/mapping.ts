import type { MessageSource, Question, SessionStatus } from '../shared/types.js';
import { QUESTION_LIMITS, parseQuestions } from '../shared/questions.js';

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

export interface AsyncQuestion {
  title: string;
  options: string[] | null;
}

export interface AgentMessage {
  id?: string;
  text: string;
  phase?: string | null;
  delivery?: string | null;
  questions?: AsyncQuestion[] | null;
}

const TITLE_MAX = 30;
const SOURCE_LABEL: Record<MessageSource, string> = { dashboard: 'Dashboard', telegram: 'Telegram', api: 'API' };

const SOURCE_PREFIX = new RegExp(`^\\[claude-alarm(?: · (?:${Object.values(SOURCE_LABEL).join('|')}))?\\] ?`);

export function codexSessionId(threadId: string): string {
  return `codex:${threadId}`;
}

export function isTrackable(thread: CodexThread): boolean {
  return !thread.parentThreadId && !thread.ephemeral && thread.status.type !== 'notLoaded';
}

export function threadTitle(thread: CodexThread): string {
  const name = thread.name?.trim();
  if (name) return name;
  const preview = (thread.preview ?? '').replace(/\s+/g, ' ').trim().replace(SOURCE_PREFIX, '').trim();
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

const LIST_LINE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

// Codex 0.160 asks with an agentMessage whose `questions` repeat what its text already lists; the card shows only the rest.
export function asyncQuestions(item: AgentMessage): { questions: Question[]; context?: string } | null {
  if (!Array.isArray(item.questions) || item.questions.length === 0) return null;
  const parsed = parseQuestions(item.questions.map((q, i) => ({
    id: `q${i + 1}`,
    question: q?.title,
    options: Array.isArray(q?.options) ? q.options.map((label) => ({ label })) : null,
    allowOther: true,
  })));
  if (!parsed.ok) return null;
  const titles = new Set(parsed.questions.map((q) => q.question));
  const labels = new Set(parsed.questions.flatMap((q) => (q.options ?? []).map((o) => o.label)));
  const rest = (item.text ?? '').split('\n').filter((line) => {
    if (titles.has(line.trim())) return false;
    const listed = LIST_LINE.exec(line);
    return !(listed && labels.has(listed[1].trim()));
  });
  const context = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!context) return { questions: parsed.questions };
  const clipped = context.length > QUESTION_LIMITS.context ? `${context.slice(0, QUESTION_LIMITS.context - 1)}…` : context;
  return { questions: parsed.questions, context: clipped };
}

// Logs what a request_user_input asked without the full prompt text, so the format can be relayed once it is seen.
export function userInputShape(params: any): string {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const shape = {
    isBlocking: params?.isBlocking,
    questions: questions.map((q: any) => ({
      id: q?.id,
      header: q?.header,
      question: typeof q?.question === 'string' ? q.question.slice(0, 200) : q?.question,
      options: Array.isArray(q?.options) ? q.options.map((o: any) => o?.label) : q?.options,
      isOther: q?.isOther,
      isSecret: q?.isSecret,
    })),
  };
  return JSON.stringify(shape).slice(0, 2000);
}
