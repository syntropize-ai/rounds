import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContactPointIntegration } from '@agentic-obs/common';
import { teamsSender } from './teams.js';
import type { AlertFiredEventPayload } from './types.js';

const payload: AlertFiredEventPayload = {
  ruleId: 'r1',
  ruleName: 'high-error-rate',
  orgId: 'org_main',
  severity: 'low',
  value: 0.06,
  threshold: 0.05,
  operator: '>',
  labels: {},
  firedAt: '2026-05-03T00:00:00Z',
  fingerprint: 'fp-1',
};

const integration: ContactPointIntegration = {
  id: 't',
  type: 'teams',
  name: 'Teams',
  settings: { url: 'https://outlook.office.com/webhook/xyz' },
};

describe('teamsSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = 'true';
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs to the teams webhook with the alert text', async () => {
    const result = await teamsSender(integration, payload);
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('outlook.office.com');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toContain('LOW');
  });
});
