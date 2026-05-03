import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContactPointIntegration } from '@agentic-obs/common';
import { slackSender } from './slack.js';
import type { AlertFiredEventPayload } from './types.js';

const integration: ContactPointIntegration = {
  id: 'slack-1',
  type: 'slack',
  name: 'Slack #incidents',
  settings: { url: 'https://hooks.slack.com/services/abc' },
};

const payload: AlertFiredEventPayload = {
  ruleId: 'r1',
  ruleName: 'high-error-rate',
  orgId: 'org_main',
  severity: 'critical',
  value: 0.42,
  threshold: 0.05,
  operator: '>',
  labels: { team: 'web', env: 'prod' },
  firedAt: '2026-05-03T00:00:00Z',
  fingerprint: 'fp-1',
};

describe('slackSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // Bypass SSRF host resolution in tests by allowing private URLs.
    process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = 'true';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs JSON to the configured webhook URL', async () => {
    const result = await slackSender(integration, payload);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('hooks.slack.com');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toContain('CRITICAL');
    expect(body.text).toContain('high-error-rate');
    expect(body.text).toContain('team=web');
    expect(body.username).toBe('Agentic Obs');
  });

  it('returns ok:false when the response is non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const result = await slackSender(integration, payload);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('500');
  });

  it('returns ok:false when no URL is configured', async () => {
    const result = await slackSender({ ...integration, settings: {} }, payload);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No webhook URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
