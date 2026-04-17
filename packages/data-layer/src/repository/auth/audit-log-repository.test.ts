import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { AuditLogRepository } from './audit-log-repository.js';

describe('AuditLogRepository', () => {
  let db: SqliteClient;
  let repo: AuditLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AuditLogRepository(db);
  });

  it('log() inserts with default timestamp', async () => {
    const e = await repo.log({
      action: 'user.login',
      actorType: 'user',
      actorId: 'u1',
      outcome: 'success',
    });
    expect(e.action).toBe('user.login');
    expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('log() serializes object metadata as JSON', async () => {
    const e = await repo.log({
      action: 'team.member_added',
      actorType: 'user',
      outcome: 'success',
      metadata: { teamId: 't1', userId: 'u2' },
    });
    expect(JSON.parse(e.metadata!)).toEqual({ teamId: 't1', userId: 'u2' });
  });

  it('findById() returns the row', async () => {
    const e = await repo.log({ action: 'x', actorType: 'system', outcome: 'success' });
    expect((await repo.findById(e.id))!.id).toBe(e.id);
  });

  it('query() filters by actorId', async () => {
    await repo.log({ action: 'a', actorType: 'user', actorId: 'alice', outcome: 'success' });
    await repo.log({ action: 'b', actorType: 'user', actorId: 'bob', outcome: 'success' });
    const page = await repo.query({ actorId: 'alice' });
    expect(page.items.map((e) => e.action)).toEqual(['a']);
  });

  it('query() filters by action', async () => {
    await repo.log({ action: 'user.login', actorType: 'user', outcome: 'success' });
    await repo.log({ action: 'user.logout', actorType: 'user', outcome: 'success' });
    const page = await repo.query({ action: 'user.login' });
    expect(page.items).toHaveLength(1);
  });

  it('query() filters by outcome', async () => {
    await repo.log({ action: 'user.login', actorType: 'user', outcome: 'success' });
    await repo.log({ action: 'user.login', actorType: 'user', outcome: 'failure' });
    const page = await repo.query({ outcome: 'failure' });
    expect(page.items).toHaveLength(1);
  });

  it('query() filters by org and target id', async () => {
    await repo.log({
      action: 'team.updated', actorType: 'user', outcome: 'success',
      orgId: 'org_main', targetId: 't1',
    });
    await repo.log({
      action: 'team.updated', actorType: 'user', outcome: 'success',
      orgId: 'other', targetId: 't2',
    });
    const page = await repo.query({ orgId: 'org_main' });
    expect(page.items).toHaveLength(1);
  });

  it('query() filters by timestamp range', async () => {
    await repo.log({
      action: 'old', actorType: 'system', outcome: 'success',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await repo.log({
      action: 'new', actorType: 'system', outcome: 'success',
      timestamp: '2026-04-01T00:00:00.000Z',
    });
    const page = await repo.query({ from: '2026-03-01T00:00:00.000Z' });
    expect(page.items.map((e) => e.action)).toEqual(['new']);
  });

  it('query() orders by timestamp DESC', async () => {
    await repo.log({
      action: 'first', actorType: 'system', outcome: 'success',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    await repo.log({
      action: 'second', actorType: 'system', outcome: 'success',
      timestamp: '2026-02-01T00:00:00.000Z',
    });
    const page = await repo.query();
    expect(page.items.map((e) => e.action)).toEqual(['second', 'first']);
  });

  it('query() paginates', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.log({ action: `a${i}`, actorType: 'system', outcome: 'success' });
    }
    const page = await repo.query({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('deleteOlderThan() prunes old rows', async () => {
    await repo.log({
      action: 'old', actorType: 'system', outcome: 'success',
      timestamp: '2020-01-01T00:00:00.000Z',
    });
    await repo.log({
      action: 'new', actorType: 'system', outcome: 'success',
      timestamp: '2099-01-01T00:00:00.000Z',
    });
    const n = await repo.deleteOlderThan('2025-01-01T00:00:00.000Z');
    expect(n).toBe(1);
    const remaining = await repo.query();
    expect(remaining.items.map((e) => e.action)).toEqual(['new']);
  });
});
