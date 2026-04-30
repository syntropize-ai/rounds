/**
 * Single-leader lock backed by `_runtime_settings`.
 *
 * Multi-replica HA story (design-doc §5 follow-up): only one
 * AlertEvaluatorService should evaluate alert rules across replicas,
 * otherwise a rule fires twice — once per replica — and downstream
 * (history rows, ApprovalRequests, auto-investigations) gets duplicated.
 *
 * The lock is a row keyed on a caller-chosen string. The current holder
 * stores its `leaderId` and an `expiresAt` ISO timestamp inside the
 * value JSON; everyone else can take over after expiry. Holder
 * heartbeats periodically to extend its lease.
 *
 * Cross-dialect SQL: `_runtime_settings` exists in both SQLite and
 * Postgres schemas, and `json_extract` works on both (with the same
 * `$.path` argument shape). The repository's `QueryClient` abstracts
 * the dialect.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createLogger } from '@agentic-obs/common/logging';
import type { QueryClient } from '@agentic-obs/data-layer';

const log = createLogger('leader-lock');

export interface LeaderLockOptions {
  db: QueryClient;
  /** Stable key for the lock; one lock per key. */
  key: string;
  /** Override for tests; defaults to randomUUID(). */
  leaderId?: string;
  /**
   * How long a claim is valid past the last heartbeat. After this passes,
   * the lock is considered stale and another instance can take over.
   * Default 30 seconds.
   */
  ttlMs?: number;
  /** Override for tests. */
  clock?: () => Date;
}

/**
 * Result of a lock attempt. The `leaderId` field is the ID we used to
 * claim — store it on the caller side if you want to assert against
 * subsequent heartbeats.
 */
export interface LockClaim {
  ok: boolean;
  /** Set when ok=true — the leaderId we now own the row under. */
  leaderId?: string;
}

interface LockValue {
  leaderId: string;
  expiresAt: string;
}

/**
 * Lock primitive. Stateless — `tryAcquire`, `heartbeat`, `release` are
 * the surface. Callers wrap these in their own lifecycle (timer +
 * "what to do when leadership flips").
 */
export class LeaderLock {
  readonly leaderId: string;
  readonly key: string;
  readonly ttlMs: number;
  private readonly db: QueryClient;
  private readonly clock: () => Date;

  constructor(opts: LeaderLockOptions) {
    this.db = opts.db;
    this.key = opts.key;
    this.leaderId = opts.leaderId ?? randomUUID();
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Try to claim the lock. Succeeds when:
   *   - the row doesn't exist yet, OR
   *   - the existing row's `expiresAt` is in the past.
   *
   * If a healthy holder owns the lock, returns `{ ok: false }` without
   * stomping on it.
   */
  async tryAcquire(): Promise<LockClaim> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const value: LockValue = { leaderId: this.leaderId, expiresAt };
    const valueJson = JSON.stringify(value);

    // Phase 1: try insert. If row exists, ON CONFLICT branches based on
    // whether the existing value's expiresAt is in the past — only stomp
    // on stale rows.
    await this.db.run(sql`
      INSERT INTO _runtime_settings (id, value, updated)
      VALUES (${this.key}, ${valueJson}, ${now.toISOString()})
      ON CONFLICT(id) DO UPDATE
      SET value = ${valueJson}, updated = ${now.toISOString()}
      WHERE json_extract(_runtime_settings.value, '$.expiresAt') < ${now.toISOString()}
    `);

    // Phase 2: read back. If our leaderId is the row's leaderId, we won.
    const rows = await this.db.all<{ value: string }>(sql`
      SELECT value FROM _runtime_settings WHERE id = ${this.key}
    `);
    const cur = parseValue(rows[0]?.value);
    if (cur && cur.leaderId === this.leaderId) {
      return { ok: true, leaderId: this.leaderId };
    }
    return { ok: false };
  }

  /**
   * Refresh the expiry on the lock. Returns true iff we still own it
   * (heartbeat won't overwrite a row that's been taken from us by
   * someone else after TTL expiry).
   */
  async heartbeat(): Promise<boolean> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const value: LockValue = { leaderId: this.leaderId, expiresAt };
    const valueJson = JSON.stringify(value);

    await this.db.run(sql`
      UPDATE _runtime_settings
      SET value = ${valueJson}, updated = ${now.toISOString()}
      WHERE id = ${this.key}
      AND json_extract(value, '$.leaderId') = ${this.leaderId}
    `);

    const rows = await this.db.all<{ value: string }>(sql`
      SELECT value FROM _runtime_settings WHERE id = ${this.key}
    `);
    const cur = parseValue(rows[0]?.value);
    return cur?.leaderId === this.leaderId;
  }

  /**
   * Release the lock if we hold it. Idempotent — calling release when
   * we don't hold the lock (already lost or never acquired) is a no-op.
   */
  async release(): Promise<void> {
    await this.db.run(sql`
      DELETE FROM _runtime_settings
      WHERE id = ${this.key}
      AND json_extract(value, '$.leaderId') = ${this.leaderId}
    `);
  }
}

function parseValue(raw: string | null | undefined): LockValue | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LockValue>;
    if (typeof v.leaderId === 'string' && typeof v.expiresAt === 'string') {
      return v as LockValue;
    }
    return null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'leader-lock: stored value is not JSON; treating as stale',
    );
    return null;
  }
}
