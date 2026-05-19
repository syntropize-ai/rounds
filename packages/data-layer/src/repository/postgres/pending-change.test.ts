/**
 * Postgres PendingChangeRepository — integration tests.
 *
 * Same POSTGRES_TEST_URL contract as the sibling knowledge.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresSchema } from './schema-applier.js';
import { PostgresPendingChangeRepository } from './pending-change.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;
const ORG = 'org_main';

type InsertInput = Parameters<PostgresPendingChangeRepository['insert']>[0];

function buildRow(overrides: Partial<InsertInput> = {}): InsertInput {
  const proposedAt = overrides.proposedAt ?? new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    orgId: overrides.orgId ?? ORG,
    dashboardId: overrides.dashboardId ?? 'd-1',
    panelId: overrides.panelId === undefined ? 'p-1' : overrides.panelId,
    proposedBy: overrides.proposedBy ?? 'agent:sess-1',
    proposedAt,
    changeKind: overrides.changeKind ?? 'modify_panel',
    beforeJson: overrides.beforeJson === undefined ? { v: 1 } : overrides.beforeJson,
    afterJson: overrides.afterJson ?? { v: 2 },
    summary: overrides.summary ?? 'Test change',
    expiresAt:
      overrides.expiresAt ??
      new Date(Date.parse(proposedAt) + 7 * 24 * 3600 * 1000).toISOString(),
  };
}

describeIfPg('PostgresPendingChangeRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let db: DbClient;

  beforeAll(async () => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-instance-config-repositories-xxxxxxxx';
    db = createDbClient({ url: PG_URL! });
    await applyPostgresSchema(db);
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE pending_changes`);
  });

  it('insert + getById round-trip', async () => {
    const repo = new PostgresPendingChangeRepository(db);
    const saved = await repo.insert(buildRow());
    expect(saved.status).toBe('pending');
    expect(saved.beforeJson).toEqual({ v: 1 });
    expect(saved.afterJson).toEqual({ v: 2 });
    const fetched = await repo.getById(ORG, saved.id);
    expect(fetched).toEqual(saved);
  });

  it('listByDashboard + resolve', async () => {
    const repo = new PostgresPendingChangeRepository(db);
    const a = await repo.insert(buildRow());
    const b = await repo.insert(buildRow());
    await repo.resolve(ORG, b.id, 'accepted', 'user-1');
    const pending = await repo.listByDashboard(ORG, 'd-1');
    expect(pending.map((r) => r.id)).toEqual([a.id]);
    expect((await repo.getById(ORG, b.id))?.status).toBe('accepted');
  });

  it('countByOrgGrouped aggregates by dashboard', async () => {
    const repo = new PostgresPendingChangeRepository(db);
    await repo.insert(buildRow({ dashboardId: 'd-x' }));
    await repo.insert(buildRow({ dashboardId: 'd-x' }));
    await repo.insert(buildRow({ dashboardId: 'd-y' }));
    const grouped = await repo.countByOrgGrouped(ORG);
    const byId = Object.fromEntries(grouped.map((g) => [g.dashboardId, g.count]));
    expect(byId['d-x']).toBe(2);
    expect(byId['d-y']).toBe(1);
  });

  it('expireOlderThan flips overdue rows', async () => {
    const repo = new PostgresPendingChangeRepository(db);
    const past = new Date(Date.now() - 1000).toISOString();
    const overdue = await repo.insert(buildRow({ expiresAt: past }));
    const fresh = await repo.insert(buildRow({ expiresAt: new Date(Date.now() + 1_000_000).toISOString() }));
    const swept = await repo.expireOlderThan(new Date().toISOString());
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await repo.getById(ORG, overdue.id))?.status).toBe('expired');
    expect((await repo.getById(ORG, fresh.id))?.status).toBe('pending');
  });

  it('corrupt JSON throws', async () => {
    const repo = new PostgresPendingChangeRepository(db);
    const r = await repo.insert(buildRow());
    await db.run(sql`UPDATE pending_changes SET after_json = '{nope' WHERE id = ${r.id}`);
    await expect(repo.getById(ORG, r.id)).rejects.toThrow(/corrupt JSON/);
  });
});
