import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (process.env.FAKE_CODEX_WRAPPER_PID_FILE) fs.writeFileSync(process.env.FAKE_CODEX_WRAPPER_PID_FILE, String(process.pid));
// Plays npm's codex.js: it runs the real binary on the same stdio and exits on its own as soon as that binary ends.
const child = spawn(process.execPath, [process.env.FAKE_CODEX_WRAPPED, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
