import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqlitePendingChangeRepository } from './pending-change.js';
import type { PendingChange } from '../interfaces.js';

const ORG = 'org_main';

type InsertInput = Parameters<SqlitePendingChangeRepository['insert']>[0];

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

describe('SqlitePendingChangeRepository', () => {
  let db: SqliteClient;
  let repo: SqlitePendingChangeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqlitePendingChangeRepository(db);
  });

  it('insert + getById round-trip preserves every field', async () => {
    const input = buildRow({ summary: 'modify CPU panel' });
    const saved = await repo.insert(input);

    expect(saved.id).toBe(input.id);
    expect(saved.orgId).toBe(ORG);
    expect(saved.dashboardId).toBe('d-1');
    expect(saved.panelId).toBe('p-1');
    expect(saved.proposedBy).toBe('agent:sess-1');
    expect(saved.status).toBe('pending');
    expect(saved.resolvedAt).toBeNull();
    expect(saved.resolvedBy).toBeNull();
    expect(saved.changeKind).toBe('modify_panel');
    expect(saved.beforeJson).toEqual({ v: 1 });
    expect(saved.afterJson).toEqual({ v: 2 });
    expect(saved.summary).toBe('modify CPU panel');
    expect(saved.expiresAt).toBe(input.expiresAt);

    const fetched = await repo.getById(ORG, input.id);
    expect(fetched).toEqual(saved);
  });

  it('beforeJson null is preserved (add_panel / add_variable shape)', async () => {
    const saved = await repo.insert(buildRow({ changeKind: 'add_panel', beforeJson: null }));
    const fetched = await repo.getById(ORG, saved.id);
    expect(fetched?.beforeJson).toBeNull();
  });

  it('panelId null is preserved (variable / set_title shape)', async () => {
    const saved = await repo.insert(buildRow({ changeKind: 'add_variable', panelId: null }));
    expect(saved.panelId).toBeNull();
    const fetched = await repo.getById(ORG, saved.id);
    expect(fetched?.panelId).toBeNull();
  });

  it('listByDashboard returns only matching status (default pending)', async () => {
    const a = await repo.insert(buildRow());
    const b = await repo.insert(buildRow());
    await repo.resolve(ORG, b.id, 'rejected', 'user-1');

    const pending = await repo.listByDashboard(ORG, 'd-1');
    expect(pending.map((r) => r.id)).toEqual([a.id]);

    const rejected = await repo.listByDashboard(ORG, 'd-1', { status: 'rejected' });
    expect(rejected.map((r) => r.id)).toEqual([b.id]);
  });

  it('countByOrg + countByOrgGrouped reflect status filter', async () => {
    await repo.insert(buildRow({ dashboardId: 'd-1' }));
    await repo.insert(buildRow({ dashboardId: 'd-1' }));
    await repo.insert(buildRow({ dashboardId: 'd-2' }));

    expect(await repo.countByOrg(ORG)).toBe(3);
    const grouped = await repo.countByOrgGrouped(ORG);
    const byId = Object.fromEntries(grouped.map((g) => [g.dashboardId, g.count]));
    expect(byId['d-1']).toBe(2);
    expect(byId['d-2']).toBe(1);
  });

  it('resolve transitions pending → accepted and stamps actor', async () => {
    const r = await repo.insert(buildRow());
    const resolved = await repo.resolve(ORG, r.id, 'accepted', 'user-7');
    expect(resolved?.status).toBe('accepted');
    expect(resolved?.resolvedBy).toBe('user-7');
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it('resolve is a no-op on already-resolved rows', async () => {
    const r = await repo.insert(buildRow());
    await repo.resolve(ORG, r.id, 'accepted', 'user-a');
    await repo.resolve(ORG, r.id, 'rejected', 'user-b');
    const final = await repo.getById(ORG, r.id);
    expect(final?.status).toBe('accepted');
    expect(final?.resolvedBy).toBe('user-a');
  });

  it('expireOlderThan flips overdue pending rows to expired', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 1_000_000).toISOString();
    const overdue = await repo.insert(buildRow({ expiresAt: past }));
    const fresh = await repo.insert(buildRow({ expiresAt: future }));

    const swept = await repo.expireOlderThan(new Date().toISOString());
    expect(swept).toBe(1);

    expect((await repo.getById(ORG, overdue.id))?.status).toBe('expired');
    expect((await repo.getById(ORG, fresh.id))?.status).toBe('pending');
  });

  it('corrupt JSON throws when reading after_json', async () => {
    const r = await repo.insert(buildRow());
    db.run(sql`UPDATE pending_changes SET after_json = '{not-json' WHERE id = ${r.id}`);
    await expect(repo.getById(ORG, r.id)).rejects.toThrow(/corrupt JSON/);
  });

  it('orgId isolation — different orgs cannot see each other', async () => {
    const r = await repo.insert(buildRow({ orgId: 'org-a' }));
    expect(await repo.getById('org-b', r.id)).toBeNull();
  });
});
