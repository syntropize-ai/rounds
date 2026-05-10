/**
 * Setup smoke — POST /api/connectors/test (Ref PR #126).
 *
 * Two probes:
 *   1. healthy URL  -> ok=true.
 *   2. nonexistent host -> ok=false with a useful error category in the
 *      message (DNS / timeout / ENOTFOUND).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { apiDelete, apiPost, ApiError } from '../helpers/api-client.js';

interface TestResult { ok: boolean; message: string }
interface CreateConnectorResponse { connector: { id: string } }

const PROM_URL =
  process.env['OPENOBS_TEST_PROM_URL'] ?? 'http://prometheus.openobs-e2e:9090';

describe('setup/connector-test-connection', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  });

  it('healthy prometheus URL -> ok=true', async () => {
    const created = await apiPost<CreateConnectorResponse>('/api/connectors', {
      type: 'prometheus',
      name: `e2e-prom-test-${Date.now()}`,
      config: { url: PROM_URL },
    });
    cleanup.push(() => apiDelete(`/api/connectors/${created.connector.id}`));
    const result = await apiPost<TestResult>(`/api/connectors/${created.connector.id}/test`, {});
    expect(result.ok).toBe(true);
  }, 30_000);

  it('nonexistent host -> ok=false with DNS-like error', async () => {
    // The route returns 400 + ok:false on probe failure. The api client
    // throws ApiError on non-2xx, so we catch and inspect.
    let result: TestResult | null = null;
    try {
      const created = await apiPost<CreateConnectorResponse>('/api/connectors', {
        type: 'prometheus',
        name: `e2e-prom-bad-${Date.now()}`,
        config: { url: 'http://nonexistent.invalid.openobs-e2e:9090' },
      });
      cleanup.push(() => apiDelete(`/api/connectors/${created.connector.id}`));
      result = await apiPost<TestResult>(`/api/connectors/${created.connector.id}/test`, {});
    } catch (err) {
      if (err instanceof ApiError) {
        try { result = JSON.parse(err.bodyExcerpt) as TestResult; }
        catch { /* keep null */ }
      } else {
        throw err;
      }
    }
    expect(result, 'expected probe to return JSON body').toBeTruthy();
    expect(result!.ok).toBe(false);
    expect(result!.message).toMatch(/dns|enotfound|getaddrinfo|timeout|fetch failed|network/i);
  }, 30_000);
});
