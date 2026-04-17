import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { QuotaRepository } from './quota-repository.js';

describe('QuotaRepository', () => {
  let db: SqliteClient;
  let repo: QuotaRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new QuotaRepository(db);
  });

  it('create() rejects rows with both orgId and userId', async () => {
    await expect(
      repo.create({ orgId: 'org_main', userId: 'u', target: 'dashboards', limitVal: 10 }),
    ).rejects.toThrow(/exactly one/);
  });

  it('create() rejects rows with neither orgId nor userId', async () => {
    await expect(
      repo.create({ target: 'dashboards', limitVal: 10 }),
    ).rejects.toThrow(/exactly one/);
  });

  it('upsertOrgQuota() inserts and then updates', async () => {
    const q1 = await repo.upsertOrgQuota('org_main', 'dashboards', 10);
    expect(q1.limitVal).toBe(10);
    const q2 = await repo.upsertOrgQuota('org_main', 'dashboards', 50);
    expect(q2.id).toBe(q1.id);
    expect(q2.limitVal).toBe(50);
  });

  it('upsertUserQuota() inserts and updates', async () => {
    const q1 = await repo.upsertUserQuota('user_1', 'api_keys', 5);
    const q2 = await repo.upsertUserQuota('user_1', 'api_keys', 20);
    expect(q2.id).toBe(q1.id);
    expect(q2.limitVal).toBe(20);
  });

  it('findOrgQuota() returns null when missing', async () => {
    expect(await repo.findOrgQuota('org_main', 'nope')).toBeNull();
  });

  it('listOrgQuotas() lists only org-scoped rows', async () => {
    await repo.upsertOrgQuota('org_main', 'dashboards', 10);
    await repo.upsertOrgQuota('org_main', 'users', 100);
    await repo.upsertUserQuota('user_1', 'api_keys', 5);
    const orgQ = await repo.listOrgQuotas('org_main');
    expect(orgQ.map((q) => q.target).sort()).toEqual(['dashboards', 'users']);
  });

  it('listUserQuotas() lists only user-scoped rows', async () => {
    await repo.upsertUserQuota('user_1', 'api_keys', 5);
    await repo.upsertUserQuota('user_1', 'dashboards', 50);
    await repo.upsertOrgQuota('org_main', 'dashboards', 10);
    const userQ = await repo.listUserQuotas('user_1');
    expect(userQ.map((q) => q.target).sort()).toEqual(['api_keys', 'dashboards']);
  });

  it('limitVal = -1 means unlimited and is accepted', async () => {
    const q = await repo.upsertOrgQuota('org_main', 'dashboards', -1);
    expect(q.limitVal).toBe(-1);
  });

  it('delete() removes a row', async () => {
    const q = await repo.upsertOrgQuota('org_main', 'dashboards', 1);
    expect(await repo.delete(q.id)).toBe(true);
  });

  it('partial unique index rejects duplicate (orgId, target) pairs', async () => {
    await repo.create({ orgId: 'org_main', target: 't', limitVal: 1 });
    await expect(
      repo.create({ orgId: 'org_main', target: 't', limitVal: 2 }),
    ).rejects.toThrow();
  });

  it('partial unique index rejects duplicate (userId, target) pairs', async () => {
    await repo.create({ userId: 'u', target: 't', limitVal: 1 });
    await expect(
      repo.create({ userId: 'u', target: 't', limitVal: 2 }),
    ).rejects.toThrow();
  });
});
