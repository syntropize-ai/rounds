import { describe, it, expect } from 'vitest';
import { createSqliteClient } from './sqlite-client.js';
import { sql } from 'drizzle-orm';

/**
 * Overlapping transactions on the shared connection.
 *
 * An agent turn writes chat_session_event rows continuously while tools run,
 * so a tool that writes inside a transaction — creating a connector — used to
 * hit `cannot start a transaction within a transaction` and fail the whole
 * tool call. HTTP handlers rarely overlap, which is why it stayed hidden.
 */
describe('sqlite withTransaction', () => {
  it('serialises transactions that overlap instead of failing the second one', async () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    await db.run(sql`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);

    // Start one transaction and keep it open across an await, then start a
    // second while the first is still in flight — the exact interleaving an
    // agent turn produces.
    const first = db.withTransaction(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tx.run(sql`INSERT INTO t (v) VALUES ('first')`);
      return 'first';
    });
    const second = db.withTransaction(async (tx) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('second')`);
      return 'second';
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);

    const rows = await db.all<{ v: string }>(sql`SELECT v FROM t ORDER BY id`);
    expect(rows.map((r) => r.v)).toEqual(['first', 'second']);
  });

  it('rolls the failing transaction back without blocking the queue behind it', async () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    await db.run(sql`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);

    const failing = db.withTransaction(async (tx) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('doomed')`);
      throw new Error('tool failed mid-write');
    });
    const following = db.withTransaction(async (tx) => {
      await tx.run(sql`INSERT INTO t (v) VALUES ('after')`);
      return 'after';
    });

    await expect(failing).rejects.toThrow('tool failed mid-write');
    await expect(following).resolves.toBe('after');

    const rows = await db.all<{ v: string }>(sql`SELECT v FROM t`);
    expect(rows.map((r) => r.v)).toEqual(['after']);
  });
});
