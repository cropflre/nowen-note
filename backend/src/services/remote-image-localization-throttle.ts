// Shared across localization jobs so multiple users cannot burst the same host.
const hosts = new Map<string, { nextRequestAt: number; limitedCount: number }>();
const REQUEST_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export async function waitForImageHost(hostname: string, cancelled: () => boolean): Promise<void> {
  while (true) {
    if (cancelled()) throw new Error("Image localization stopped");
    const now = Date.now();
    const host = hosts.get(hostname);
    const delay = (host?.nextRequestAt ?? 0) - now;
    if (delay <= 0) {
      // Discard expired hosts, keeping the shared limiter bounded across jobs.
      for (const [key, state] of hosts) {
        if (state.nextRequestAt <= now) hosts.delete(key);
      }
      hosts.set(hostname, { nextRequestAt: now + REQUEST_INTERVAL_MS, limitedCount: host?.limitedCount ?? 0 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 250)));
  }
}

export function deferImageHost(hostname: string, retryAfterMs?: number): void {
  const host = hosts.get(hostname);
  const limitedCount = Math.min((host?.limitedCount ?? 0) + 1, 5);
  const delay = Math.max(Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (limitedCount - 1)), retryAfterMs ?? 0);
  hosts.set(hostname, { nextRequestAt: Date.now() + delay, limitedCount });
}
