import type { SessionControlState, SessionInfo, SessionStatus } from '../shared/types.js';
import { isControlKind } from '../shared/control-protocol.js';
import { isValidPeerName } from '../shared/peer-name.js';

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  register(session: SessionInfo): void {
    // Auto-number duplicate names
    const baseName = this.baseName(session);
    const existing = Array.from(this.sessions.values()).filter(
      s => s.id !== session.id && this.baseName(s) === baseName,
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
    this.sessions.set(session.id, { ...session, peerName: isValidPeerName(session.peerName) ? session.peerName : undefined });
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

  setPeerName(sessionId: string, peerName: string | undefined): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.peerName = isValidPeerName(peerName) ? peerName : undefined;
    }
    return session;
  }

  setContextTokens(sessionId: string, tokens: unknown): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      const previous = session.contextTokens;
      const next = Number.isSafeInteger(tokens) && (tokens as number) >= 0 ? (tokens as number) : undefined;
      session.contextTokens = next;
      // The channel server resends an unchanged count after a reconnect, which must not wipe the last change.
      if (next !== previous) session.contextTokensDelta = previous && next ? next - previous : undefined;
      else if (!next) session.contextTokensDelta = undefined;
    }
    return session;
  }

  setControl(sessionId: string, control: unknown): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.control = readControl(control);
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

  private baseName(session: SessionInfo): string {
    return session.title || session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  }
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function readControl(raw: unknown): SessionControlState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { busy, advice, greenFrom, compactAt, redFrom } = raw as Record<string, unknown>;
  if (typeof busy !== 'boolean') return undefined;
  const control: SessionControlState = isControlKind(advice) ? { busy, advice } : { busy };
  if (isCount(greenFrom)) control.greenFrom = greenFrom;
  if (isCount(compactAt) && compactAt > 0) control.compactAt = compactAt;
  if (isCount(redFrom)) control.redFrom = redFrom;
  return control;
}
