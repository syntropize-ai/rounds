// Demo router smoke tests — verify the env-var gate and the fixture
// surface. The router is intentionally tiny; these tests guard the
// invariant that `OPENOBS_DEMO=1` is the only switch that mounts it.

import { describe, it, expect } from 'vitest';
import express from 'express';
import { createDemoRouter } from './demo.js';

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
