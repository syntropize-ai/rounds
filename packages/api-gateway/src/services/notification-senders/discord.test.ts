import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ContactPointIntegration } from '@agentic-obs/common';
import { discordSender } from './discord.js';
import type { AlertFiredEventPayload } from './types.js';

const payload: AlertFiredEventPayload = {
  ruleId: 'r1',
  ruleName: 'high-error-rate',
  orgId: 'org_main',
  severity: 'medium',
  value: 0.07,
  threshold: 0.05,
  operator: '>',
  labels: { team: 'data' },
  firedAt: '2026-05-03T00:00:00Z',
  fingerprint: 'fp-1',
};

const integration: ContactPointIntegration = {
  id: 'd',
  type: 'discord',
  name: 'Discord',
  settings: { url: 'https://discord.com/api/webhooks/abc' },
};

describe('discordSender', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env['OPENOBS_ALLOW_PRIVATE_URLS'] = 'true';
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs the alert body JSON to the discord webhook', async () => {
    const result = await discordSender(integration, payload);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('discord.com');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toContain('high-error-rate');
  });
});
