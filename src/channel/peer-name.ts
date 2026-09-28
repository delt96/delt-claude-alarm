import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidPeerName } from '../shared/peer-name.js';

export interface PeerLookupEnv {
  messagingSocket?: string;
  sessionId?: string;
}

interface SessionRecord {
  name?: unknown;
  messagingSocketPath?: unknown;
  sessionId?: unknown;
}

export function findPeerName(records: unknown[], env: PeerLookupEnv): string | undefined {
  const valid = records.filter((r): r is SessionRecord => typeof r === 'object' && r !== null);
  const nameOf = (match: (r: SessionRecord) => boolean): string | undefined => {
    const rec = valid.find(match);
    return isValidPeerName(rec?.name) ? rec.name : undefined;
  };
  if (env.messagingSocket) {
    const bySocket = nameOf((r) => r.messagingSocketPath === env.messagingSocket);
    if (bySocket) return bySocket;
  }
  if (env.sessionId) return nameOf((r) => r.sessionId === env.sessionId);
  return undefined;
}

// <configDir>/sessions/<pid>.json is Claude Code's undocumented peer registry
// (the source of ListAgents/SendMessage names, verified on 2.1.283). Its format
// may change between releases, so every failure must degrade to "no name".
export function readPeerName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lookup: PeerLookupEnv = {
    messagingSocket: env.CLAUDE_CODE_MESSAGING_SOCKET,
    sessionId: env.CLAUDE_CODE_SESSION_ID,
  };
  if (!lookup.messagingSocket && !lookup.sessionId) return undefined;

  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dir = path.join(configDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }

  const records: unknown[] = [];
  for (const f of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {}
  }
  return findPeerName(records, lookup);
}
