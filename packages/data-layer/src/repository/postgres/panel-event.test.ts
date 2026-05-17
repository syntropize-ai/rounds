/**
 * Postgres PanelEventRepository — integration tests. Guarded by
 * POSTGRES_TEST_URL (suite skips when unset, mirroring the other pg test
 * suites in this directory).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresSchema } from './schema-applier.js';
import { PostgresPanelEventRepository } from './panel-event.js';
import type { PanelEvent } from '../types/panel-event.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;

function makeInput(
  overrides: Partial<Omit<PanelEvent, 'id' | 'createdAt'>> = {},
): Omit<PanelEvent, 'id' | 'createdAt'> {
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

describeIfPg('PostgresPanelEventRepository', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = createDbClient({ url: PG_URL! });
    await applyPostgresSchema(db);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE panel_events`);
  });

  it('round-trips a row', async () => {
    const repo = new PostgresPanelEventRepository(db);
    const { id } = await repo.record(makeInput());
    expect(id).toMatch(/.+/);
    const rows = await repo.findByDashboard('org_main', 'dash_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.panelSnapshot).toMatchObject({ title: 'Latency' });
  });

  it('aggregateBySignature counts and bucketizes deletedWithin24h', async () => {
    const repo = new PostgresPanelEventRepository(db);
    const sig = 'sig_x';
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_a', eventType: 'created' }));
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_a', eventType: 'deleted' }));
    await repo.record(makeInput({ querySignature: sig, panelId: 'p_b', eventType: 'deleted' }));
    const agg = await repo.aggregateBySignature('org_main', {});
    expect(agg).toHaveLength(1);
    expect(agg[0]!.count).toBe(3);
    expect(agg[0]!.deletedWithin24h).toBe(1);
  });

  it('eventTypes filter narrows the aggregation', async () => {
    const repo = new PostgresPanelEventRepository(db);
    await repo.record(makeInput({ querySignature: 's', eventType: 'created' }));
    await repo.record(makeInput({ querySignature: 's', eventType: 'edited' }));
    const agg = await repo.aggregateBySignature('org_main', { eventTypes: ['edited'] });
    expect(agg).toHaveLength(1);
    expect(agg[0]!.count).toBe(1);
  });
});
