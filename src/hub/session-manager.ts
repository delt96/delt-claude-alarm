import type { SessionInfo, SessionStatus } from '../shared/types.js';

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  register(session: SessionInfo): void {
    this.sessions.set(session.id, { ...session });
  }

  unregister(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return session;
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastActivity = Date.now();
    }
    return session;
  }

  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  count(): number {
    return this.sessions.size;
  }
}
