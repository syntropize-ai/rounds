import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type {
  Connector,
  ConnectorLookupOptions,
  ConnectorSecret,
  ConnectorPolicy,
  ListConnectorPoliciesOptions,
  ListConnectorsOptions,
} from '@agentic-obs/common';
import type {
  GithubAppConfig,
  IConnectorRepository,
  IGithubAppConfigRepository,
  NewGithubAppConfig,
} from '@agentic-obs/data-layer';
import { GithubAppTokenService } from './github-app-token-service.js';

function genPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

function mkAppConfig(overrides: Partial<GithubAppConfig> = {}): GithubAppConfig {
  return {
    orgId: 'org_a',
    appId: 12345,
    slug: 'rounds-test',
    clientId: 'Iv1.test',
    clientSecret: 'shh',
    privateKey: genPrivateKey(),
    webhookSecret: null,
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'u1',
    ...overrides,
  };
}

function mkGithubConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'gh-org',
    orgId: 'org_a',
    type: 'github',
    name: 'Org (GitHub)',
    config: { installationId: '777' },
    status: 'active',
    lastVerifiedAt: null,
    lastVerifyError: null,
    isDefault: false,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    capabilities: [],
    secretMissing: false,
    ...overrides,
  };
}

function fakeAppConfigRepo(cfg: GithubAppConfig | null): IGithubAppConfigRepository {
  return {
    get: async () => cfg,
    insert: async (input: NewGithubAppConfig) => ({ ...input, registeredAt: 'x' }),
    delete: async () => true,
  };
}

function fakeConnectorRepo(connectors: Connector[]): IConnectorRepository {
  return {
    list: async (opts: ListConnectorsOptions) =>
      connectors.filter((c) => c.orgId === opts.orgId),
    get: async (id: string, opts: ConnectorLookupOptions) =>
      connectors.find((c) => c.id === id && c.orgId === opts.orgId) ?? null,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => null,
    delete: async () => false,
    count: async () => connectors.length,
    findByCapability: async () => [],
    getSecret: async (): Promise<ConnectorSecret | null> => null,
    upsertSecret: async () => {
      throw new Error('not used');
    },
    deleteSecret: async () => false,
    listPolicies: async (_opts: ListConnectorPoliciesOptions): Promise<ConnectorPolicy[]> => [],
    getPolicy: async () => null,
    upsertPolicy: async () => {
      throw new Error('not used');
    },
    deletePolicy: async () => false,
  };
}

function fakeFetchOk(payload: { token: string; expiresAt: string }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ token: payload.token, expires_at: payload.expiresAt }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('GithubAppTokenService', () => {
  it('mints an installation token and returns its value', async () => {
    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(mkAppConfig()),
      connectors: fakeConnectorRepo([mkGithubConnector()]),
      fetchImpl: fakeFetchOk({ token: 'ghs_abc', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      now: () => Date.now(),
    });
    const t = await svc.getInstallationToken('org_a', 'gh-org');
    expect(t).toBe('ghs_abc');
  });

  it('caches the token across calls (no refetch within validity)', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'ghs_one', expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
        status: 200,
      }),
    );
    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(mkAppConfig()),
      connectors: fakeConnectorRepo([mkGithubConnector()]),
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await svc.getInstallationToken('org_a', 'gh-org');
    await svc.getInstallationToken('org_a', 'gh-org');
    await svc.getInstallationToken('org_a', 'gh-org');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes when cached token is within the margin of expiry', async () => {
    let nowMs = 1_000_000_000_000;
    const issueExpiry = new Date(nowMs + 60_000).toISOString();
    let mintCount = 0;
    const fetchImpl = (async () => {
      mintCount += 1;
      return new Response(
        JSON.stringify({ token: `ghs_${mintCount}`, expires_at: issueExpiry }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(mkAppConfig()),
      connectors: fakeConnectorRepo([mkGithubConnector()]),
      fetchImpl,
      now: () => nowMs,
    });

    const a = await svc.getInstallationToken('org_a', 'gh-org');
    expect(a).toBe('ghs_1');
    // Advance past the 60s refresh margin — token should be reminted.
    nowMs += 10_000;
    const b = await svc.getInstallationToken('org_a', 'gh-org');
    expect(b).toBe('ghs_2');
  });

  it('produces an RS256 JWT whose iss claim is the appId', async () => {
    const captured: { headers?: Record<string, string> } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured.headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ token: 'ghs_xyz', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = mkAppConfig({ appId: 99999 });
    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(cfg),
      connectors: fakeConnectorRepo([mkGithubConnector()]),
      fetchImpl,
    });
    await svc.getInstallationToken('org_a', 'gh-org');

    const auth = captured.headers?.['Authorization'] ?? '';
    expect(auth.startsWith('Bearer ')).toBe(true);
    const jwt = auth.slice('Bearer '.length);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe(String(cfg.appId));
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('throws when the connector is missing', async () => {
    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(mkAppConfig()),
      connectors: fakeConnectorRepo([]),
      fetchImpl: fakeFetchOk({ token: 't', expiresAt: 'x' }),
    });
    await expect(svc.getInstallationToken('org_a', 'gh-org')).rejects.toThrow(/not found/);
  });

  it('throws when the github app is not registered for the org', async () => {
    const svc = new GithubAppTokenService({
      githubAppConfig: fakeAppConfigRepo(null),
      connectors: fakeConnectorRepo([mkGithubConnector()]),
      fetchImpl: fakeFetchOk({ token: 't', expiresAt: 'x' }),
    });
    await expect(svc.getInstallationToken('org_a', 'gh-org')).rejects.toThrow(/not registered/);
  });
});
