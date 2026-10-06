# Proxy Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Closing an npm `codex.cmd` proxy never sends a termination to a process that is not one we recorded, even when a wrapper exits on its own and Windows reuses its PID, and every shutdown path gives that close the time it needs while still ending within a stated bound.

**Architecture:** Not fixed by this plan. Each task states the problem, the facts, the required behavior and the tests; the implementer chooses the mechanism and explains it in the report.

**Tech Stack:** TypeScript (ESM, Node 22), Node built-ins (`child_process`, `fs`), `node:test` + `tsx`. Windows is the primary platform.

**Spec:** docs/superpowers/specs/2026-10-06-proxy-shutdown-design.md

## Global Constraints

- Work only inside your worktree, on the branch checked out there; do not switch branches. No new dependencies.
- Comments: none, except a one-line English comment for a non-obvious "why" (a counter-intuitive decision, an external constraint, a trap). No restating code, no change-history comments, no section dividers, no empty JSDoc. Keep the existing "why" comments that still hold; drop or rewrite those your change makes untrue.
- Tests: every new test file starts with `import './isolate-home.js';` (it must stay the first import). Hub ports 7980–7982 and 7989–7998 are taken by existing tests; this plan should need no new hub.
- Never kill processes by image name (`node.exe`, `codex.exe`, `cmd.exe`, `powershell.exe`, …). A test stops only processes it started, by its `ChildProcess` handle or the PID it recorded, in a `finally`. Never start the real `codex`, never run a hub on port 7900, no network commands. Nothing may reach a real Telegram bot.
- Commands. One file: `node --import tsx --import ./test/isolate-home.ts --test --test-timeout=60000 test/<file>.test.ts`. All tests: `npm test` (514 tests before this plan, about 27 s). Type check: `npx tsc --noEmit` (covers `src/` only, not tests).
- `--test-timeout` applies to each test file as a whole. `test/codex-adapter.test.ts` already takes about 22 s, so add only fast tests to it.
- In tests, do not use a bare `assert.ok(expr)` for a condition that can fail (Node re-reads the transpiled file to quote it and can stall until the file timeout). Use `assert.equal(expr, true)`, `assert.deepEqual`, or give `assert.ok` a message.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Everything must still run on POSIX; Windows-only tests are skipped there (`{ skip: process.platform !== 'win32' }`).

### Task 1: Closing a codex.cmd proxy ends only processes recorded as ours

**Problem.** When the proxy tree is closed, `treeKiller` in `src/codex/transport.ts` takes one process snapshot and then ends the descendants one PID at a time with `taskkill /PID <pid> /F`, deepest first. Ending a child often makes its wrapper parent (like npm's `codex.js`) exit on its own, so a later `taskkill` goes to a PID that is already empty. If Windows has given that PID to a new process in the meantime, an unrelated process is killed. The path for a shell that has already exited has the same shape: one verification snapshot, then a series of kills.

**Facts.**
- For a child started through a shell (Windows, npm `codex.cmd`), `treeKiller` snapshots processes with PowerShell `Get-CimInstance Win32_Process` (PID, parent PID, creation time; `execFile` timeout 5 s). Descendants are found by parent PID, and a process older than its supposed parent is not counted as its child.
- With the shell alive, it ends the descendants and then the shell with `child.kill()`. With the shell already gone, it uses the descendants recorded earlier (`track`, called at spawn and again after the handshake) and ends only those whose PID and creation time still match a fresh snapshot.
- Node holds the shell's process handle until it sees the shell exit, so the shell's PID cannot be reused while `child.exitCode === null`. Node holds no handle to the other descendants.
- `/T` is not used on purpose: `taskkill /T` builds the tree from ParentProcessId alone, so it would also end older, unrelated processes that name a reused PID as their parent.
- The real npm tree is `cmd.exe` → `node.exe` (`codex.js`) → `codex.exe`; `codex.js` exits on its own when `codex.exe` ends. The existing real-process tests use a two-level fake (`cmd.exe` → one Node process).
- On this PC the first reuse of a freed PID was seen after 6.6 s (2026-10-05). That is an observation, not a guaranteed margin.
- `close()` returns a Promise that settles after the kill; the adapter's shutdown and `codex run` wait for it.

**Required behavior.**
1. Safety: a termination reaches only a process recorded as ours (same PID and same creation time). This holds even when a recorded process exits on its own during the close and its PID is given to a new process at any moment, including between any check and the termination.
2. Completeness: when `close()` settles, none of our processes that were alive when the close began is still running. Cases: a normal close; a close after the shell has already exited; the handshake timeout; a shell that exits before the handshake.
3. When our processes cannot be identified (the snapshot fails or times out): end only what can still be proven ours (the shell, through Node's handle), log at debug level, and settle. Leaving a descendant running is acceptable then; ending a process that is not proven ours is not.
4. Unchanged elsewhere: a `codex.exe` started without a shell, a child without a PID, and non-Windows platforms keep `child.kill()` only, with no process queries.
5. `close()` settles only after the kill has finished, and calling it twice ends the tree once. A failed termination of a process that is already gone is logged at debug level only.
6. No `/T`; never by image name.
7. The close does not hang.

**Tests (TDD: watch each new test fail for the expected reason before implementing).**
- Unit tests with injected fakes that reproduce at least: (a) a wrapper that exits on its own once its child is ended, after which its PID is given to a new process; (b) a recorded descendant whose PID is given to a new process after the shell has exited, before the close.
- A real Windows test with a fake `codex.cmd` whose middle process exits when its child ends (like npm `codex.js`): after the close all our PIDs are gone, and an unrelated process the test started is still alive.
- Change existing tests only where they pin behavior this task changes on purpose; name each such change and why in your report.

**Report, in addition to the usual.**
- The approach you chose and why.
- Whether any window remains in which a reused PID could be ended; if so, how large it is and why it cannot be closed.
- How long a normal close of a three-level fake `codex.cmd` tree (shell → wrapper → proxy) takes on this PC, before and after your change (median of 5 runs), and how you measured it. Task 2 sets its limits from this number.

**Commit subject:** `fix(codex): closing a codex.cmd proxy ends only processes still proven ours`

### Task 2: Shutdown limits that let the proxy kill finish

**Problem.** Shutdown waits are 3 s in two places. If the proxy kill (snapshot included) takes longer than 3 s, the adapter exits first and a `codex.cmd` proxy is left running. The snapshot's own timeout is 5 s, so nothing guarantees the kill fits in 3 s.

**Facts.**
- Adapter, `src/codex/main.ts`: on a signal (SIGINT, SIGTERM), on stdin end when the hub started it (`--watch-stdin`), or on `claude-alarm codex stop` (the control connection's `onStop`), `shutdown()` waits for `adapter.stop()` (which closes the daemon connection, proxy kill included) and for the instance lock's release, and exits; it exits after 3 s at the latest (`setTimeout(exit, 3000)`) even if they have not finished. A `codex.cmd` proxy runs outside the job object that ends this process's children when it exits, so exiting before the kill finishes leaves the proxy running.
- Hub, `src/hub/codex-supervisor.ts`: `stop()` ends the adapter's stdin and calls `child.kill()` if the adapter has not exited after `stopGraceMs` (3000). `HubServer.stop()` calls `supervisor.stop()` and settles once its HTTP server has closed (or after 3 s); the `hub start` shutdown handler then calls `process.exit(0)`. The adapter is spawned detached and can outlive the hub process.
- `claude-alarm codex run`, `src/codex/run.ts`: `await conn.close()` in a `finally`, with no limit of its own.
- A real adapter shutdown took 1.8 s (2026-10-05, this PC, which starts `codex.exe` directly — no snapshot on that path).
- Task 1 changed how the kill works and how long it takes; the controller gives you Task 1's approach and measured close time.

**Required behavior.**
1. In every adapter shutdown path (signal, stdin end, `codex stop`), the proxy kill finishes before the process exits, even in the worst case the code allows (a snapshot that runs into its own timeout included).
2. A shutdown that is stuck still ends within a bound the code states; nothing waits forever.
3. An outer limit that waits on an inner one is longer than the inner one (for example, the hub's wait before force-killing the adapter versus the adapter's own limit), so the outer limit never cuts the inner work short.
4. `codex run` ends within a stated time after its turn has finished, proxy kill included.

**Tests (TDD).**
- Unit tests with an injected slow kill (longer than the old 3 s) showing that each shutdown path waits for it, and that a kill that never finishes still ends at the stated bound.
- Tests that pin the relation between the outer and inner limits, so a later change to one cannot silently break it.

**Report, in addition to the usual.**
- For each path (signal, stdin end, `codex stop`, hub stop, `codex run`): the worst-case time to exit and how you derived it.

**Commit subject:** `fix(codex): shutdown waits long enough for the proxy kill and still ends within a stated bound`
