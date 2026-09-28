import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// src/shared/constants.ts resolves ~/.claude-alarm at import time. The real
// directory can hold a live Telegram bot config and user uploads that
// HubServer.start() deletes, so every test process must get a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-alarm-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
