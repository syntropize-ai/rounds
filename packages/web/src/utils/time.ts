const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Compact magnitude for a duration of at least one minute: "32m", "3h",
 * "9d", "3mo", "3y". Sub-minute durations are the caller's business — the
 * past/future formatters below word them differently.
 */
function magnitude(ms: number): string {
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  if (ms < MONTH_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms < YEAR_MS) return `${Math.floor(ms / MONTH_MS)}mo`;
  return `${Math.floor(ms / YEAR_MS)}y`;
}

/**
 * Format a past ISO timestamp as a human-readable relative time string
 * ("just now", "32m ago", "3h ago", "9d ago", "3mo ago", "3y ago").
 *
 * Timestamps that have not been reached yet collapse to "just now" — for a
 * deadline you want `expiryLabel`, which looks forwards.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < MINUTE_MS) return 'just now';
  return `${magnitude(elapsed)} ago`;
}

/**
 * Same wording as `relativeTime` but from an already-computed elapsed
 * duration and with second-level precision ("5s ago"), for the indicators
 * that re-render once a second while data goes stale.
 */
export function relativeTimeFromElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) return 'just now';
  if (elapsedMs < MINUTE_MS) return `${Math.floor(elapsedMs / 1000)}s ago`;
  return `${magnitude(elapsedMs)} ago`;
}

/**
 * Label a deadline relative to now: "expires in 32m" while it is still
 * ahead, "expired 5m ago" once it has passed.
 *
 * Rendering an expiry with `relativeTime` is always wrong: it only measures
 * backwards, so a deadline 32 minutes away read "just now" and half an hour
 * later — still 2 minutes before expiry — read "32m ago".
 */
export function expiryLabel(iso: string, now: number = Date.now()): string {
  const remaining = new Date(iso).getTime() - now;
  if (remaining <= 0) return `expired ${relativeTime(iso, now)}`;
  if (remaining < MINUTE_MS) return 'expires in <1m';
  return `expires in ${magnitude(remaining)}`;
}
