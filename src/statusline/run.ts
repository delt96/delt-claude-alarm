import { formatLimitsLine, parseClaudeRateLimits, writeLimitsFile } from '../shared/usage-limits.js';

export function runStatusLine(raw: string, limitsFile: string, now: number = Date.now()): string {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return '';
  }
  const limits = parseClaudeRateLimits(input);
  if (!limits) return '';
  try {
    writeLimitsFile(limitsFile, limits, now);
  } catch {}
  return formatLimitsLine(limits);
}
