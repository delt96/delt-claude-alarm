import type { SessionInfo } from './types.js';

export function sessionLabel(session: SessionInfo): string {
  const base = session.displayName || session.cwd?.replace(/^.*[/\\]/, '') || session.name;
  return session.agentKind === 'codex' ? `Codex · ${base}` : base;
}
