/**
 * Generic poll utility used by every scenario. Always prefer this over
 * bare setTimeout — it gives us a consistent timeout error with a label
 * and ensures we never sleep past the deadline.
 */

export interface PollOpts {
  timeoutMs: number;
  intervalMs: number;
  label: string;
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined>,
  opts: PollOpts,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null && v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(opts.intervalMs, remaining)));
  }
  const detail = lastErr ? ` (last error: ${(lastErr as Error).message})` : '';
  throw new Error(
    `pollUntil timeout after ${opts.timeoutMs}ms: ${opts.label}${detail}`,
  );
}
