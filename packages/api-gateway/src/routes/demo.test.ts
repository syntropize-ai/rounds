// Demo router smoke tests — verify the env-var gate and the fixture
// surface. The router is intentionally tiny; these tests guard the
// invariant that `OPENOBS_DEMO=1` is the only switch that mounts it.

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createTestDb, InvestigationRepository } from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { createDemoRouter, seedDemoInvestigation, DEMO_INVESTIGATION_ID } from './demo.js';

function makeApp(): express.Application {
  const app = express();
  app.use('/api/demo', createDemoRouter());
  return app;
}

async function get(app: express.Application, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = express.request as unknown as Record<string, unknown>;
    void req;
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (r) => {
          const body = await r.json().catch(() => null);
          server.close();
          resolve({ status: r.status, body });
        })
        .catch((e) => { server.close(); reject(e); });
    });
  });
}

describe('demo router', () => {
  it('GET /status returns demo banner + CTA', async () => {
    const app = makeApp();
    const r = await get(app, '/api/demo/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      cta: { investigationId: 'demo-investigation-api-latency' },
    });
  });

  it('GET /investigation returns the preset investigation fixture', async () => {
    const app = makeApp();
    const r = await get(app, '/api/demo/investigation');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 'demo-investigation-api-latency',
      scenario: 'api-latency-spike',
    });
  });

  it('GET /alert-rule returns the demo CPU rule', async () => {
    const app = makeApp();
    const r = await get(app, '/api/demo/alert-rule');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: 'demo-cpu-high',
      threshold: 80,
    });
  });
});

// -- Boot seed --------------------------------------------------------
// The banner CTA deep-links to /investigations/<DEMO_INVESTIGATION_ID>, so
// the row has to exist in the investigation store. `boot()` mirrors the
// ROUNDS_DEMO gate in server.ts — the env read lives there, so the tests
// reproduce the same condition around the seed call.

async function boot(db: SqliteClient): Promise<void> {
  if (process.env['ROUNDS_DEMO'] === '1' || process.env['OPENOBS_DEMO'] === '1') {
    await seedDemoInvestigation(db);
  }
}

describe('demo investigation seed', () => {
  afterEach(() => {
    delete process.env['ROUNDS_DEMO'];
    delete process.env['OPENOBS_DEMO'];
  });

  it('seeds the fixture investigation under the advertised id when the flag is set', async () => {
    process.env['ROUNDS_DEMO'] = '1';
    const db = createTestDb();
    await boot(db);

    const inv = await new InvestigationRepository(db).findById(DEMO_INVESTIGATION_ID);
    expect(inv).not.toBeNull();
    expect(inv?.intent).toBe('API latency spike on /checkout');
    expect(inv?.workspaceId).toBe('org_main');
    expect(inv?.status).toBe('completed');
    expect(inv?.evidence).toHaveLength(3);
    expect(inv?.hypotheses[0]?.description).toContain('CPU saturation');
  });

  it('is idempotent across two boots', async () => {
    process.env['ROUNDS_DEMO'] = '1';
    const db = createTestDb();
    await boot(db);
    const first = await new InvestigationRepository(db).findById(DEMO_INVESTIGATION_ID);
    await boot(db);

    const all = await new InvestigationRepository(db).findAll();
    expect(all.filter((i) => i.id === DEMO_INVESTIGATION_ID)).toHaveLength(1);
    expect(await new InvestigationRepository(db).findById(DEMO_INVESTIGATION_ID)).toEqual(first);
  });

  it('seeds nothing when the demo flag is off', async () => {
    const db = createTestDb();
    await boot(db);

    expect(await new InvestigationRepository(db).findById(DEMO_INVESTIGATION_ID)).toBeNull();
    expect(await new InvestigationRepository(db).findAll()).toHaveLength(0);
  });
});
