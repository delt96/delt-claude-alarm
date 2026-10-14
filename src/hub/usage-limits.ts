import { CLAUDE_LIMITS_FILE } from '../shared/constants.js';
import { readLimitsFile } from '../shared/usage-limits.js';
import type { UsageLimits } from '../shared/types.js';
import { readCodexLimits } from './codex-limits.js';

export function readUsageLimits(): UsageLimits {
  return { claude: readLimitsFile(CLAUDE_LIMITS_FILE), codex: readCodexLimits() };
}
