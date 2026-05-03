import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContactPointIntegration } from '@agentic-obs/common';
import { webhookSender } from './webhook.js';
import type { AlertFiredEventPayload } from './types.js';

const payload: AlertFiredEventPayload = {
  ruleId: 'r1',
  ruleName: 'high-error-rate',
  orgId: 'org_main',
  severity: 'high',
  value: 0.12,
  threshold: 0.05,
  operator: '>',
  labels: { team: 'web' },
  firedAt: '2026-05-03T00:00:00Z',
  fingerprint: 'fp-1',
};

const integration: ContactPointIntegration = {
  id: 'wh',
  type: 'webhook',
  name: 'Generic',
  settings: { webhookUrl: 'https://example.com/hooks/x' },
};

describe('webhookSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = 'true';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses settings.webhookUrl when settings.url is absent', async () => {
    const result = await webhookSender(integration, payload);
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('example.com/hooks/x');
  });
});
