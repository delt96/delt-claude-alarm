import type { SessionInfo, SessionStatus } from '../shared/types.js';

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  register(session: SessionInfo): void {
    // Auto-number duplicate names
    const baseName = session.cwd?.replace(/^.*[/\\]/, '') || session.name;
    const existing = Array.from(this.sessions.values()).filter(
      s => s.id !== session.id && (s.cwd?.replace(/^.*[/\\]/, '') || s.name) === baseName,
    );
    if (existing.length > 0) {
      // Number this one
      const usedNums = existing.map(s => {
        const m = s.displayName?.match(/\((\d+)\)$/);
        return m ? parseInt(m[1], 10) : 1;
      });
      // Ensure first existing session has (1) if it doesn't yet
      for (const s of existing) {
        if (!s.displayName?.match(/\(\d+\)$/)) {
          s.displayName = `${baseName} (1)`;
        }
      }
      const nextNum = Math.max(...usedNums, 1) + 1;
      session.displayName = `${baseName} (${nextNum})`;
    } else {
      session.displayName = baseName;
    }
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
