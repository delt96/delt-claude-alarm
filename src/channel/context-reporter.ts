import type { ChannelMessage } from '../shared/types.js';

export const CONTEXT_TOKENS_FEATURE = 'context_tokens';

interface ReporterHub {
  supports(feature: string): boolean;
  send(msg: ChannelMessage): unknown;
}

export class ContextTokenReporter {
  private last: number | null | undefined;

  constructor(
    private readonly hub: ReporterHub,
    private readonly sessionId: string,
    private readonly read: () => number | null,
  ) {}

  refresh(): void {
    if (!this.hub.supports(CONTEXT_TOKENS_FEATURE)) return;
    const tokens = this.read();
    if (tokens === this.last) return;
    this.last = tokens;
    this.hub.send({ type: 'context_tokens', sessionId: this.sessionId, tokens });
  }

  // A new hub connection starts with no count for this session.
  reset(): void {
    this.last = undefined;
  }
}
