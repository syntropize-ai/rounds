/**
 * Setup smoke — POST /api/datasources/test (Ref PR #126).
 *
 * Two probes:
 *   1. healthy URL  -> ok=true.
 *   2. nonexistent host -> ok=false with a useful error category in the
 *      message (DNS / timeout / ENOTFOUND).
 */
import { describe, expect, it } from 'vitest';
import { apiPost, ApiError } from '../helpers/api-client.js';

interface TestResult { ok: boolean; message: string }

const PROM_URL =
  process.env['OPENOBS_TEST_PROM_URL'] ?? 'http://prometheus.openobs-e2e:9090';

describe('setup/datasource-test-connection', () => {
  it('healthy prometheus URL -> ok=true', async () => {
    const result = await apiPost<TestResult>('/api/datasources/test', {
      type: 'prometheus',
      url: PROM_URL,
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it('nonexistent host -> ok=false with DNS-like error', async () => {
    // The route returns 400 + ok:false on probe failure. The api client
    // throws ApiError on non-2xx, so we catch and inspect.
    let result: TestResult | null = null;
    try {
      result = await apiPost<TestResult>('/api/datasources/test', {
        type: 'prometheus',
        url: 'http://nonexistent.invalid.openobs-e2e:9090',
      });
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
