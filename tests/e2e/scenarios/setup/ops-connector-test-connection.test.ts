/**
 * Setup smoke — POST /api/connectors/:id/test (Ref PR #120).
 *
 * The seeded "e2e" in-cluster connector should probe successfully via
 * `kubectl version`. Reads the seeded connector id from .state.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPost, apiGet, ApiError } from '../helpers/api-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, '..', '..', '.state');

interface TestResp {
  status: 'connected' | 'degraded' | 'error';
  message?: string;
  checks?: {
    structure?: 'ok' | 'failed';
    credentials?: 'ok' | 'missing';
    runner?: 'ok' | 'failed' | 'skipped';
  };
}
interface ConnectorList { connectors: Array<{ id: string; name: string }> }

function seededConnectorId(): string | null {
  try {
    const raw = readFileSync(resolve(STATE, 'ops-connector-id'), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

describe('setup/ops-connector-test-connection', () => {
  it('in-cluster connector probe reports a categorized status', async () => {
    let id = seededConnectorId();
    if (!id) {
      // Fallback: discover from list endpoint.
      const list = await apiGet<ConnectorList>('/api/connectors');
      id = list.connectors.find((c) => c.name === 'e2e')?.id ?? null;
    }
    expect(id, 'seeded e2e connector id (.state/ops-connector-id)').toBeTruthy();

    // The route returns 400 when the runner reports `error`. Capture the
    // response body off the ApiError so we can still assert the
    // categorized shape.
    let result: TestResp;
    try {
      result = await apiPost<TestResp>(`/api/connectors/${id}/test`, {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        result = JSON.parse(err.bodyExcerpt) as TestResp;
      } else {
        throw err;
      }
    }
    expect(['connected', 'degraded', 'error']).toContain(result.status);
    expect(result.checks?.structure).toBe('ok');
    if (result.status !== 'connected') {
      // Failure must always carry a `runner` status — never an opaque crash.
      expect(['ok', 'failed', 'skipped']).toContain(result.checks?.runner);
    }
  }, 60_000);
});
