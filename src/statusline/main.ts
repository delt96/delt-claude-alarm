import { CLAUDE_LIMITS_FILE } from '../shared/constants.js';
import { runStatusLine } from './run.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(runStatusLine(Buffer.concat(chunks).toString('utf8'), CLAUDE_LIMITS_FILE));
});
