/**
 * Prometheus can answer `200 OK` with `{"status":"error"}`: a matcher it
 * rejected, a series limit, a federated backend that lost a shard.
 *
 * The query paths in this adapter always checked that and threw. The five
 * discovery paths did not — they read `body.data`, found it absent, and
 * returned `[]`. So a failed lookup and an empty Prometheus produced the same
 * answer, and discovery is exactly where an investigation decides what exists:
 * the agent concludes the metric it needs is not collected and goes looking
 * somewhere else, having never been told the question failed.
 *
 * The handler above it made it worse by reporting "No labels found" *and*
 * writing a `success` audit row.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PrometheusMetricsAdapter } from './metrics-adapter.js';

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function adapter() {
  return new PrometheusMetricsAdapter('http://prom:9090');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('discovery does not read a failed query as an empty result', () => {
  const failure = { status: 'error', error: 'expanding series: context deadline exceeded' };

  it('listMetricNames throws rather than returning []', async () => {
    vi.stubGlobal('fetch', ok(failure));
    await expect(adapter().listMetricNames()).rejects.toThrow(/context deadline exceeded/);
  });

  it('listLabels throws rather than returning []', async () => {
    vi.stubGlobal('fetch', ok(failure));
    await expect(adapter().listLabels('up')).rejects.toThrow(/deadline/);
  });

  it('listLabelValues throws rather than returning []', async () => {
    vi.stubGlobal('fetch', ok(failure));
    await expect(adapter().listLabelValues('job')).rejects.toThrow(/deadline/);
  });
});

describe('a genuinely empty Prometheus still reads as empty', () => {
  it('success with no data is an empty list, not an error', async () => {
    // The distinction has to cut both ways or discovery becomes unusable on a
    // fresh install.
    vi.stubGlobal('fetch', ok({ status: 'success', data: [] }));
    await expect(adapter().listMetricNames()).resolves.toEqual([]);
  });

  it('success with data is returned', async () => {
    vi.stubGlobal('fetch', ok({ status: 'success', data: ['up', 'http_requests_total'] }));
    await expect(adapter().listMetricNames()).resolves.toEqual(['up', 'http_requests_total']);
  });
});
