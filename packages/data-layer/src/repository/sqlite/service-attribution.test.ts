import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteServiceAttributionRepository } from './service-attribution.js';
import {
  extractPromqlServiceLabel,
  applyTier1PromqlAttribution,
} from '../service-attribution-tier1.js';

describe('SqliteServiceAttributionRepository', () => {
  let db: SqliteClient;
  let repo: SqliteServiceAttributionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteServiceAttributionRepository(db);
  });

  it('upsert is idempotent on the UNIQUE constraint', async () => {
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd1',
      serviceName: 'foo',
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    // Same (resource, source_kind) → updates rather than duplicating.
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd1',
      serviceName: 'foo-renamed',
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    const rows = await repo.listAttributionsByResource(
      'org_main',
      'dashboard',
      'd1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.serviceName).toBe('foo-renamed');
  });

  it('listServices aggregates by service_name and respects visibility', async () => {
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd1',
      serviceName: 'foo',
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd2',
      serviceName: 'foo',
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    // Below threshold and unconfirmed — must not appear.
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd3',
      serviceName: 'invisible',
      sourceTier: 3,
      sourceKind: 'ai_infer',
      confidence: 0.4,
      userConfirmed: false,
    });
    const summary = await repo.listServices('org_main');
    expect(summary).toEqual([{ name: 'foo', resourceCount: 2 }]);
  });

  it('listUnassigned returns candidates with no visible attribution', async () => {
    await repo.upsert('org_main', {
      resourceKind: 'dashboard',
      resourceId: 'd1',
      serviceName: 'foo',
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    const unassigned = await repo.listUnassigned(
      'org_main',
      'dashboard',
      ['d1', 'd2', 'd3'],
    );
    expect(unassigned.sort()).toEqual(['d2', 'd3']);
  });

  it('confirmAttribution writes a manual row with user_confirmed=1', async () => {
    const row = await repo.confirmAttribution(
      'org_main',
      'dashboard',
      'd1',
      'checkout-api',
      'u-1',
    );
    expect(row.userConfirmed).toBe(true);
    expect(row.sourceTier).toBe(4);
    expect(row.sourceKind).toBe('manual');
    expect(row.confidence).toBe(1);
    const summary = await repo.listServices('org_main');
    expect(summary).toEqual([{ name: 'checkout-api', resourceCount: 1 }]);
  });
});

describe('extractPromqlServiceLabel', () => {
  it('extracts service="x" from PromQL', () => {
    expect(
      extractPromqlServiceLabel(
        'sum by (pod) (rate(http_requests_total{service="ingress-gateway"}[5m]))',
      ),
    ).toBe('ingress-gateway');
  });

  it('accepts == and single quotes', () => {
    expect(extractPromqlServiceLabel(`up{service=='foo'}`)).toBe('foo');
  });

  it('returns null when the label is absent', () => {
    expect(extractPromqlServiceLabel('rate(http_requests_total{job="api"}[5m])')).toBeNull();
  });

  it('ignores regex matchers (Tier-3 territory)', () => {
    expect(extractPromqlServiceLabel('up{service=~"foo.*"}')).toBeNull();
  });
});

describe('applyTier1PromqlAttribution', () => {
  it('writes a Tier-1 attribution row when service label is present', async () => {
    const db = createTestDb();
    const repo = new SqliteServiceAttributionRepository(db);
    const result = await applyTier1PromqlAttribution(repo, 'org_main', {
      kind: 'dashboard',
      id: 'd1',
      queries: ['rate(http_requests_total{service="foo"}[5m])'],
    });
    expect(result).toEqual({ attributed: true, service: 'foo' });
    const rows = await repo.listAttributionsByResource('org_main', 'dashboard', 'd1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceKind).toBe('prom_label');
    expect(rows[0]!.confidence).toBe(0.95);
  });

  it('writes nothing when no service label is found — resource appears unassigned', async () => {
    const db = createTestDb();
    const repo = new SqliteServiceAttributionRepository(db);
    const result = await applyTier1PromqlAttribution(repo, 'org_main', {
      kind: 'dashboard',
      id: 'd1',
      queries: ['rate(http_requests_total{job="api"}[5m])'],
    });
    expect(result.attributed).toBe(false);
    const unassigned = await repo.listUnassigned('org_main', 'dashboard', ['d1']);
    expect(unassigned).toEqual(['d1']);
  });
});
