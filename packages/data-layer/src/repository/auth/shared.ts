import { randomUUID } from 'node:crypto';

/**
 * Shared helpers for the auth/perm repositories.
 *
 * We use raw SQL (drizzle's `sql` tag + `db.run/all/get`) rather than the
 * drizzle table DSL because the auth/perm tables are created via SQL migration
 * files rather than the drizzle schema — adding them to both would double up
 * the source of truth and invite drift.
 */

export function uid(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 0/1 -> boolean. */
export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return Number(v) === 1;
}

/** boolean -> 0/1 for SQLite INTEGER columns. */
export function fromBool(v: boolean | undefined, dflt = false): number {
  return (v ?? dflt) ? 1 : 0;
}
