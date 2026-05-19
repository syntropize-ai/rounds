import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { IPanelEventRepository } from '@agentic-obs/data-layer';
import { createAdminPanelEventsRouter } from './admin-panel-events.js';

function makeApp(repo: IPanelEventRepository, isServerAdmin: boolean) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).auth = {
      userId: 'admin_1',
      orgId: 'org_main',
      orgRole: 'Admin',
      isServerAdmin,
      authenticatedBy: 'session',
    };
    next();
  });
  app.use('/api/admin/panel-events', createAdminPanelEventsRouter({ panelEvents: repo }));
  return app;
}

describe('admin panel-events router', () => {
  const aggregateBySignature = vi.fn(async () => [
    { signature: 'sig_a', vizType: 'time_series', count: 3, deletedWithin24h: 1 },
  ]);
  const repo: IPanelEventRepository = {
    record: vi.fn(),
    findByDashboard: vi.fn(),
    findByQuerySignature: vi.fn(),
    aggregateBySignature,
  } as unknown as IPanelEventRepository;

  it('403s for non-server-admins', async () => {
    const res = await request(makeApp(repo, false)).get('/api/admin/panel-events/aggregate');
    expect(res.status).toBe(403);
  });

  it('returns the aggregate shape for server admins', async () => {
    const res = await request(makeApp(repo, true)).get('/api/admin/panel-events/aggregate');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].signature).toBe('sig_a');
    expect(aggregateBySignature).toHaveBeenCalledWith('org_main', {});
  });

  it('passes through since and eventTypes filters', async () => {
    aggregateBySignature.mockClear();
    const res = await request(makeApp(repo, true)).get(
      '/api/admin/panel-events/aggregate?since=2026-01-01T00:00:00.000Z&eventTypes=created,deleted',
    );
    expect(res.status).toBe(200);
    expect(aggregateBySignature).toHaveBeenCalledWith('org_main', {
      since: '2026-01-01T00:00:00.000Z',
      eventTypes: ['created', 'deleted'],
    });
  });

  it('rejects an invalid since parameter with 400', async () => {
    const res = await request(makeApp(repo, true)).get(
      '/api/admin/panel-events/aggregate?since=not-a-date',
    );
    expect(res.status).toBe(400);
  });
});
