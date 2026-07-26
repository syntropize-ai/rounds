/**
 * `/api/health/ready` is the Kubernetes readinessProbe (helm/rounds/templates/
 * deployment.yaml). It decides whether this pod stays in the Service.
 *
 * It used to hardcode `db: { status: 'skip', message: 'No DB configured' }`
 * — a comment from the in-memory era that stopped being true once
 * `createPersistence` always built SQLite or Postgres — and return 200 for
 * every outcome. So a pod whose database was unreachable reported itself
 * ready, kept its endpoint, and kept taking traffic until a human noticed.
 * The `unhealthy` arm of the response type was unreachable code.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { healthRouter, setDatabaseProbe, setPipelineRunning } from './health.js';

const app = express().use('/api/health', healthRouter);

describe('/api/health/ready', () => {
  beforeEach(() => {
    setPipelineRunning(true);
  });

  it('is ready when the database answers', async () => {
    setDatabaseProbe(async () => {});
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.checks.db.status).toBe('ok');
  });

  it('returns 503 when the database refuses, so the pod leaves the Service', async () => {
    setDatabaseProbe(async () => {
      throw new Error('connect ECONNREFUSED 10.96.0.5:5432');
    });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.checks.db.message).toContain('ECONNREFUSED');
  });

  it('returns 503 when the database hangs rather than waiting on it', async () => {
    // A wedged connection pool never rejects. Without the timeout the probe
    // hangs too, and the kubelet reads a timed-out probe as a failure anyway —
    // but with no message, so nobody learns why.
    setDatabaseProbe(() => new Promise(() => {}));
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.db.message).toMatch(/no response/);
  }, 10_000);

  it('stays serving when only the background pipeline is down', async () => {
    // Degraded, not unhealthy: the product still answers requests, it just is
    // not running proactive work. Taking the pod out of the Service for that
    // would turn a background-job problem into an outage.
    setDatabaseProbe(async () => {});
    setPipelineRunning(false);
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
  });
});
