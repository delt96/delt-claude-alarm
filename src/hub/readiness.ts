export type HubStartup = 'ready' | 'exited' | 'timeout';

export const HUB_START_TIMEOUT_MS = 5000;

export interface WaitForHubOptions {
  url: string;
  token?: string;
  pid: number;
  isAlive: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

export async function waitForHub(opts: WaitForHubOptions): Promise<HubStartup> {
  const timeoutMs = opts.timeoutMs ?? HUB_START_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  for (;;) {
    if (!opts.isAlive()) return 'exited';
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    try {
      const res = await fetch(opts.url, { headers, signal: AbortSignal.timeout(Math.min(remaining, 1000)) });
      if (res.ok) {
        const body = await res.json() as { pid?: unknown };
        if (body.pid === opts.pid) return 'ready';
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}
