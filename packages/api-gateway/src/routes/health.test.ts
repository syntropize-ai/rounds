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

  it('returns healthy once setPipelineRunning(true) is called', async () => {
    setPipelineRunning(true);
    const res = await request(makeApp()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.checks.proactive.status).toBe('ok');
  });
});
