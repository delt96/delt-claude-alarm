# Stabilization 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages and photos sent to a session that is no longer connected stop vanishing silently (Hub, Telegram, dashboard), a Codex approval that starts mid-delivery is not answered by a steered message, the "Queued" notice goes back only to where the message came from, restored approvals stop flooding the dashboard, and closing an npm `codex.cmd` proxy no longer leaves the proxy running.

**Architecture:** The Hub already knows whether a session's channel socket is open; it now says so: a new `message_rejected` message to the dashboard that sent the text, and boolean return values from the two Telegram delivery callbacks, which `TelegramBot` turns into user-visible failure notices. The Codex adapter re-checks the thread's approval state right before `turn/steer`/`turn/start`, and tags only its "Queued" notice with `to: <message source>`, which the Hub routes to dashboards, the Telegram bot or the log. The dashboard gets small, separately testable helpers (`showNotDelivered`, `restorePendingRequests`, a single-flash `flashTitle`). `connectProxy` takes an injectable tree-kill function whose default ends the whole process tree with `taskkill /T /F` on Windows.

**Tech Stack:** TypeScript (ESM, Node 22), `ws`, Node built-ins (`child_process`, `fs`, `vm`, global `fetch`), `node:test` + `tsx`, a single inline-script dashboard HTML file.

**Spec:** docs/superpowers/specs/2026-10-05-stabilization-2-design.md

## Global Constraints

- Work on branch `fix/stabilization-2`; do not switch branches. No new dependencies.
- User-visible strings are exactly these (each task repeats the ones it needs): dashboard reason `the session is not connected`; dashboard error line `Message not delivered: <reason>` and notification title `Message not delivered` (level `warning`); Telegram `Not delivered: the session is no longer connected`; Telegram `Photo not delivered: the session is no longer connected`; Telegram button toast `Not delivered` (text) / `Photo not delivered` (photo); dashboard restore row `N approval request(s) waiting` with N the count and `(s)` written literally (level `warning`). Existing strings (`Queued: Codex will read it after its current step.`, `Codex is waiting for an approval or input. Answer it first, then send the message again.`, `Sent to …`, `Permission Request`) stay unchanged.
- Comments: none, except a one-line English comment for a non-obvious "why" (a counter-intuitive decision, an external constraint, a trap). No restating code, no change-history comments, no section dividers, no empty JSDoc. The code blocks below already contain the only comments allowed; when code moves, its old restating comments are dropped. Keep the existing anchor comments `// --- Permission relay ---` and `// Flash title for attention`: tests slice the dashboard at them.
- Line numbers cite the code before this plan (branch HEAD 4031194); earlier tasks shift them, so find each spot by the quoted code.
- Any hub a test or a person starts uses an isolated HOME and USERPROFILE (a temp directory) and a port other than 7900. Every new test file starts with `import './isolate-home.js';` (it must stay the first import); the test commands below also preload it. Ports 7989–7998 are all taken by existing tests (7989 `hub-upload-rejected`, 7990 `hub-readiness`, 7991 and 7995 `hub-message-source`, 7992 `hub-permission-choices`, 7993 `hub-client`, 7994 `codex-adapter`, 7996 `hub-ownership`, 7997 `hub-auth`, 7998 `hub-peer-name`), so this plan adds no new hub port: new hub tests go into the existing files that own one: `test/hub-upload-rejected.test.ts` (7989), `test/hub-message-source.test.ts` (7995, plus its Telegram hub on 7991, one test at a time), `test/codex-adapter.test.ts` (7994).
- Never kill processes by image name (`node.exe`, `codex.exe`, `cmd.exe`). Stop only processes a test started, by its `ChildProcess` handle or by the PID it recorded, in a `finally`. Never start the real `codex`, never run the real hub on 7900, no network commands.
- Nothing may reach a real Telegram bot: Telegram tests replace `globalThis.fetch` with `t.mock.method`.
- Commands. One file: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/<file>.test.ts` (several files may follow). All tests: `npm test` (434 tests before this plan, about 22 s). Type check: `npx tsc --noEmit` (there is no script for it; `tsconfig.json` covers `src/` only, so test files are not type-checked).
- `--test-timeout=30000` applies to each test file as a whole, not just to each test (checked: with `--test-timeout=10000` `codex-adapter.test.ts` is cut off after 10 s). `codex-adapter.test.ts` already takes about 22 s, so add only fast tests to it.
- In new tests, do not use a bare `assert.ok(expr)` for a condition that can fail: when it fails, Node re-reads the tsx-transpiled file (one long line) to quote the expression and can stall until the file timeout (seen in `codex-adapter.test.ts`). Use `assert.equal(expr, true)`, `assert.deepEqual(list, [])`, or give `assert.ok` a message.
- Dashboard tests evaluate slices of `src/dashboard/index.html` in `node:vm`. Arrays created inside the sandbox belong to another realm and fail `assert.deepEqual` against literal arrays; copy them with `Array.from(...)` first.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the second `-m` in each commit step below).
- Platform: Windows is the primary target; everything must also run on POSIX (Task 7's Windows-only tests are skipped there).

## Review Focus

1. A dashboard that reconnects (page reload, network blip) gets the same pending Codex approvals again → it must add no second summary row and no second title flash. Test: Task 6 "approvals the dashboard already shows add no row and no flash when restored again".
2. Replying in Telegram to a "Queued" notice → the reply must reach that session, so the Hub's direct send to the bot must still record the message-to-session mapping. Test: Task 5 "a notice addressed to Telegram goes only to the bot, and a reply to it reaches the session".
3. A dashboard message to a session whose socket is still listed but closing (between a disconnect and its cleanup) → rejected like a missing session, never sent. Test: Task 1 "a message for a session whose connection is closing is rejected, not sent".
4. A `notify` whose `to` the Hub does not know (an adapter newer than the Hub) → delivered as if `to` were absent (desktop, webhooks, Telegram, dashboards), not dropped. Test: Task 5 "a notice with an address this hub does not know goes everywhere, as before".
5. `close()` on a proxy that has already exited → no `taskkill` and no kill for its PID, which Windows may already have given to an unrelated process. Test: Task 7 "a proxy that has already exited is left alone, since its pid may now belong to another process".

## Spec Facts Checked and Deviations

- Every `file:line` the spec cites matches the code at f015793 and at this branch's HEAD (4031194 adds docs only). One citation is loose: "Codex 대화도 어댑터가 채널 소켓으로 등록" cites `adapter.ts:491-501`, which is `onHubMessage`; the per-conversation channel socket is opened in `upsert` (`adapter.ts:285-302`). The fact itself holds.
- Checked by experiment (in a scratch copy, by PID only): starting a fake `codex.cmd` through `defaultSpawn`, `child.kill()` ends `cmd.exe` and leaves the Node proxy running; `taskkill /PID <shell pid> /T /F` ends the shell, its `conhost` and the proxy; `taskkill` on an exited PID fails ("not found"); `@echo off` keeps the shell's stdout clean.
- Ports: the user rule asks for a free port in 7989–7998 for new hub tests; none is free, so new hub tests reuse the files that own 7989, 7991/7995 and 7994 (see Global Constraints). No new port is used.
- Files beyond the spec's table: Task 1's tests extend `test/hub-upload-rejected.test.ts` and `test/hub-message-source.test.ts` (and add a `telegramHub` helper there that Task 5 reuses); Task 2 changes the fakes in `test/telegram-limits.test.ts` and `test/telegram-session-select.test.ts` to return `true` (with the new contract, `telegram-limits`' "a photo within the limit is delivered without a message" fails otherwise); Task 3 turns `showUploadRejected` into a call to a shared `showNotDelivered`; Task 7 adds two opt-in variables to `test/fixtures/fake-codex-proxy.mjs` (default behaviour unchanged).
- Task 1 keeps `src/hub/telegram.ts` untouched as the spec's table says; the callback declarations change to `=> boolean` in Task 2. Task 1 annotates the Hub's two callbacks with `: boolean` so `tsc` already checks every return path.
- Decisions where the spec is silent: the restore row's title is `N approval request(s) waiting`, its message lists `toolName: description` of each restored request (the live rows' format), its session is the first restored request's, and the flash shows the same label; a `flashTitle` call during a flash changes only the message and does not restart the 30-second timer; a `to` the Hub does not know is treated as no `to`; `to: 'api'` logs `[label] title: message` with `logger.info`; Telegram's text failure notice is sent by `deliverToSession` itself, so the reply, single-session, `/s_N` and button paths all use it; `close()` ends stdin and then kills the tree at once (the spec gives no grace period); the tree kill does nothing for a child that has already exited (PID reuse), which keeps the spec's "only our PID and below" true.
- The spec's final manual run (isolated hub in a browser, real Telegram screens checked by the user) is not one of these tasks.

---

### Task 1: Hub reports delivery results

**Files:**
- Modify: `src/shared/types.ts:50` (add a `ChannelMessage` member after `upload_rejected`)
- Modify: `src/hub/server.ts:703-707` (dashboard `message_to_session`), `src/hub/server.ts:839-854` (`initTelegram` callbacks)
- Test: `test/hub-upload-rejected.test.ts` (port 7989), `test/hub-message-source.test.ts` (ports 7995 and 7991)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ChannelMessage` member `{ type: 'message_rejected'; sessionId: string; reason: string }`, sent by the Hub only to the dashboard socket that sent the `message_to_session`, with `reason: 'the session is not connected'` (Task 3 renders it).
  - The Hub's `telegramBot.onMessageToSession = (sessionId, content): boolean` and `telegramBot.onImageToSession = (sessionId, imagePath, mimeType, caption): boolean`: `true` only when the message was sent on an OPEN channel socket, otherwise `false` plus one `logger.warn` line naming the session (Task 2 relies on this).
  - In `test/hub-message-source.test.ts`: `const TG_PORT = 7991` and `async function telegramHub(t: TestContext): Promise<{ hub: HubServer; sent: string[] }>`: it mocks `fetch`, saves a Telegram-enabled config into the isolated HOME and starts a Hub on `TG_PORT`; `sent` collects the `text` of every fake `sendMessage`, and the n-th send gets `message_id` `100 + n` (so `101 + index`). The caller stops the Hub in a `finally` (Task 5 reuses it).

- [ ] **Step 1: Write the failing tests**

In `test/hub-upload-rejected.test.ts`, add this import directly after `import { HubServer } from '../src/hub/server.js';`:

```ts
import { logger } from '../src/shared/logger.js';
```

and append at the end of the file:

```ts
const say = (dash: { ws: WebSocket }, sessionId: string, content = 'hi') =>
  dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId, content }));
const messageRejection = (dash: { inbox: any[] }, sessionId: string) =>
  until(() => dash.inbox.find((m) => m.type === 'message_rejected' && m.sessionId === sessionId));

test('a message for a session that is not connected is rejected with a reason and a warning', async (t) => {
  const warn = t.mock.method(logger, 'warn');
  const dash = await open('/ws/dashboard');
  try {
    say(dash, 'msg-nobody');
    assert.deepEqual(await messageRejection(dash, 'msg-nobody'), { type: 'message_rejected', sessionId: 'msg-nobody', reason: 'the session is not connected' });
    assert.equal(warn.mock.calls.some((c) => String(c.arguments[0]).includes('msg-nobody')), true);
  } finally { dash.ws.close(); }
});

test('a message rejection goes only to the dashboard that sent the message', async () => {
  const sender = await open('/ws/dashboard');
  const other = await open('/ws/dashboard');
  try {
    say(sender, 'msg-nobody-2');
    await messageRejection(sender, 'msg-nobody-2');
    await settle();
    assert.deepEqual(other.inbox.filter((m) => m.type === 'message_rejected'), []);
  } finally { sender.ws.close(); other.ws.close(); }
});

test('a message for a session whose connection is closing is rejected, not sent', async () => {
  const ch = await channel('msg-closing');
  const dash = await open('/ws/dashboard');
  const sockets = (hub as any).channelSockets as Map<string, unknown>;
  const real = sockets.get('msg-closing');
  let sends = 0;
  sockets.set('msg-closing', { readyState: WebSocket.CLOSING, send() { sends++; }, ping() {}, terminate() {} });
  try {
    say(dash, 'msg-closing');
    assert.equal((await messageRejection(dash, 'msg-closing')).reason, 'the session is not connected');
    assert.equal(sends, 0);
  } finally {
    sockets.set('msg-closing', real);
    dash.ws.close();
    ch.ws.close();
  }
});

test('a message for a connected session reaches it and is not rejected', async () => {
  const ch = await channel('msg-ok');
  const dash = await open('/ws/dashboard');
  try {
    say(dash, 'msg-ok', 'hello');
    assert.equal((await until(() => ch.inbox.find((m) => m.type === 'message_to_session'))).content, 'hello');
    await settle();
    assert.deepEqual(dash.inbox.filter((m) => m.type === 'message_rejected'), []);
  } finally { dash.ws.close(); ch.ws.close(); }
});
```

In `test/hub-message-source.test.ts`:

1. Change `import { test, before, after } from 'node:test';` to:

```ts
import { test, before, after, type TestContext } from 'node:test';
```

2. Add directly after `import { saveConfig } from '../src/shared/config.js';`:

```ts
import { logger } from '../src/shared/logger.js';
```

3. Add directly after `const PORT = 7995;`:

```ts
const TG_PORT = 7991;
```

4. Replace the whole last test, `test('Telegram photos are tagged telegram', …)` (from its `test(` line to the end of the file), with:

```ts
async function telegramHub(t: TestContext): Promise<{ hub: HubServer; sent: string[] }> {
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: { body?: string }) => {
    if (String(url).endsWith('/sendMessage')) {
      sent.push(JSON.parse(init?.body ?? '{}').text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length } }));
    }
    return new Response(JSON.stringify({ ok: true, result: [] }));
  });
  saveConfig({ hub: { host: '127.0.0.1', port: TG_PORT }, notifications: { desktop: false, sound: false }, webhooks: [], telegram: { enabled: true, botToken: 'x', chatId: '111' } } as any);
  const tgHub = new HubServer({ hub: { host: '127.0.0.1', port: TG_PORT, token: TOKEN }, notifications: { desktop: false, sound: false } } as any);
  await tgHub.start();
  return { hub: tgHub, sent };
}

test('Telegram photos are tagged telegram', async (t) => {
  const tg = await telegramHub(t);
  try {
    const ch = await open('/ws/channel', TG_PORT);
    register(ch.ws, 'src-tg');
    await settle();
    (tg.hub as any).telegramBot.onImageToSession('src-tg', 'C:\\uploads\\photo.jpg', 'image/jpeg', 'from phone');
    await settle();
    const got = ch.inbox.find((m) => m.type === 'image_to_session');
    assert.equal(got?.source, 'telegram');
    assert.equal(got?.content, 'from phone');
    ch.ws.close();
  } finally {
    await tg.hub.stop();
  }
});

test('Telegram callbacks say whether the session got the message', async (t) => {
  const tg = await telegramHub(t);
  const warn = t.mock.method(logger, 'warn');
  try {
    const ch = await open('/ws/channel', TG_PORT);
    register(ch.ws, 'tg-live');
    await settle();
    const bot = (tg.hub as any).telegramBot;
    assert.equal(bot.onMessageToSession('tg-live', 'hello'), true);
    assert.equal(bot.onImageToSession('tg-live', 'C:\\uploads\\p.jpg', 'image/jpeg'), true);
    assert.equal(bot.onMessageToSession('tg-gone', 'hello'), false);
    assert.equal(bot.onImageToSession('tg-gone', 'C:\\uploads\\p.jpg', 'image/jpeg'), false);
    assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).includes('tg-gone')).length, 2);
    await settle();
    assert.deepEqual(ch.inbox.filter((m) => m.type === 'message_to_session' || m.type === 'image_to_session').map((m) => m.type), ['message_to_session', 'image_to_session']);
    ch.ws.close();
  } finally {
    await tg.hub.stop();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/hub-upload-rejected.test.ts test/hub-message-source.test.ts`
Expected: FAIL, 4 of 16. "a message for a session that is not connected…", "a message rejection goes only to the dashboard…" and "a message for a session whose connection is closing…" fail with `condition not met in time` (no `message_rejected` arrives; each waits 4 s). "Telegram callbacks say whether the session got the message" fails with `expected: true` (the callback returns `undefined`). "a message for a connected session reaches it…" and the refactored "Telegram photos are tagged telegram" pass.

- [ ] **Step 3: Implement**

1. In `src/shared/types.ts`, add after the `upload_rejected` member of `ChannelMessage`:

```ts
  | { type: 'message_rejected'; sessionId: string; reason: string }
```

2. In `src/hub/server.ts`, `handleDashboardConnection`, replace:

```ts
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
          }
        } else if (msg.type === 'image_upload') {
```

with:

```ts
          const channelWs = this.channelSockets.get(msg.sessionId);
          if (channelWs?.readyState === WebSocket.OPEN) {
            channelWs.send(JSON.stringify({ ...msg, source: 'dashboard' }));
          } else {
            const reason = 'the session is not connected';
            logger.warn(`Message rejected for ${msg.sessionId}: ${reason}`);
            const rejected: ChannelMessage = { type: 'message_rejected', sessionId: msg.sessionId, reason };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(rejected));
          }
        } else if (msg.type === 'image_upload') {
```

3. In `src/hub/server.ts`, `initTelegram`, replace the two callbacks:

```ts
    this.telegramBot.onMessageToSession = (sessionId, content) => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState === WebSocket.OPEN) {
        const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
        channelWs.send(JSON.stringify(msg));
        logger.info(`Telegram message forwarded to session: ${sessionId}`);
      }
    };
    this.telegramBot.onImageToSession = (sessionId, imagePath, mimeType, caption) => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState === WebSocket.OPEN) {
        const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
        channelWs.send(JSON.stringify(msg));
        logger.info(`Telegram photo forwarded to session: ${sessionId}`);
      }
    };
```

with:

```ts
    this.telegramBot.onMessageToSession = (sessionId, content): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram message not delivered to ${sessionId}: the session is not connected`);
        return false;
      }
      const msg: ChannelMessage = { type: 'message_to_session', sessionId, content, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      logger.info(`Telegram message forwarded to session: ${sessionId}`);
      return true;
    };
    this.telegramBot.onImageToSession = (sessionId, imagePath, mimeType, caption): boolean => {
      const channelWs = this.channelSockets.get(sessionId);
      if (channelWs?.readyState !== WebSocket.OPEN) {
        logger.warn(`Telegram photo not delivered to ${sessionId}: the session is not connected`);
        return false;
      }
      const msg: ChannelMessage = { type: 'image_to_session', sessionId, imagePath, mimeType, content: caption, source: 'telegram' };
      channelWs.send(JSON.stringify(msg));
      logger.info(`Telegram photo forwarded to session: ${sessionId}`);
      return true;
    };
```

(The declared callback types in `src/hub/telegram.ts` still return `void` until Task 2; a function returning `boolean` is assignable to them.)

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/hub-upload-rejected.test.ts test/hub-message-source.test.ts`
Expected: PASS, 16 of 16.
Run: `npx tsc --noEmit` → no output, exit 0.
Run: `npm test` → `# fail 0` (439 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/hub/server.ts test/hub-upload-rejected.test.ts test/hub-message-source.test.ts
git commit -m "fix(hub): tell the sender when a dashboard or Telegram message finds no session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Telegram says when a message or photo was not delivered

**Files:**
- Modify: `src/hub/telegram.ts` (constant after `MAX_PHOTO_BYTES` at line 15; callback declarations at 75-77; `/s_N` branch at 259-266; `deliverToSession` at 314-318; photo hand-off at 356-361; session button at 586-597)
- Modify: `test/telegram-limits.test.ts:28`, `test/telegram-session-select.test.ts:19` (fakes return `true`)
- Test: `test/telegram-delivery.test.ts` (new, no hub, fake fetch)

**Interfaces:**
- Consumes: Task 1: the Hub's callbacks return `true` only when the session got the message.
- Produces: `TelegramBot.onMessageToSession?: (sessionId: string, content: string) => boolean`; `TelegramBot.onImageToSession?: (sessionId: string, imagePath: string, mimeType: string, caption?: string) => boolean`. Anything but `true` (including a missing callback) counts as not delivered.

- [ ] **Step 1: Write the failing tests**

In `test/telegram-limits.test.ts`, change the fake to:

```ts
  bot.onImageToSession = (id, _path, mime) => { images.push(`${id}:${mime}`); return true; };
```

In `test/telegram-session-select.test.ts`, change the fake to:

```ts
  bot.onMessageToSession = (id, content) => { delivered.push(`${id}:${content}`); return true; };
```

Create `test/telegram-delivery.test.ts`:

```ts
// Must stay the first import: it redirects the home directory before any src module reads it.
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TelegramBot } from '../src/hub/telegram.js';

const GONE = 'Not delivered: the session is no longer connected';
const PHOTO_GONE = 'Photo not delivered: the session is no longer connected';

const s = (id: string) => ({ id, name: id, displayName: id, status: 'idle' as const, connectedAt: 0, lastActivity: 0 });

function setup(t: any, sessions: ReturnType<typeof s>[], accept: boolean) {
  const calls: Array<{ api: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/p.jpg' } }));
    if (u.includes('/file/bot')) return new Response(new Uint8Array(10));
    calls.push({ api: u.split('/').pop()!, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  });
  const bot = new TelegramBot({ botToken: 'x', chatId: '111', enabled: true } as any);
  bot.getSessions = () => sessions;
  const texts: string[] = [];
  const photos: string[] = [];
  bot.onMessageToSession = (id, content) => { texts.push(`${id}:${content}`); return accept; };
  bot.onImageToSession = (_id, imagePath) => { photos.push(imagePath); return accept; };
  return { bot, calls, texts, photos };
}

const sent = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'sendMessage').map((c) => c.body.text);
const say = (bot: TelegramBot, text: string, extra: Record<string, unknown> = {}) =>
  (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, text, ...extra });
const sendPhoto = (bot: TelegramBot) =>
  (bot as any).handleIncomingMessage({ message_id: 1, chat: { id: 111 }, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1, file_size: 10 }] });
const press = (bot: TelegramBot, data: string) =>
  (bot as any).handleCallbackQuery({ id: 'q', data, message: { chat: { id: 111 }, message_id: 7, text: '' } });
const firstButton = (calls: Array<{ api: string; body: any }>) =>
  calls.find((c) => c.api === 'sendMessage' && c.body?.reply_markup)!.body.reply_markup.inline_keyboard[0][0].callback_data;
const toast = (calls: Array<{ api: string; body: any }>) => calls.filter((c) => c.api === 'answerCallbackQuery').pop()?.body.text;

test('a reply to a notification from a session that is gone says it was not delivered', async (t) => {
  const { bot, calls, texts } = setup(t, [], false);
  await bot.sendNotification('gone', 'Gone', 'Done', 'finished');
  await say(bot, 'thanks', { message_id: 2, reply_to_message: { message_id: 7 } });
  assert.deepEqual(texts, ['gone:thanks']);
  assert.deepEqual(sent(calls), ['<b>Done</b>\nfinished', GONE]);
});

test('a reply that is delivered sends nothing back', async (t) => {
  const { bot, calls } = setup(t, [], true);
  await bot.sendNotification('live', 'Live', 'Done', 'finished');
  await say(bot, 'thanks', { message_id: 2, reply_to_message: { message_id: 7 } });
  assert.deepEqual(sent(calls), ['<b>Done</b>\nfinished']);
});

test('with one session, a message that cannot be delivered is reported', async (t) => {
  const { bot, calls } = setup(t, [s('a')], false);
  await say(bot, 'hello');
  assert.deepEqual(sent(calls), [GONE]);
});

test('with one session, a delivered message sends nothing back', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a')], true);
  await say(bot, 'hello');
  assert.deepEqual(texts, ['a:hello']);
  assert.deepEqual(sent(calls), []);
});

test('/s_N does not claim a text was sent when the session is gone', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a'), s('b')], false);
  await say(bot, 'hello');
  await say(bot, '/s_1', { message_id: 2 });
  assert.deepEqual(texts, ['a:hello']);
  assert.equal(sent(calls).includes(GONE), true);
  assert.deepEqual(sent(calls).filter((x) => x.startsWith('Sent to')), []);
});

test('/s_N still says where a delivered text went', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')], true);
  await say(bot, 'hello');
  await say(bot, '/s_2', { message_id: 2 });
  assert.equal(sent(calls).at(-1), 'Sent to [b]');
});

test('a session button for a text whose session is gone says Not delivered and clears the buttons', async (t) => {
  const { bot, calls, texts } = setup(t, [s('a'), s('b')], false);
  await say(bot, 'hello');
  await press(bot, firstButton(calls));
  assert.deepEqual(texts, ['a:hello']);
  assert.equal(toast(calls), 'Not delivered');
  assert.equal(sent(calls).includes(GONE), true);
  assert.equal(calls.some((c) => c.api === 'editMessageReplyMarkup' && c.body.reply_markup.inline_keyboard.length === 0), true);
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageText'), []);
});

test('a session button for a delivered text still says where it went', async (t) => {
  const { bot, calls } = setup(t, [s('a'), s('b')], true);
  await say(bot, 'hello');
  await press(bot, firstButton(calls));
  assert.equal(toast(calls), 'Sent to a');
  assert.equal(calls.find((c) => c.api === 'editMessageText')!.body.text, '✅ Sent to <b>a</b>');
});

test('a photo the session cannot take is deleted at once and reported', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a')], false);
  await sendPhoto(bot);
  assert.equal(photos.length, 1);
  assert.equal(fs.existsSync(photos[0]), false);
  assert.deepEqual(sent(calls), [PHOTO_GONE]);
});

test('a delivered photo stays for the session to read', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a')], true);
  await sendPhoto(bot);
  assert.equal(fs.existsSync(photos[0]), true);
  assert.deepEqual(sent(calls), []);
});

test('a session button for a photo whose session is gone does not claim it was sent', async (t) => {
  const { bot, calls, photos } = setup(t, [s('a'), s('b')], false);
  await sendPhoto(bot);
  await press(bot, firstButton(calls));
  assert.equal(fs.existsSync(photos[0]), false);
  assert.equal(toast(calls), 'Photo not delivered');
  assert.equal(sent(calls).includes(PHOTO_GONE), true);
  assert.equal(calls.some((c) => c.api === 'editMessageReplyMarkup' && c.body.reply_markup.inline_keyboard.length === 0), true);
  assert.deepEqual(calls.filter((c) => c.api === 'editMessageText'), []);
});

test('a message with no hub callback is reported as not delivered', async (t) => {
  const { bot, calls } = setup(t, [s('a')], true);
  bot.onMessageToSession = undefined;
  await say(bot, 'hello');
  assert.deepEqual(sent(calls), [GONE]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/telegram-delivery.test.ts test/telegram-limits.test.ts test/telegram-session-select.test.ts`
Expected: FAIL, 7 tests, all in `telegram-delivery.test.ts`: "a reply to a notification from a session that is gone…", "with one session, a message that cannot be delivered…", "/s_N does not claim…", "a session button for a text whose session is gone…", "a photo the session cannot take…", "a session button for a photo whose session is gone…", "a message with no hub callback…". The other five new tests and every test in the two changed files pass.

- [ ] **Step 3: Implement** (all in `src/hub/telegram.ts`)

1. Add after `const MAX_PHOTO_BYTES = 10 * 1024 * 1024;`:

```ts
const NO_LONGER_CONNECTED = 'the session is no longer connected';
```

2. Change the two callback declarations to:

```ts
  public onMessageToSession?: (sessionId: string, content: string) => boolean;
```

```ts
  public onImageToSession?: (sessionId: string, imagePath: string, mimeType: string, caption?: string) => boolean;
```

3. In `handleIncomingMessage`, replace:

```ts
          if (session) {
            let delivered = true;
            if (pending.photoFileId) {
              delivered = await this.deliverPhotoToSessionByFileId(session.id, pending.photoFileId, pending.caption);
            } else if (pending.text) {
              this.deliverToSession(session.id, pending.text);
            }
            if (delivered) this.sendMessage(`Sent to [${this.getLabel(session)}]`);
          } else {
```

with:

```ts
          if (session) {
            if (await this.deliverPending(session.id, pending)) this.sendMessage(`Sent to [${this.getLabel(session)}]`);
          } else {
```

4. Replace `deliverToSession`:

```ts
  private deliverToSession(sessionId: string, content: string): void {
    if (this.onMessageToSession) {
      this.onMessageToSession(sessionId, content);
    }
  }
```

with:

```ts
  private deliverToSession(sessionId: string, content: string): boolean {
    const delivered = this.onMessageToSession?.(sessionId, content) === true;
    if (!delivered) void this.sendMessage(`Not delivered: ${NO_LONGER_CONNECTED}`);
    return delivered;
  }

  private async deliverPending(sessionId: string, pending: PendingSelection): Promise<boolean> {
    if (pending.photoFileId) return this.deliverPhotoToSessionByFileId(sessionId, pending.photoFileId, pending.caption);
    return pending.text ? this.deliverToSession(sessionId, pending.text) : false;
  }
```

5. In `deliverPhotoToSessionByFileId`, replace:

```ts
      if (this.onImageToSession) {
        this.onImageToSession(sessionId, filePath, mimeType, caption);
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5 * 60 * 1000).unref();
      return this.onImageToSession !== undefined;
```

with:

```ts
      if (this.onImageToSession?.(sessionId, filePath, mimeType, caption) !== true) {
        try { fs.unlinkSync(filePath); } catch {}
        this.photoNotDelivered(NO_LONGER_CONNECTED);
        return false;
      }

      setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5 * 60 * 1000).unref();
      return true;
```

6. In `handleSessionSelectCallback`, replace:

```ts
    if (pending.photoFileId) {
      const delivered = await this.deliverPhotoToSessionByFileId(session.id, pending.photoFileId, pending.caption);
      if (!delivered) {
        await this.answerCallbackQuery(query.id, 'Photo not delivered');
        if (query.message) await this.removeButtons(query.message.chat.id, query.message.message_id);
        return;
      }
    } else if (pending.text) {
      this.deliverToSession(session.id, pending.text);
    }

    await this.answerCallbackQuery(query.id, `Sent to ${this.getLabel(session)}`);
```

with:

```ts
    if (!(await this.deliverPending(session.id, pending))) {
      await this.answerCallbackQuery(query.id, pending.photoFileId ? 'Photo not delivered' : 'Not delivered');
      if (query.message) await this.removeButtons(query.message.chat.id, query.message.message_id);
      return;
    }

    await this.answerCallbackQuery(query.id, `Sent to ${this.getLabel(session)}`);
```

The reply path (`telegram.ts:239-248`) and the single-session path (`telegram.ts:283-289`) keep calling `deliverToSession` as they do; they now get the failure notice from it and stay silent on success.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/telegram-delivery.test.ts test/telegram-limits.test.ts test/telegram-session-select.test.ts test/telegram-callback.test.ts test/telegram-choices.test.ts test/hub-message-source.test.ts`
Expected: PASS, every test.
Run: `npx tsc --noEmit` → exit 0.
Run: `npm test` → `# fail 0` (451 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram.ts test/telegram-delivery.test.ts test/telegram-limits.test.ts test/telegram-session-select.test.ts
git commit -m "fix(telegram): say when a message or photo did not reach its session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dashboard shows `message_rejected`

**Files:**
- Modify: `src/dashboard/index.html:1288-1297` (`showUploadRejected` becomes a call to a new shared helper; new `showMessageRejected`), `src/dashboard/index.html:1462-1464` (message switch)
- Test: `test/dashboard-message-rejected.test.ts` (new, `node:vm`)

**Interfaces:**
- Consumes: Task 1: `{ type: 'message_rejected'; sessionId: string; reason: string }`.
- Produces (dashboard script): `showMessageRejected(msg)`; `showNotDelivered(sessionId, label, reason)`, which clears "waiting for reply" for that session, puts `<label>: <reason>` under the input when that session is selected (re-rendering its messages, which stay as they are), and adds a `warning` notification titled `label` with `message: reason`.

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard-message-rejected.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

// The dashboard is a single inline-script HTML file; evaluate the delivery-failure helpers in a sandbox.
function load(selectedSession: string) {
  const start = html.indexOf('  function showUploadRejected(msg) {');
  const end = html.indexOf('  let mentionState = ');
  assert.ok(start > 0 && end > start, 'showUploadRejected anchors not found');
  const errors: string[] = [];
  let renders = 0;
  let messageRenders = 0;
  const ctx: Record<string, any> = {
    state: {
      selectedSession,
      notifications: [],
      waitingReply: { s1: true },
      messages: { s1: [{ from: 'dashboard', content: 'hi', time: 1 }] },
    },
    renderMessages: () => { messageRenders++; },
    showMentionError: (m: string) => errors.push(m),
    renderNotifications: () => { renders++; },
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end), ctx);
  return { ctx, errors, renders: () => renders, messageRenders: () => messageRenders };
}

test('the dashboard handles message_rejected messages', () => {
  assert.match(html, /case 'message_rejected':\s*showMessageRejected\(msg\);\s*break;/);
});

test('a rejected message for the open session shows under the input and in the notifications', () => {
  const { ctx, errors, renders, messageRenders } = load('s1');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, ['Message not delivered: the session is not connected']);
  const [n] = ctx.state.notifications;
  assert.equal(n.sessionId, 's1');
  assert.equal(n.title, 'Message not delivered');
  assert.equal(n.message, 'the session is not connected');
  assert.equal(n.level, 'warning');
  assert.equal(typeof n.time, 'number');
  assert.equal(renders(), 1);
  assert.equal(ctx.state.waitingReply.s1, false);
  assert.equal(messageRenders(), 1);
});

test('the message already drawn stays in the conversation', () => {
  const { ctx } = load('s1');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(ctx.state.messages.s1.map((m: any) => m.content), ['hi']);
});

test('a rejected message for another session only goes to the notifications', () => {
  const { ctx, errors, messageRenders } = load('s2');
  ctx.showMessageRejected({ type: 'message_rejected', sessionId: 's1', reason: 'the session is not connected' });
  assert.deepEqual(errors, []);
  assert.equal(messageRenders(), 0);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(ctx.state.waitingReply.s1, false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/dashboard-message-rejected.test.ts`
Expected: FAIL, 4 of 4: the first does not match `case 'message_rejected'`, the others throw `ctx.showMessageRejected is not a function`.

- [ ] **Step 3: Implement** (in `src/dashboard/index.html`)

1. Replace `showUploadRejected`:

```js
  function showUploadRejected(msg) {
    state.waitingReply[msg.sessionId] = false;
    const label = msg.withText ? 'Image and message not delivered' : 'Image not delivered';
    if (state.selectedSession === msg.sessionId) {
      renderMessages();
      showMentionError(`${label}: ${msg.reason}`);
    }
    state.notifications.unshift({ sessionId: msg.sessionId, title: label, message: msg.reason, level: 'warning', time: Date.now() });
    renderNotifications();
  }
```

with (all three functions stay before `  let mentionState = `, which the tests use as an anchor):

```js
  function showUploadRejected(msg) {
    showNotDelivered(msg.sessionId, msg.withText ? 'Image and message not delivered' : 'Image not delivered', msg.reason);
  }

  function showMessageRejected(msg) {
    showNotDelivered(msg.sessionId, 'Message not delivered', msg.reason);
  }

  function showNotDelivered(sessionId, label, reason) {
    state.waitingReply[sessionId] = false;
    if (state.selectedSession === sessionId) {
      renderMessages();
      showMentionError(`${label}: ${reason}`);
    }
    state.notifications.unshift({ sessionId, title: label, message: reason, level: 'warning', time: Date.now() });
    renderNotifications();
  }
```

2. In `handleMessage`, replace:

```js
      case 'upload_rejected':
        showUploadRejected(msg);
        break;
```

with:

```js
      case 'upload_rejected':
        showUploadRejected(msg);
        break;
      case 'message_rejected':
        showMessageRejected(msg);
        break;
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/dashboard-message-rejected.test.ts test/dashboard-upload-rejected.test.ts`
Expected: PASS, 8 of 8.
Run: `npm test` → `# fail 0` (455 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html test/dashboard-message-rejected.test.ts
git commit -m "fix(dashboard): show when a message was not delivered" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: M2, re-check for a pending approval right before steering

**Files:**
- Modify: `src/codex/adapter.ts:512-552` (`deliver`, plus two new private methods after it)
- Test: `test/codex-adapter.test.ts` (port 7994, fake daemon; append)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 5, which edits `deliver` as it stands after this task): `private abandonDelivery(t: Tracked, wasUnrelayed: boolean): void` (resets `pendingTurn`, restores `unrelayed`, calls `releaseLater`); `private refuseWhileWaiting(threadId: string): void` (the existing `Not delivered` / `Codex is waiting for an approval or input. Answer it first, then send the message again.` warning).

- [ ] **Step 1: Write the failing tests**

Append at the end of `test/codex-adapter.test.ts` (it already defines `active`, `thread`, `startAdapter`, `session`, `openDashboard`, `adapter`, `until`). The fake daemon sends the status change from inside its `thread/turns/list` handler, before the reply, so the adapter sees the approval start after its first check and before it steers:

```ts
const waiting = { type: 'active', activeFlags: ['waitingOnApproval'] };
const WAITING_NOTICE = 'Codex is waiting for an approval or input. Answer it first, then send the message again.';

test('an approval that starts while a message is being prepared gets no steer', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/status/changed', { threadId: 't1', status: waiting });
      return { data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null };
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also this' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal(n.level, 'warning');
    assert.equal(n.message, WAITING_NOTICE);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/steer').length, 0);
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('an approval that starts while a message is being prepared gets no new turn either', async () => {
  const d = await startAdapter([thread('t1')], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/status/changed', { threadId: 't1', status: waiting });
      return { data: [], nextCursor: null };
    });
  });
  await session('codex:t1');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'hello' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal(n.message, WAITING_NOTICE);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.calls('turn/start').length, 0);
  } finally {
    dash.ws.close();
  }
});

test('a message refused at the last moment does not leave the conversation marked busy', async () => {
  const d = await startAdapter([thread('t1', { status: active })], (dm) => {
    dm.handle('thread/turns/list', () => {
      dm.notify('thread/started', { thread: thread('t1', { status: waiting }) });
      return { data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null };
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    dash.ws.send(JSON.stringify({ type: 'message_to_session', sessionId: 'codex:t1', content: 'also this' }));
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.sessionId === 'codex:t1'));
    assert.equal(n.title, 'Not delivered');
    assert.equal((adapter as any).threads.get('t1').pendingTurn, false);
    assert.equal(d.calls('turn/steer').length, 0);
  } finally {
    dash.ws.close();
  }
});
```

(The third test uses `thread/started`, which updates the thread without resetting `pendingTurn`; a status notification would reset it and hide a missing reset. Checked: without `abandonDelivery` in the new branch this test fails with `expected: false, actual: true`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-adapter.test.ts`
Expected: FAIL, 3 of 56: the first and third with `expected: 'Not delivered'`, `actual: 'Queued'` (the message was steered), the second with `condition not met in time` (a turn was started and no notice came).

- [ ] **Step 3: Implement** (in `src/codex/adapter.ts`)

1. In `deliver`, replace the first check's body:

```ts
    if (hubStatus(t.thread.status) === 'waiting_input') {
      this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
      return;
    }
```

with:

```ts
    if (hubStatus(t.thread.status) === 'waiting_input') {
      this.refuseWhileWaiting(threadId);
      return;
    }
```

(keep the comment above it unchanged).

2. Replace the rest of `deliver` from `const running = await this.runningTurn(rpc, threadId);` to the end of the method:

```ts
      const running = await this.runningTurn(rpc, threadId);
      if (this.threads.get(threadId) !== t) return;
      if (unsubscribed) t.unrelayed = true;
      if (running) {
        await rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info');
        return;
      }
      await rpc.request('turn/start', { threadId, input });
    } catch (err) {
      t.pendingTurn = false;
      t.unrelayed = wasUnrelayed;
      this.releaseLater(t);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }
```

with:

```ts
      const running = await this.runningTurn(rpc, threadId);
      if (this.threads.get(threadId) !== t) return;
      // An approval can start while the input is built and the turn looked up; the check at the top cannot see it.
      if (hubStatus(t.thread.status) === 'waiting_input') {
        this.abandonDelivery(t, wasUnrelayed);
        this.refuseWhileWaiting(threadId);
        return;
      }
      if (unsubscribed) t.unrelayed = true;
      if (running) {
        await rpc.request('turn/steer', { threadId, expectedTurnId: running, input });
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info');
        return;
      }
      await rpc.request('turn/start', { threadId, input });
    } catch (err) {
      this.abandonDelivery(t, wasUnrelayed);
      this.notify(threadId, 'Not delivered', `Codex rejected the message: ${(err as Error).message}`, 'warning');
    }
  }

  private abandonDelivery(t: Tracked, wasUnrelayed: boolean): void {
    t.pendingTurn = false;
    t.unrelayed = wasUnrelayed;
    this.releaseLater(t);
  }

  private refuseWhileWaiting(threadId: string): void {
    this.notify(threadId, 'Not delivered', 'Codex is waiting for an approval or input. Answer it first, then send the message again.', 'warning');
  }
```

The gaps the spec accepts remain: between this check and the RPC, and between the RPC and the daemon handling it.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-adapter.test.ts`
Expected: PASS, 56 of 56 (about 21 s).
Run: `npx tsc --noEmit` → exit 0.
Run: `npm test` → `# fail 0` (458 tests).

- [ ] **Step 5: Commit**

```bash
git add src/codex/adapter.ts test/codex-adapter.test.ts
git commit -m "fix(codex): re-check for a pending approval right before steering a message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: "Queued" goes only to where the message came from

**Files:**
- Modify: `src/shared/types.ts:45` (`notify` member gets `to?: MessageSource`)
- Modify: `src/codex/adapter.ts` (import, `onHubMessage`, `enqueue`, `deliver` as left by Task 4, `notify`)
- Modify: `src/hub/server.ts:483-497` (`case 'notify'`)
- Test: `test/codex-adapter.test.ts` (port 7994; append), `test/hub-message-source.test.ts` (ports 7995 and 7991; append)

**Interfaces:**
- Consumes: Task 4's `deliver` (code shown below as it stands after Task 4); Task 1's `telegramHub(t)` and `TG_PORT` in `test/hub-message-source.test.ts`.
- Produces: `ChannelMessage` `notify` member `{ type: 'notify'; sessionId: string; title: string; message: string; level?: NotifyLevel; to?: MessageSource }`. Hub routing: `to === 'dashboard'` → dashboards only (`notification`); `'telegram'` → only `telegramBot.sendNotification(sessionId, label, '[label] title', message)` (nowhere if there is no bot); `'api'` → one `logger.info` line `[label] title: message`; absent or unknown → as before (notifier: desktop, webhooks, Telegram; plus dashboards). Adapter: `private notify(threadId, title, message, level, to?: MessageSource)`; only the "Queued" notice passes the message's `source`.

- [ ] **Step 1: Write the failing tests**

Append at the end of `test/codex-adapter.test.ts` (after Task 4's tests):

```ts
function hubSends(threadId: string): any[] {
  const link = (adapter as any).threads.get(threadId).hub;
  const sent: any[] = [];
  const send = link.send.bind(link);
  link.send = (m: any) => {
    sent.push(m);
    return send(m);
  };
  return sent;
}

const steering = (dm: FakeDaemon) =>
  dm.handle('thread/turns/list', () => ({ data: [{ id: 'u9', status: 'inProgress', items: [] }], nextCursor: null }));

test('the Queued notice is addressed to where the message came from', async () => {
  await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const toHub = hubSends('t1');
  for (const source of ['telegram', 'api', 'dashboard']) {
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: `from ${source}`, source });
  }
  const queued = await until(() => {
    const q = toHub.filter((m) => m.type === 'notify' && m.title === 'Queued');
    return q.length === 3 && q;
  });
  assert.deepEqual(queued.map((m) => m.to), ['telegram', 'api', 'dashboard']);
});

test('a Queued notice for a message from Telegram does not reach the dashboard', async () => {
  const d = await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from phone', source: 'telegram' });
    await until(() => d.calls('turn/steer').length === 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(dash.inbox.filter((m) => m.type === 'notification' && m.title === 'Queued'), []);
  } finally {
    dash.ws.close();
  }
});

test('a Queued notice for a message without a source still goes everywhere', async () => {
  await startAdapter([thread('t1', { status: active })], steering);
  await session('codex:t1', (s) => s.status === 'working');
  const dash = await openDashboard();
  try {
    const toHub = hubSends('t1');
    (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from an old hub' });
    const n = await until(() => dash.inbox.find((m) => m.type === 'notification' && m.title === 'Queued'));
    assert.equal(n.level, 'info');
    assert.equal('to' in toHub.find((m) => m.type === 'notify'), false);
  } finally {
    dash.ws.close();
  }
});

test('other notices stay unaddressed even for a message from Telegram', async () => {
  await startAdapter([thread('t1', { status: active })], (dm) => {
    steering(dm);
    dm.handle('turn/steer', () => {
      throw new Error('no active turn to steer');
    });
  });
  await session('codex:t1', (s) => s.status === 'working');
  const toHub = hubSends('t1');
  (adapter as any).onHubMessage('t1', { type: 'message_to_session', sessionId: 'codex:t1', content: 'from phone', source: 'telegram' });
  const n = await until(() => toHub.find((m) => m.type === 'notify'));
  assert.equal(n.title, 'Not delivered');
  assert.equal('to' in n, false);
});
```

In `test/hub-message-source.test.ts`, add directly after `import { logger } from '../src/shared/logger.js';`:

```ts
import { until } from './helpers/fake-codex-daemon.js';
```

and append at the end of the file:

```ts
const notice = (ch: { ws: WebSocket }, sessionId: string, title: string, to?: string) =>
  ch.ws.send(JSON.stringify({ type: 'notify', sessionId, title, message: 'body', level: 'info', ...(to ? { to } : {}) }));

async function noticeSetup(port: number, id: string) {
  const ch = await open('/ws/channel', port);
  register(ch.ws, id);
  await settle();
  const dash = await open('/ws/dashboard', port);
  return { ch, dash, close: () => { dash.ws.close(); ch.ws.close(); } };
}

const dashNotices = (dash: { inbox: any[] }) => dash.inbox.filter((m) => m.type === 'notification');

test('a notice addressed to the dashboard goes only to dashboards', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  try {
    const r = await noticeSetup(TG_PORT, 'route-dash');
    notice(r.ch, 'route-dash', 'Route dash', 'dashboard');
    await until(() => dashNotices(r.dash).find((m) => m.title === 'Route dash'));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(tg.sent.filter((text) => text.includes('Route dash')), []);
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

test('a notice addressed to Telegram goes only to the bot, and a reply to it reaches the session', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  try {
    const r = await noticeSetup(TG_PORT, 'route-tg');
    notice(r.ch, 'route-tg', 'Route tg', 'telegram');
    await until(() => tg.sent.find((text) => text.includes('[route-tg] Route tg')));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
    const messageId = 101 + tg.sent.findIndex((text) => text.includes('[route-tg] Route tg'));
    await (tg.hub as any).telegramBot.handleIncomingMessage({ message_id: 900, chat: { id: 111 }, text: 'and then?', reply_to_message: { message_id: messageId } });
    const got = await until(() => r.ch.inbox.find((m) => m.type === 'message_to_session'));
    assert.equal(got.content, 'and then?');
    assert.equal(got.source, 'telegram');
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

test('a notice addressed to the API sender is only logged', async (t) => {
  const tg = await telegramHub(t);
  const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
  const info = t.mock.method(logger, 'info');
  try {
    const r = await noticeSetup(TG_PORT, 'route-api');
    notice(r.ch, 'route-api', 'Route api', 'api');
    await until(() => info.mock.calls.find((c) => String(c.arguments[0]).includes('[route-api] Route api')));
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
    assert.deepEqual(tg.sent.filter((text) => text.includes('Route api')), []);
    r.close();
  } finally {
    await tg.hub.stop();
  }
});

for (const [name, to] of [['without an address', undefined], ['with an address this hub does not know', 'pager']] as const) {
  test(`a notice ${name} goes everywhere, as before`, async (t) => {
    const tg = await telegramHub(t);
    const notify = t.mock.method((tg.hub as any).notifier, 'notifyWithSession');
    try {
      const r = await noticeSetup(TG_PORT, 'route-all');
      notice(r.ch, 'route-all', 'Route all', to);
      await until(() => dashNotices(r.dash).find((m) => m.title === 'Route all'));
      await until(() => tg.sent.find((text) => text.includes('[route-all] Route all')));
      assert.equal(notify.mock.callCount(), 1);
      r.close();
    } finally {
      await tg.hub.stop();
    }
  });
}

test('a notice addressed to Telegram goes nowhere when no bot is set up', async (t) => {
  const notify = t.mock.method((hub as any).notifier, 'notifyWithSession');
  const r = await noticeSetup(PORT, 'route-nobot');
  try {
    notice(r.ch, 'route-nobot', 'Route nobot', 'telegram');
    await settle();
    await settle();
    assert.equal(notify.mock.callCount(), 0);
    assert.deepEqual(dashNotices(r.dash), []);
  } finally {
    r.close();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-adapter.test.ts test/hub-message-source.test.ts`
Expected: FAIL, 6 tests. In `codex-adapter.test.ts`: "the Queued notice is addressed…" (`to` is `undefined` three times) and "a Queued notice for a message from Telegram does not reach the dashboard" (one `Queued` notification arrives); the other two new tests pass. In `hub-message-source.test.ts`: "…to the dashboard goes only to dashboards", "…to Telegram goes only to the bot…" and "…goes nowhere when no bot is set up" (notifier called once, expected 0), and "…to the API sender is only logged" (`condition not met in time` after about 4 s); the two "goes everywhere, as before" tests pass.

- [ ] **Step 3: Implement**

1. In `src/shared/types.ts`, change the `notify` member of `ChannelMessage` to:

```ts
  | { type: 'notify'; sessionId: string; title: string; message: string; level?: NotifyLevel; to?: MessageSource }
```

2. In `src/codex/adapter.ts`, change the type import to:

```ts
import type { ChannelMessage, CodexCall, MessageSource, NotifyLevel, SessionInfo } from '../shared/types.js';
```

3. In `onHubMessage`, change the two enqueue calls to:

```ts
      this.enqueue(threadId, async () => textInput(msg.content, msg.source), msg.source);
```

```ts
      this.enqueue(threadId, () => imageInput(msg.imagePath, msg.mimeType, msg.content, msg.source), msg.source);
```

4. Change `enqueue`'s signature and its `deliver` call:

```ts
  private enqueue(threadId: string, build: () => Promise<UserInput[]>, source?: MessageSource): void {
    const t = this.threads.get(threadId);
    if (!t) return;
    t.sending = t.sending
      .then(() => this.deliver(t, build, source))
      .catch((err) => logger.warn(`Codex delivery for ${threadId} failed: ${(err as Error).message}`));
  }
```

5. Change `deliver`'s signature to:

```ts
  private async deliver(t: Tracked, build: () => Promise<UserInput[]>, source?: MessageSource): Promise<void> {
```

and its "Queued" line (inside `if (running) { … }`) to:

```ts
        this.notify(threadId, 'Queued', 'Queued: Codex will read it after its current step.', 'info', source);
```

Every other `notify` call in the adapter stays as it is.

6. Replace `notify`:

```ts
  private notify(threadId: string, title: string, message: string, level: NotifyLevel): void {
    this.threads.get(threadId)?.hub.send({ type: 'notify', sessionId: codexSessionId(threadId), title, message, level });
  }
```

with:

```ts
  private notify(threadId: string, title: string, message: string, level: NotifyLevel, to?: MessageSource): void {
    this.threads.get(threadId)?.hub.send({ type: 'notify', sessionId: codexSessionId(threadId), title, message, level, ...(to ? { to } : {}) });
  }
```

7. In `src/hub/server.ts`, `case 'notify'`, replace:

```ts
        const notifySession = this.sessions.get(msg.sessionId);
        const notifyLabel = this.getSessionLabel(notifySession);
        this.notifier.notifyWithSession(msg.sessionId, notifyLabel, `[${notifyLabel}] ${msg.title}`, msg.message, msg.level ?? 'info');
        this.broadcastToDashboards({
```

with:

```ts
        const notifySession = this.sessions.get(msg.sessionId);
        const notifyLabel = this.getSessionLabel(notifySession);
        const notifyTitle = `[${notifyLabel}] ${msg.title}`;
        if (msg.to === 'api') {
          logger.info(`${notifyTitle}: ${msg.message}`);
          break;
        }
        if (msg.to === 'telegram') {
          void this.telegramBot?.sendNotification(msg.sessionId, notifyLabel, notifyTitle, msg.message);
          break;
        }
        // A `to` this hub does not know comes from a newer adapter; sending it everywhere loses nothing.
        if (msg.to !== 'dashboard') this.notifier.notifyWithSession(msg.sessionId, notifyLabel, notifyTitle, msg.message, msg.level ?? 'info');
        this.broadcastToDashboards({
```

(the `broadcastToDashboards({ type: 'notification', … })` call and the `break;` after it stay unchanged). An older Hub ignores `to` and keeps sending everywhere.

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-adapter.test.ts test/hub-message-source.test.ts`
Expected: PASS, every test (`codex-adapter.test.ts` 60 tests in about 22 s).
Run: `npx tsc --noEmit` → exit 0.
Run: `npm test` → `# fail 0` (468 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/codex/adapter.ts src/hub/server.ts test/codex-adapter.test.ts test/hub-message-source.test.ts
git commit -m "fix(codex): send the Queued notice only where the message came from" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Restored approvals and the title flash

**Files:**
- Modify: `src/dashboard/index.html:1469-1491` (`case 'permission_request'`), `1503-1509` (`case 'permission_pending'`), the Permission relay block after `applyPendingChoices` (`2118-2129`), `2213-2231` (`flashTitle`)
- Test: `test/dashboard-restored-approvals.test.ts` (new, `node:vm`)

**Interfaces:**
- Consumes: the existing `applyPendingChoices(permissionRequests, pending)` (returns the pending requests the dashboard does not have).
- Produces (dashboard script, all inside the `// --- Permission relay ---` block, before `// Flash title for attention`): `addPermissionRequest(msg)` (adds to the permission bar state, auto-selects like before, no notification, no flash); `showPermissionRequest(msg)` (live request: add + one `Permission Request` row + `flashTitle('Permission Request')`); `restorePendingRequests(requests)` (adds every restored request; if any, one `warning` row titled `${n} approval request(s) waiting` and one `flashTitle` with that label; then re-renders the bar and the notifications). `flashTitle(msg)` with a module `let flash = null`.

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard-restored-approvals.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');

function section(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  assert.ok(start > 0 && end > start, `anchors not found: ${from.trim()}`);
  return html.slice(start, end);
}

// The dashboard is a single inline-script HTML file; evaluate the permission relay block in a sandbox.
function loadPermissions() {
  const flashes: string[] = [];
  const ctx: Record<string, any> = {
    state: { permissionRequests: {}, selectedSession: 'other', sessions: {}, notifications: [] },
    document: { addEventListener() {} },
    esc: (s: string) => String(s),
    renderMarkdown: (s: string) => s,
    renderMessages: () => {},
    renderNotifications: () => {},
    selectSession: () => {},
    flashTitle: (m: string) => flashes.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // --- Permission relay ---', '  // Flash title for attention'), ctx);
  ctx.renderPermissionBar = () => {};
  return { ctx, flashes };
}

const choices = [{ id: '0', label: 'Allow once' }];
const pending = (sessionId: string, requestId: string) =>
  ({ sessionId, requestId, toolName: 'Command', description: `Run ${requestId}?`, inputPreview: '{}', timestamp: 1, choices });

test('the dashboard restores pending approvals and shows live ones through the new helpers', () => {
  assert.match(html, /case 'permission_pending':\s*restorePendingRequests\(msg\.requests \|\| \[\]\);\s*break;/);
  assert.match(html, /case 'permission_request':\s*showPermissionRequest\(msg\);\s*break;/);
});

test('restored approvals all join the permission bar with one notification row and one flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([pending('codex:t1', 'r1'), pending('codex:t1', 'r2'), pending('codex:t2', 'r3')]);
  assert.deepEqual(Array.from(ctx.state.permissionRequests['codex:t1'], (r: any) => r.requestId), ['r2', 'r1']);
  assert.deepEqual(Array.from(ctx.state.permissionRequests['codex:t2'], (r: any) => r.requestId), ['r3']);
  assert.equal(ctx.state.notifications.length, 1);
  const [n] = ctx.state.notifications;
  assert.equal(n.title, '3 approval request(s) waiting');
  assert.equal(n.level, 'warning');
  assert.equal(n.sessionId, 'codex:t1');
  assert.deepEqual(flashes, ['3 approval request(s) waiting']);
});

test('a single restored approval is counted the same way', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([pending('codex:t1', 'r1')]);
  assert.equal(ctx.state.notifications[0].title, '1 approval request(s) waiting');
  assert.deepEqual(flashes, ['1 approval request(s) waiting']);
});

test('approvals the dashboard already shows add no row and no flash when restored again', () => {
  const { ctx, flashes } = loadPermissions();
  const list = [pending('codex:t1', 'r1'), pending('codex:t1', 'r2')];
  ctx.restorePendingRequests(list);
  ctx.restorePendingRequests(list);
  assert.equal(ctx.state.permissionRequests['codex:t1'].length, 2);
  assert.equal(ctx.state.notifications.length, 1);
  assert.equal(flashes.length, 1);
});

test('nothing to restore adds no row and no flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.restorePendingRequests([]);
  assert.deepEqual(ctx.state.notifications, []);
  assert.deepEqual(flashes, []);
});

test('each live approval still gets its own row and flash', () => {
  const { ctx, flashes } = loadPermissions();
  ctx.showPermissionRequest({ type: 'permission_request', ...pending('codex:t1', 'r1') });
  ctx.showPermissionRequest({ type: 'permission_request', ...pending('codex:t1', 'r2') });
  assert.deepEqual(ctx.state.notifications.map((n: any) => [n.title, n.permRequestId]), [['Permission Request', 'r2'], ['Permission Request', 'r1']]);
  assert.deepEqual(flashes, ['Permission Request', 'Permission Request']);
});

const TITLE = 'Claude Alarm - Dashboard';

function loadFlash() {
  const timers = new Map<number, { fn: () => void; repeat: boolean }>();
  const focus = new Set<() => void>();
  let next = 1;
  const ctx: Record<string, any> = {
    document: { title: TITLE },
    window: {
      addEventListener: (type: string, fn: () => void) => { if (type === 'focus') focus.add(fn); },
      removeEventListener: (type: string, fn: () => void) => { if (type === 'focus') focus.delete(fn); },
    },
    setInterval: (fn: () => void) => { timers.set(next, { fn, repeat: true }); return next++; },
    setTimeout: (fn: () => void) => { timers.set(next, { fn, repeat: false }); return next++; },
    clearInterval: (id: number) => { timers.delete(id); },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(section('  // Flash title for attention', '  // Clear all notifications'), ctx);
  const count = (repeat: boolean) => [...timers.values()].filter((t) => t.repeat === repeat).length;
  return {
    ctx,
    tick: () => { for (const t of [...timers.values()]) if (t.repeat) t.fn(); },
    expire: () => { for (const [id, t] of [...timers]) if (!t.repeat) { timers.delete(id); t.fn(); } },
    focusWindow: () => { for (const fn of [...focus]) fn(); },
    intervals: () => count(true),
    timeouts: () => count(false),
    focusHandlers: () => focus.size,
  };
}

test('a second flash while the title shows the flash text still ends on the real title', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  f.ctx.flashTitle('Permission Request');
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
});

test('a second flash while flashing changes only the message and keeps one focus handler and one timer', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  assert.equal(f.ctx.document.title, '** Permission Request **');
  f.ctx.flashTitle('2 approval request(s) waiting');
  assert.equal(f.focusHandlers(), 1);
  assert.equal(f.timeouts(), 1);
  assert.equal(f.intervals(), 1);
  f.tick();
  assert.equal(f.ctx.document.title, TITLE);
  f.tick();
  assert.equal(f.ctx.document.title, '** 2 approval request(s) waiting **');
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
  assert.equal(f.focusHandlers(), 0);
  assert.equal(f.intervals() + f.timeouts(), 0);
});

test('the 30-second stop puts the real title back', () => {
  const f = loadFlash();
  f.ctx.flashTitle('Permission Request');
  f.tick();
  f.expire();
  assert.equal(f.ctx.document.title, TITLE);
  assert.equal(f.focusHandlers(), 0);
  assert.equal(f.intervals() + f.timeouts(), 0);
});

test('a flash after the last one stopped starts again from the real title', () => {
  const f = loadFlash();
  f.ctx.flashTitle('A');
  f.tick();
  f.focusWindow();
  f.ctx.flashTitle('B');
  f.tick();
  assert.equal(f.ctx.document.title, '** B **');
  f.tick();
  assert.equal(f.ctx.document.title, TITLE);
  f.focusWindow();
  assert.equal(f.ctx.document.title, TITLE);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/dashboard-restored-approvals.test.ts`
Expected: FAIL, 8 of 10: the wiring test does not match; the five restore/live tests throw `ctx.restorePendingRequests is not a function` / `ctx.showPermissionRequest is not a function`; "a second flash while the title shows the flash text…" ends on `'** Permission Request **'`; "a second flash while flashing…" sees 2 focus handlers. "the 30-second stop…" and "a flash after the last one stopped…" pass already.

- [ ] **Step 3: Implement** (in `src/dashboard/index.html`)

1. In `handleMessage`, replace the whole `case 'permission_request':` branch (from `case 'permission_request':` through its `flashTitle('Permission Request');` and `break;`) with:

```js
      case 'permission_request':
        showPermissionRequest(msg);
        break;
```

2. Replace:

```js
      case 'permission_pending':
        for (const m of applyPendingChoices(state.permissionRequests, msg.requests || [])) {
          handleMessage({ type: 'permission_request', ...m });
        }
        renderPermissionBar();
        renderNotifications();
        break;
```

with:

```js
      case 'permission_pending':
        restorePendingRequests(msg.requests || []);
        break;
```

3. Add directly after the `applyPendingChoices` function (before `function sendPermissionChoice`):

```js
  function addPermissionRequest(msg) {
    if (!state.permissionRequests[msg.sessionId]) state.permissionRequests[msg.sessionId] = [];
    state.permissionRequests[msg.sessionId].unshift({
      requestId: msg.requestId,
      toolName: msg.toolName,
      description: msg.description,
      inputPreview: msg.inputPreview,
      timestamp: msg.timestamp,
      resolved: false,
      behavior: null,
      choices: msg.choices || null,
      sent: null,
      outcome: null,
    });
    if (!state.selectedSession && state.sessions[msg.sessionId]) selectSession(msg.sessionId);
    if (state.selectedSession === msg.sessionId) { renderMessages(); renderPermissionBar(); }
  }

  function showPermissionRequest(msg) {
    addPermissionRequest(msg);
    state.notifications.unshift({ sessionId: msg.sessionId, title: 'Permission Request', message: `${msg.toolName}: ${msg.description}`, level: 'warning', time: msg.timestamp, permRequestId: msg.requestId });
    renderNotifications();
    flashTitle('Permission Request');
  }

  // A reconnect can bring back many requests at once; one row and one flash keep them from burying the notifications.
  function restorePendingRequests(requests) {
    const restored = applyPendingChoices(state.permissionRequests, requests);
    for (const m of restored) addPermissionRequest(m);
    if (restored.length) {
      const label = `${restored.length} approval request(s) waiting`;
      state.notifications.unshift({ sessionId: restored[0].sessionId, title: label, message: restored.map(m => `${m.toolName}: ${m.description}`).join('\n'), level: 'warning', time: Date.now() });
      flashTitle(label);
    }
    renderPermissionBar();
    renderNotifications();
  }
```

4. Replace the flash code after `  // Flash title for attention` (keep that comment line, the tests use it as an anchor):

```js
  let flashInterval = null;
  function flashTitle(msg) {
    const original = document.title;
    let on = true;
    clearInterval(flashInterval);
    flashInterval = setInterval(() => {
      document.title = on ? `** ${msg} **` : original;
      on = !on;
    }, 500);
    const stopFlash = () => {
      clearInterval(flashInterval);
      flashInterval = null;
      document.title = original;
      window.removeEventListener('focus', stopFlash);
    };
    window.addEventListener('focus', stopFlash);
    setTimeout(stopFlash, 30000);
  }
```

with:

```js
  let flash = null;
  function flashTitle(msg) {
    // While flashing, document.title may hold the flash text, so only a flash that starts from rest reads the real title.
    if (flash) {
      flash.msg = msg;
      return;
    }
    const current = { msg, original: document.title, on: true, interval: null, timeout: null };
    const stop = () => {
      clearInterval(current.interval);
      clearTimeout(current.timeout);
      window.removeEventListener('focus', stop);
      document.title = current.original;
      flash = null;
    };
    current.interval = setInterval(() => {
      document.title = current.on ? `** ${current.msg} **` : current.original;
      current.on = !current.on;
    }, 500);
    current.timeout = setTimeout(stop, 30000);
    window.addEventListener('focus', stop);
    flash = current;
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/dashboard-restored-approvals.test.ts test/dashboard-permissions.test.ts`
Expected: PASS, 20 of 20.
Run: `npm test` → `# fail 0` (478 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html test/dashboard-restored-approvals.test.ts
git commit -m "fix(dashboard): one notice for restored approvals, and a title flash that ends on the real title" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Closing the proxy ends its whole process tree

**Files:**
- Modify: `src/codex/transport.ts:1` (import), `src/codex/transport.ts:63-92` (new kill-tree code before `HANDSHAKE_TIMEOUT_MS`, `connectProxy` signature, `close`)
- Modify: `test/fixtures/fake-codex-proxy.mjs` (opt-in `FAKE_CODEX_PID_FILE` and `FAKE_CODEX_LINGER`)
- Test: `test/codex-proxy-close.test.ts` (new, injected kill function, fake children), `test/codex-transport.test.ts` (two Windows-only tests with a fake `codex.cmd`; append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type KillTreeFn = (child: ChildProcess) => void`
  - `export type RunFn = (file: string, args: string[], options: { windowsHide: boolean }, callback: (err: Error | null) => void) => void`
  - `export function treeKiller(platform: NodeJS.Platform = process.platform, run: RunFn = runFile): KillTreeFn`: does nothing if the child has exited (`exitCode`/`signalCode` set); on `win32` with a PID runs `taskkill /PID <pid> /T /F` with `{ windowsHide: true }` and only logs a failure (`logger.debug`); otherwise `child.kill()`.
  - `export const killTree: KillTreeFn = treeKiller()`
  - `connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn, timeoutMs = HANDSHAKE_TIMEOUT_MS, killTreeFn: KillTreeFn = killTree): Promise<ProxyConnection>`: `close()` (also used on handshake failure) now does `ws.terminate()`, `child.stdin?.end()`, `killTreeFn(child)`. Callers (`adapter.ts:109`, `run.ts:93`) are unchanged.
  - Fixture: `FAKE_CODEX_PID_FILE=<path>` makes `fake-codex-proxy.mjs` write its PID there; `FAKE_CODEX_LINGER=1` makes it ignore stdin EOF and the daemon closing, and exit by itself after 60 s.

- [ ] **Step 1: Write the failing tests**

Replace `test/fixtures/fake-codex-proxy.mjs` with:

```js
import fs from 'node:fs';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';

if (process.env.FAKE_CODEX_PID_FILE) fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
// FAKE_CODEX_LINGER=1 plays a proxy that outlives its stdin and its daemon, so only a tree kill ends it; it still exits after a minute.
const linger = process.env.FAKE_CODEX_LINGER === '1';
if (linger) setTimeout(() => process.exit(0), 60_000);
const exit = (code) => {
  if (!linger) process.exit(code);
};

const control = new WebSocket(process.env.FAKE_CODEX_CONTROL);
const socket = new Duplex({
  read() {},
  write(chunk, _encoding, callback) { process.stdout.write(chunk, callback); },
  final(callback) { callback(); },
});
Object.assign(socket, {
  setTimeout() { return socket; },
  setNoDelay() { return socket; },
  setKeepAlive() { return socket; },
  ref() {},
  unref() {},
  remoteAddress: '127.0.0.1',
});
process.stdin.on('data', (d) => socket.push(d));
process.stdin.on('end', () => exit(0));

const wss = new WebSocketServer({ noServer: true });
const server = http.createServer();
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.on('message', (d) => control.send(String(d)));
    control.on('message', (d) => ws.send(String(d)));
  });
});
control.on('open', () => server.emit('connection', socket));
control.on('close', () => exit(0));
control.on('error', () => exit(1));
```

Create `test/codex-proxy-close.test.ts`:

```ts
import './isolate-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectProxy, treeKiller, type RunFn, type SpawnFn } from '../src/codex/transport.js';
import { logger } from '../src/shared/logger.js';
import { FakeDaemon, until } from './helpers/fake-codex-daemon.js';

interface FakeChild { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kills: number; kill(): boolean }

function fakeChild(state: Partial<Pick<FakeChild, 'pid' | 'exitCode' | 'signalCode'>> = {}): FakeChild {
  const child: FakeChild = { pid: 4242, exitCode: null, signalCode: null, kills: 0, kill: () => { child.kills++; return true; }, ...state };
  return child;
}

function recorder(fail?: Error) {
  const runs: Array<{ file: string; args: string[]; options: { windowsHide: boolean } }> = [];
  const run: RunFn = (file, args, options, callback) => {
    runs.push({ file, args, options });
    callback(fail ?? null);
  };
  return { runs, run };
}

const asChild = (c: FakeChild) => c as unknown as ChildProcess;

test('on Windows the tree under the spawned pid is ended with a hidden taskkill', () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  treeKiller('win32', run)(asChild(child));
  assert.deepEqual(runs, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'], options: { windowsHide: true } }]);
  assert.equal(child.kills, 0);
});

test('elsewhere the proxy is ended with child.kill()', () => {
  const { runs, run } = recorder();
  const child = fakeChild();
  treeKiller('linux', run)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a proxy that has already exited is left alone, since its pid may now belong to another process', () => {
  const { runs, run } = recorder();
  for (const state of [{ exitCode: 0 }, { signalCode: 'SIGTERM' as const }]) {
    const child = fakeChild(state);
    treeKiller('win32', run)(asChild(child));
    treeKiller('linux', run)(asChild(child));
    assert.equal(child.kills, 0);
  }
  assert.deepEqual(runs, []);
});

test('a proxy that never got a pid is ended with child.kill() even on Windows', () => {
  const { runs, run } = recorder();
  const child = fakeChild({ pid: undefined });
  treeKiller('win32', run)(asChild(child));
  assert.deepEqual(runs, []);
  assert.equal(child.kills, 1);
});

test('a failed taskkill is only logged', (t) => {
  const debug = t.mock.method(logger, 'debug');
  const { run } = recorder(new Error('The process "4242" not found.'));
  assert.doesNotThrow(() => treeKiller('win32', run)(asChild(fakeChild())));
  assert.equal(debug.mock.calls.some((c) => String(c.arguments[0]).includes('4242')), true);
});

test('closing a connection ends the proxy stdin first, then its process tree', async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = (command, args) => (spawned = daemon.spawnFn(command, args));
  const killed: Array<{ child: ChildProcess; stdinEnded: boolean }> = [];
  try {
    const conn = await connectProxy('codex', spawnFn, 5000, (child) => {
      killed.push({ child, stdinEnded: child.stdin?.writableEnded === true });
      child.kill();
    });
    conn.close();
    assert.equal(killed.length, 1);
    assert.equal(killed[0].child, spawned);
    assert.equal(killed[0].stdinEnded, true);
  } finally {
    await daemon.stop();
  }
});

test('a handshake timeout ends the proxy tree through the same function', async () => {
  let spawned: ChildProcess | undefined;
  const spawnFn: SpawnFn = () => (spawned = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], { stdio: 'pipe' }));
  const killed: ChildProcess[] = [];
  await assert.rejects(
    connectProxy('codex', spawnFn, 300, (child) => {
      killed.push(child);
      child.kill();
    }),
    /^Error: codex daemon did not answer within 0.3s$/,
  );
  assert.equal(killed.length, 1);
  assert.equal(killed[0], spawned);
  await until(() => spawned!.exitCode !== null || spawned!.signalCode !== null);
});
```

In `test/codex-transport.test.ts`, add directly after `import path from 'node:path';`:

```ts
import { fileURLToPath } from 'node:url';
```

and append at the end of the file. The fake `codex.cmd` runs a Node proxy under `cmd.exe` the way the npm shim does; each test finds the proxy only by the PID it wrote and stops only that PID and its own `ChildProcess` handle:

```ts
const FAKE_PROXY = fileURLToPath(new URL('./fixtures/fake-codex-proxy.mjs', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | undefined {
  try {
    return Number(fs.readFileSync(file, 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}

function fakeCodexCmd(script: string, env: Record<string, string> = {}): { cmd: string; pidFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tree-'));
  const pidFile = path.join(dir, 'proxy.pid');
  const sets = Object.entries({ ...env, FAKE_CODEX_PID_FILE: pidFile }).map(([k, v]) => `set "${k}=${v}"`);
  const cmd = path.join(dir, 'codex.cmd');
  fs.writeFileSync(cmd, ['@echo off', ...sets, `"${process.execPath}" "${script}" %*`, ''].join('\r\n'));
  return { cmd, pidFile };
}

function silentProxy(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-silent-')), 'silent-proxy.mjs');
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));',
    'process.stdin.resume();',
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  return file;
}

// Only what this test started, by the pid the proxy wrote and by our own handle; never by image name.
function stopLeftovers(proxy: { pid?: number }, shell: ChildProcess | undefined): void {
  if (proxy.pid !== undefined && alive(proxy.pid)) process.kill(proxy.pid);
  if (shell && shell.exitCode === null && shell.signalCode === null) shell.kill();
}

test('a codex.cmd proxy that never answers is ended with its shell at the handshake timeout', { skip: process.platform !== 'win32' }, async () => {
  const { cmd, pidFile } = fakeCodexCmd(silentProxy());
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number } = {};
  try {
    const pending = connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 5000);
    pending.catch(() => {});
    proxy.pid = await until(() => readPid(pidFile), 5000);
    assert.notEqual(proxy.pid, shell!.pid);
    assert.equal(alive(proxy.pid), true);
    await assert.rejects(pending, /^Error: codex daemon did not answer within 5s$/);
    await until(() => !alive(proxy.pid!), 5000);
    // Seen gone: Windows may reuse the pid, so the cleanup must not touch it any more.
    proxy.pid = undefined;
  } finally {
    stopLeftovers(proxy, shell);
  }
});

test('closing a connection to a codex.cmd proxy also ends the proxy under the shell', { skip: process.platform !== 'win32' }, async () => {
  const daemon = new FakeDaemon();
  await daemon.start();
  const { cmd, pidFile } = fakeCodexCmd(FAKE_PROXY, { FAKE_CODEX_CONTROL: daemon.url, FAKE_CODEX_LINGER: '1' });
  let shell: ChildProcess | undefined;
  const proxy: { pid?: number } = {};
  try {
    const conn = await connectProxy(cmd, (command, args) => (shell = defaultSpawn(command, args)), 10_000);
    proxy.pid = await until(() => readPid(pidFile), 5000);
    assert.equal(alive(proxy.pid), true);
    conn.close();
    await until(() => !alive(proxy.pid!), 5000);
    // Seen gone: Windows may reuse the pid, so the cleanup must not touch it any more.
    proxy.pid = undefined;
    await until(() => shell!.exitCode !== null || shell!.signalCode !== null, 5000);
  } finally {
    stopLeftovers(proxy, shell);
    await daemon.stop();
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-proxy-close.test.ts test/codex-transport.test.ts`
Expected: FAIL. `codex-proxy-close.test.ts` does not load: `SyntaxError: The requested module '../src/codex/transport.js' does not provide an export named 'treeKiller'`. On Windows the two new `codex-transport.test.ts` tests fail with `condition not met in time` (the proxy outlives its shell; about 16 s for the file, under the 30 s limit); on other platforms they are skipped. The 15 existing transport tests pass.
Then, on Windows, confirm nothing was left behind with this read-only listing, run in PowerShell (not bash, which would expand `$_`):

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'silent-proxy\.mjs|fake-codex-proxy\.mjs' } | Select-Object ProcessId, CommandLine
```

Expected: no output. If it lists anything, it came from these tests; stop exactly those PIDs (`Stop-Process -Id <pid>`), nothing else.

- [ ] **Step 3: Implement** (in `src/codex/transport.ts`)

1. Change the first import to:

```ts
import { execFile, spawn, type ChildProcess } from 'node:child_process';
```

2. Replace:

```ts
// The daemon control socket speaks WebSocket, not JSONL: `codex app-server proxy` only relays bytes.
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export function connectProxy(command: string, spawnFn: SpawnFn = defaultSpawn, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<ProxyConnection> {
```

with:

```ts
export type KillTreeFn = (child: ChildProcess) => void;
export type RunFn = (file: string, args: string[], options: { windowsHide: boolean }, callback: (err: Error | null) => void) => void;

const runFile: RunFn = (file, args, options, callback) => {
  execFile(file, args, options, (err) => callback(err));
};

export function treeKiller(platform: NodeJS.Platform = process.platform, run: RunFn = runFile): KillTreeFn {
  return (child) => {
    // Once the proxy has exited, Windows may give its pid to an unrelated process.
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (platform !== 'win32' || child.pid === undefined) {
      child.kill();
      return;
    }
    // An npm codex.cmd runs the proxy under cmd.exe, and child.kill() would end only cmd.exe.
    run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) logger.debug(`taskkill ${child.pid} failed: ${err.message}`);
    });
  };
}

export const killTree: KillTreeFn = treeKiller();

// The daemon control socket speaks WebSocket, not JSONL: `codex app-server proxy` only relays bytes.
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export function connectProxy(
  command: string,
  spawnFn: SpawnFn = defaultSpawn,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  killTreeFn: KillTreeFn = killTree,
): Promise<ProxyConnection> {
```

3. Replace `close` inside `connectProxy`:

```ts
  const close = () => {
    ws.terminate();
    child.kill();
  };
```

with:

```ts
  const close = () => {
    ws.terminate();
    child.stdin?.end();
    killTreeFn(child);
  };
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=30000 test/codex-proxy-close.test.ts test/codex-transport.test.ts test/codex-adapter.test.ts`
Expected: PASS, every test (on Windows the two `codex.cmd` tests take about 5.2 s and 0.3 s).
Run the leftover check from Step 2 again → no output.
Run: `npx tsc --noEmit` → exit 0.
Run: `npm test` → `# fail 0` (487 tests; the two `codex.cmd` tests are skipped outside Windows).

- [ ] **Step 5: Commit**

```bash
git add src/codex/transport.ts test/fixtures/fake-codex-proxy.mjs test/codex-proxy-close.test.ts test/codex-transport.test.ts
git commit -m "fix(codex): end the whole proxy tree on close, so an npm codex.cmd leaves no proxy behind" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
