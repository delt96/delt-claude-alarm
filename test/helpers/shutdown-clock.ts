import type { TestContext } from 'node:test';

export const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

export function shutdownClock(t: TestContext) {
  let now = 0;
  const timers = new Map<object, { at: number; run: () => void }>();
  t.mock.method(globalThis, 'setTimeout', (run: () => void, delay = 0) => {
    const handle = { unref() { return handle; } };
    timers.set(handle, { at: now + delay, run });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle: object) => { timers.delete(handle); });
  return {
    pending: () => timers.size,
    async tick(ms: number) {
      await flush();
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}
