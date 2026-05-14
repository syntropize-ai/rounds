import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../../test-support/test-db.js';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { approvals } from '../../db/sqlite-schema.js';
import { SqliteApprovalRequestRepository } from './approval.js';
import { toJsonColumn } from '../json-column.js';

/**
 * T1.1 acceptance — schema migration, list() with scope filter, NULL semantics.
 * See approval-scope design notes §3.2 / §3.3.
 */

interface SeedRow {
  id: string;
  orgId?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  opsConnectorId?: string | null;
  targetNamespace?: string | null;
  requesterTeamId?: string | null;
  createdAt?: string;
}

async function seed(db: SqliteClient, rows: SeedRow[]): Promise<void> {
  let i = 0;
  for (const r of rows) {
    await db.insert(approvals).values({
      id: r.id,
      orgId: r.orgId ?? 'org_main',
      action: toJsonColumn({ type: 't', targetService: 's', params: {} }),
      context: toJsonColumn({ requestedBy: 'u', reason: 'x' }),
      status: r.status ?? 'pending',
      expiresAt: '2030-01-01T00:00:00.000Z',
      opsConnectorId: r.opsConnectorId ?? null,
      targetNamespace: r.targetNamespace ?? null,
      requesterTeamId: r.requesterTeamId ?? null,
      createdAt: r.createdAt ?? `2025-01-01T00:00:0${i++}.000Z`,
    });
  }
}

describe('approvals schema migration', () => {
  it('creates the three new columns + three new indexes', () => {
    const db = createTestDb();
    const cols = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(approvals)`));
    const names = new Set(cols.map((c) => c.name));
    expect(names).toContain('ops_connector_id');
    expect(names).toContain('target_namespace');
    expect(names).toContain('requester_team_id');

    const idx = db.all<{ name: string }>(
      sql.raw(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approvals'`),
    );
    const idxNames = new Set(idx.map((r) => r.name));
    expect(idxNames).toContain('ix_approvals_connector');
    expect(idxNames).toContain('ix_approvals_namespace');
    expect(idxNames).toContain('ix_approvals_team');
  });
});

describe('SqliteApprovalRequestRepository.list', () => {
  let db: SqliteClient;
  let repo: SqliteApprovalRequestRepository;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteApprovalRequestRepository(db);
    // Six rows spanning every NULL pattern under test.
    await seed(db, [
      { id: 'a-prod-platform', opsConnectorId: 'prod-eks', targetNamespace: 'platform', requesterTeamId: 't-platform' },
      { id: 'a-prod-payments', opsConnectorId: 'prod-eks', targetNamespace: 'payments', requesterTeamId: 't-payments' },
      { id: 'a-dev-platform',  opsConnectorId: 'dev-eks',  targetNamespace: 'platform', requesterTeamId: 't-platform' },
      { id: 'a-cluster-prod',  opsConnectorId: 'prod-eks', targetNamespace: null,        requesterTeamId: 't-platform' },
      { id: 'a-no-conn',       opsConnectorId: null,        targetNamespace: null,        requesterTeamId: 't-platform' },
      { id: 'a-no-team',       opsConnectorId: 'prod-eks', targetNamespace: 'platform', requesterTeamId: null, status: 'approved' },
    ]);
  });

  it('wildcard returns every row in the org', async () => {
    const out = await repo.list('org_main', { scopeFilter: { kind: 'wildcard' } });
    expect(out.map((r) => r.id).sort()).toEqual(
      ['a-prod-platform', 'a-prod-payments', 'a-dev-platform', 'a-cluster-prod', 'a-no-conn', 'a-no-team'].sort(),
    );
  });

  it('omitting scopeFilter is equivalent to wildcard (full org list)', async () => {
    const out = await repo.list('org_main');
    expect(out).toHaveLength(6);
  });

  it('narrow with uids only — returns matching ids', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: { kind: 'narrow', uids: new Set(['a-no-conn', 'a-prod-platform']) },
    });
    expect(out.map((r) => r.id).sort()).toEqual(['a-no-conn', 'a-prod-platform']);
  });

  it('narrow with connector only — NULL connector rows are NOT returned', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: { kind: 'narrow', connectors: new Set(['prod-eks']) },
    });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(['a-cluster-prod', 'a-no-team', 'a-prod-payments', 'a-prod-platform']);
    expect(ids).not.toContain('a-no-conn');
    expect(ids).not.toContain('a-dev-platform');
  });

  it('narrow with connector+namespace pair — only rows where BOTH match', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: {
        kind: 'narrow',
        nsPairs: [{ connectorId: 'prod-eks', ns: 'platform' }],
      },
    });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(['a-no-team', 'a-prod-platform']);
    // Right connector wrong namespace → excluded.
    expect(ids).not.toContain('a-prod-payments');
    // Cluster-scoped (NULL ns) → excluded even when connector matches.
    expect(ids).not.toContain('a-cluster-prod');
  });

  it('narrow with team only — NULL team rows are NOT returned', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: { kind: 'narrow', teams: new Set(['t-platform']) },
    });
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual(['a-cluster-prod', 'a-dev-platform', 'a-no-conn', 'a-prod-platform']);
    expect(ids).not.toContain('a-no-team');
  });

  it('narrow with all sets empty → zero rows (no fallback to org-wide)', async () => {
    const out = await repo.list('org_main', { scopeFilter: { kind: 'narrow' } });
    expect(out).toEqual([]);
    const out2 = await repo.list('org_main', {
      scopeFilter: {
        kind: 'narrow',
        uids: new Set(),
        connectors: new Set(),
        nsPairs: [],
        teams: new Set(),
      },
    });
    expect(out2).toEqual([]);
  });

  it('narrow union — connectors ∪ teams returns rows matching either', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: {
        kind: 'narrow',
        connectors: new Set(['dev-eks']),
        teams: new Set(['t-payments']),
      },
    });
    const ids = out.map((r) => r.id).sort();
    // dev-eks → a-dev-platform; team payments → a-prod-payments.
    expect(ids).toEqual(['a-dev-platform', 'a-prod-payments']);
  });

  it('status filter works with wildcard', async () => {
    const out = await repo.list('org_main', { scopeFilter: { kind: 'wildcard' }, status: 'pending' });
    const ids = out.map((r) => r.id);
    expect(ids).not.toContain('a-no-team'); // approved
    expect(ids).toHaveLength(5);
  });

  it('status filter works with narrow', async () => {
    const out = await repo.list('org_main', {
      scopeFilter: { kind: 'narrow', connectors: new Set(['prod-eks']) },
      status: 'approved',
    });
    expect(out.map((r) => r.id)).toEqual(['a-no-team']);
  });

  it('status filter accepts an array of statuses', async () => {
    const out = await repo.list('org_main', { status: ['pending', 'approved'] });
    expect(out).toHaveLength(6);
  });

  it('does not leak rows from other orgs', async () => {
    await seed(db, [
      { id: 'other-1', orgId: 'org_other', opsConnectorId: 'prod-eks', targetNamespace: 'platform' },
    ]);
    const out = await repo.list('org_main', { scopeFilter: { kind: 'wildcard' } });
    expect(out.map((r) => r.id)).not.toContain('other-1');
  });
});

/**
 * T2.1 acceptance — submit() persists the three scope columns when provided
 * and writes NULL when omitted. See approvals-multi-team-scope §3.6.
 */
describe('SqliteApprovalRequestRepository.submit — scope enrichment', () => {
  it('persists opsConnectorId / targetNamespace / requesterTeamId when provided', async () => {
    const db = createTestDb();
    const repo = new SqliteApprovalRequestRepository(db);
    const submitted = await repo.submit({
      action: { type: 'ops.run_command', targetService: 'k8s-prod', params: {} },
      context: { requestedBy: 'agent', reason: 'scale up' },
      opsConnectorId: 'k8s-prod',
      targetNamespace: 'payments',
      requesterTeamId: 't-payments',
    });
    expect(submitted.opsConnectorId).toBe('k8s-prod');
    expect(submitted.targetNamespace).toBe('payments');
    expect(submitted.requesterTeamId).toBe('t-payments');

    const fetched = await repo.findById(submitted.id);
    expect(fetched?.opsConnectorId).toBe('k8s-prod');
    expect(fetched?.targetNamespace).toBe('payments');
    expect(fetched?.requesterTeamId).toBe('t-payments');
  });

  it('omitted scope fields are persisted as NULL (back-compat)', async () => {
    const db = createTestDb();
    const repo = new SqliteApprovalRequestRepository(db);
    const submitted = await repo.submit({
      action: { type: 'ops.run_command', targetService: 'k8s-prod', params: {} },
      context: { requestedBy: 'agent', reason: 'no enrichment' },
    });
    expect(submitted.opsConnectorId).toBeNull();
    expect(submitted.targetNamespace).toBeNull();
    expect(submitted.requesterTeamId).toBeNull();
  });
});
