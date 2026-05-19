import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqlitePanelEventRepository } from './panel-event.js';
import type { PanelEvent } from '../types/panel-event.js';

function makeInput(overrides: Partial<Omit<PanelEvent, 'id' | 'createdAt'>> = {}): Omit<PanelEvent, 'id' | 'createdAt'> {
  return {
    orgId: 'org_main',
    dashboardId: 'dash_1',
    panelId: 'panel_1',
    eventType: 'created',
    panelSnapshot: { id: 'panel_1', title: 'Latency', visualization: 'time_series' },
    querySignature: 'sum(rate(http_requests_total{app="*"}[5m]))',
    vizType: 'time_series',
    aiGenerated: false,
    actorId: 'user_1',
    sessionId: null,
    ...overrides,
  };
}

describe('SqlitePanelEventRepository', () => {
  let db: SqliteClient;
  let repo: SqlitePanelEventRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqlitePanelEventRepository(db);
  });

  it('record() persists a row and returns the generated id', async () => {
    const { id } = await repo.record(makeInput());
    expect(id).toMatch(/.+/);
    const found = await repo.findByDashboard('org_main', 'dash_1');
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(id);
    expect(found[0]!.eventType).toBe('created');
    expect(found[0]!.panelSnapshot).toMatchObject({ title: 'Latency' });
    expect(found[0]!.aiGenerated).toBe(false);
  });

  it('findByDashboard scopes to org_id and dashboard_id', async () => {
    await repo.record(makeInput({ dashboardId: 'dash_1' }));
    await repo.record(makeInput({ dashboardId: 'dash_2' }));
    await repo.record(makeInput({ orgId: 'org_other', dashboardId: 'dash_1' }));
    const rows = await repo.findByDashboard('org_main', 'dash_1');
    expect(rows).toHaveLength(1);
  });

  it('findByQuerySignature returns matching org+signature rows', async () => {
    const sig = 'sum(rate(http_requests_total{app="*"}[5m]))';
    await repo.record(makeInput({ querySignature: sig }));
    await repo.record(makeInput({ querySignature: 'something_else' }));
    const rows = await repo.findByQuerySignature('org_main', sig);
    expect(rows).toHaveLength(1);
  });

  it('aggregateBySignature groups and counts', async () => {
    const sig = 'sum(rate(http_requests_total{app="*"}[5m]))';
    await repo.record(makeInput({ querySignature: sig, eventType: 'created' }));
    await repo.record(makeInput({ querySignature: sig, eventType: 'edited' }));
    await repo.record(makeInput({ querySignature: 'other', eventType: 'created', panelId: 'p2' }));
    const agg = await repo.aggregateBySignature('org_main', {});
    expect(agg).toHaveLength(2);
    const first = agg.find((r) => r.signature === sig);
    expect(first?.count).toBe(2);
    expect(first?.vizType).toBe('time_series');
  });

  it('aggregateBySignature filters by eventTypes and since', async () => {
    const sig = 'sig_a';
    await repo.record(makeInput({ querySignature: sig, eventType: 'created' }));
    await repo.record(makeInput({ querySignature: sig, eventType: 'edited' }));
    const agg = await repo.aggregateBySignature('org_main', { eventTypes: ['created'] });
    expect(agg).toHaveLength(1);
    expect(agg[0]!.count).toBe(1);

    // Since-in-future returns no rows.
    const future = new Date(Date.now() + 60_000).toISOString();
    const aggSince = await repo.aggregateBySignature('org_main', { since: future });
    expect(aggSince).toHaveLength(0);
  });

  it('aggregateBySignature deletedWithin24h flags only same-panel deletions', async () => {
    const sig = 'sig_x';
    // Same panel: created then deleted (within 24h) — should count toward deletedWithin24h.
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_short', eventType: 'created' }));
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_short', eventType: 'deleted' }));
    // Different panel, deleted but never had a 'created' row — should NOT count.
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_orphan', eventType: 'deleted' }));
    const agg = await repo.aggregateBySignature('org_main', {});
    expect(agg).toHaveLength(1);
    expect(agg[0]!.deletedWithin24h).toBe(1);
  });

  it('skips rows with null query_signature in aggregation', async () => {
    await repo.record(makeInput({ querySignature: null, vizType: 'text' }));
    const agg = await repo.aggregateBySignature('org_main', {});
    expect(agg).toHaveLength(0);
  });
});
