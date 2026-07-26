/**
 * Tests for /api/health/ready — verifies setPipelineRunning toggles the
 * proactive-pipeline check that drives the `degraded` vs `healthy` status.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { healthRouter, setPipelineRunning } from './health.js';

function makeApp() {
  const app = express();
  app.use('/api/health', healthRouter);
  return app;
}

describe('GET /api/health/ready', () => {
  afterEach(() => {
    setPipelineRunning(false);
  });

  it('returns degraded before setPipelineRunning(true) is called', async () => {
    const res = await request(makeApp()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.proactive.status).toBe('fail');
  });

  it('is still not healthy on the pipeline alone, because the database is unverified', async () => {
    // `setDatabaseProbe` is registered by `createPersistence`, which this test
    // does not run. Without it the database is unknown, and unknown is not
    // healthy — that conflation is what let a pod with a dead database report
    // itself ready. Serving continues (200); the claim does not.
    setPipelineRunning(true);
    const res = await request(makeApp()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.proactive.status).toBe('ok');
    expect(res.body.checks.db.status).toBe('skip');
  });
});
