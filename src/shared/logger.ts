/**
 * Logger that writes to stderr only.
 * CRITICAL: In MCP channel servers, stdout is used for the stdio protocol.
 * Any console.log() would corrupt the protocol. Always use this logger.
 */
export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.error(`[claude-alarm] ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    console.error(`[claude-alarm WARN] ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`[claude-alarm ERROR] ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (process.env.CLAUDE_ALARM_DEBUG) {
      console.error(`[claude-alarm DEBUG] ${msg}`, ...args);
    }
  },
};
