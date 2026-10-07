import { permissionKey } from '../shared/permission-key.js';
import type { MessageSource, QuestionAnswers, QuestionRequest } from '../shared/types.js';

export interface OpenQuestion {
  request: QuestionRequest;
  sending?: { answers: QuestionAnswers; source: MessageSource };
}

export class QuestionBook {
  private open = new Map<string, OpenQuestion>();
  // A Codex question is re-sent when its turn ends; remembering closed keys keeps an answered one from reopening.
  private closed = new Set<string>();

  constructor(private maxOpen = 500, private maxClosed = 500) {}

  /** Adds an open question. Returns the questions pushed out by the limit, or null if the request is already known. */
  add(request: QuestionRequest): QuestionRequest[] | null {
    const key = permissionKey(request.sessionId, request.requestId);
    if (this.open.has(key) || this.closed.has(key)) return null;
    this.open.set(key, { request });
    const evicted: QuestionRequest[] = [];
    while (this.open.size > this.maxOpen) {
      const [oldestKey, oldest] = this.open.entries().next().value as [string, OpenQuestion];
      this.open.delete(oldestKey);
      this.remember(oldestKey);
      evicted.push(oldest.request);
    }
    return evicted;
  }

  get(sessionId: string, requestId: string): OpenQuestion | undefined {
    return this.open.get(permissionKey(sessionId, requestId));
  }

  take(sessionId: string, requestId: string): OpenQuestion | undefined {
    const key = permissionKey(sessionId, requestId);
    const q = this.open.get(key);
    if (!q) return undefined;
    this.open.delete(key);
    this.remember(key);
    return q;
  }

  forSession(sessionId: string): OpenQuestion[] {
    return [...this.open.values()].filter((q) => q.request.sessionId === sessionId);
  }

  all(): OpenQuestion[] {
    return [...this.open.values()];
  }

  private remember(key: string): void {
    this.closed.add(key);
    while (this.closed.size > this.maxClosed) this.closed.delete(this.closed.values().next().value as string);
  }
}
