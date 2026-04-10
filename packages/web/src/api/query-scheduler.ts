/**
 * QueryScheduler - Grafana-style frontend request queue.
 *
 * 1. Result cache with TTL: returns cached data on mount without making a request
 * 2. Concurrency limit: max N requests in-flight (default 6)
 * 3. Request deduplication: identical queries in-flight share the same response
 * 4. FIFO queue: excess requests wait until a slot opens
 * 5. Staggered initial load: panels registered within the first 200 ms are
 *    spread across a configurable window so they don't all fire at once.
 *    This prevents 30-60 panels from hitting the API simultaneously on mount
 *    and triggering the server-side rate limiter.
 */

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
}

type QueueItem<T> = {
  key: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class QueryScheduler {
  private maxConcurrent: number;
  private activeCount = 0;
  private queue: QueueItem<unknown>[] = [];
  private inflight = new Map<string, Promise<unknown>>();
  private cache = new Map<string, CacheEntry>();

  /**
   * Stagger window: all schedule() calls that arrive within
   * `staggerWindowMs` of the first call in a burst are spread
   * across `staggerSpreadMs`. Subsequent calls (e.g. from refresh
   * intervals) are NOT staggered - they go straight into the queue.
   */
  private staggerWindowMs: number;
  private staggerSpreadMs: number;
  private burstStartTime: number | null = null;
  private burstCount = 0;
  private staggerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(maxConcurrent = 6, staggerWindowMs = 200, staggerSpreadMs = 2000) {
    this.maxConcurrent = maxConcurrent;
    this.staggerWindowMs = staggerWindowMs;
    this.staggerSpreadMs = staggerSpreadMs;
  }

  /**
   * Get cached result if it exists and is within maxAge (ms).
   * Returns undefined if no cache or expired.
   */
  getCached<T>(key: string, maxAgeMs: number): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > maxAgeMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  /**
   * Schedule a request with concurrency control + dedup + staggering.
   * Results are cached automatically.
   *
   * Calls that arrive within `staggerWindowMs` of the first call in a burst
   * are treated as an initial page-load burst and are spread across
   * `staggerSpreadMs` to avoid overwhelming the API gateway rate limiter.
   */
  schedule<T>(key: string, execute: () => Promise<T>): Promise<T> {
    // Dedup: if same query is already in-flight, piggyback on it
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const now = Date.now();
    const isBurst =
      this.burstStartTime === null || now - this.burstStartTime < this.staggerWindowMs;

    if (isBurst) {
      // Start (or extend) the burst window
      if (this.burstStartTime === null) {
        this.burstStartTime = now;
        // Reset burst tracking after the stagger window closes
        this.staggerTimer = setTimeout(() => {
          this.burstStartTime = null;
          this.burstCount = 0;
          this.staggerTimer = null;
        }, this.staggerWindowMs);
      }

      const slot = this.burstCount++;
      // Spread slots evenly: each slot is staggerSpreadMs / maxExpectedPanels apart.
      // Using 50 ms per slot means 30 panels finish within 1.5 s and 60 panels within 3 s,
      // well within the 600 req/min budget on the API gateway.
      const slotsPerSec = Math.floor(this.staggerSpreadMs / 50);
      const delay = slot * (slotsPerSec > 0 ? this.staggerSpreadMs / 60 : 0); // ~33 ms at default 2000 ms spread

      const promise = new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          this._enqueue({ key, execute, resolve, reject } as QueueItem<unknown>);
        }, delay);
      });

      this.inflight.set(key, promise);
      promise
        .then((result) => {
          this.cache.set(key, { data: result, timestamp: Date.now() });
        })
        .catch((err) => { console.warn('[query-scheduler] scheduled query failed', err); })
        .finally(() => {
          this.inflight.delete(key);
        });

      return promise;
    }

    // Non-burst path (refresh intervals, manual refresh, etc.) - no stagger
    return this._scheduleImmediate(key, execute);
  }

  /** Clear all cached results and reset burst state (e.g. on explicit user refresh) */
  clearCache(): void {
    this.cache.clear();
    // Reset stagger state so the next manual refresh also staggers
    if (this.staggerTimer) {
      clearTimeout(this.staggerTimer);
      this.staggerTimer = null;
    }
    this.burstStartTime = null;
    this.burstCount = 0;
  }

  private _scheduleImmediate<T>(key: string, execute: () => Promise<T>): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this._enqueue({ key, execute, resolve, reject } as QueueItem<unknown>);
    });

    this.inflight.set(key, promise);
    promise
      .then((result) => {
        this.cache.set(key, { data: result, timestamp: Date.now() });
      })
      .catch((err) => { console.warn('[query-scheduler] immediate query failed', err); })
      .finally(() => {
        this.inflight.delete(key);
      });

    return promise;
  }

  private _enqueue(item: QueueItem<unknown>): void {
    this.queue.push(item);
    this.drain();
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.activeCount++;

      item
        .execute()
        .then((result) => item.resolve(result))
        .catch((err) => item.reject(err))
        .finally(() => {
          this.activeCount--;
          this.drain();
        });
    }
  }
}

/** Global singleton - all panel queries go through this */
export const queryScheduler = new QueryScheduler(4, 300, 4000);
