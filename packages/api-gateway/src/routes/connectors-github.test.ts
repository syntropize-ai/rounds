/**
 * /api/connectors/github router tests — manifest registration flow + install.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConnectorsGithubRouter } from './connectors-github.js';
import type { Connector, NewConnector } from '@agentic-obs/common';
import type {
  GithubAppConfig,
  IGithubAppConfigRepository,
  NewGithubAppConfig,
} from '@agentic-obs/data-layer';

function fakeConnector(input: NewConnector): Connector {
  return {
    id: input.id ?? 'conn_new',
    orgId: input.orgId,
    type: input.type,
    name: input.name,
    config: input.config ?? {},
    status: 'draft',
    lastVerifiedAt: null,
    lastVerifyError: null,
    isDefault: false,
    createdBy: input.createdBy,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    capabilities: [],
    secretMissing: true,
  };
}

class MemoryGithubAppConfigRepo implements IGithubAppConfigRepository {
  private store = new Map<string, GithubAppConfig>();
  seed(cfg: GithubAppConfig): void {
    this.store.set(cfg.orgId, cfg);
  }
  async get(orgId: string): Promise<GithubAppConfig | null> {
    return this.store.get(orgId) ?? null;
  }
  async insert(input: NewGithubAppConfig): Promise<GithubAppConfig> {
    const cfg: GithubAppConfig = { ...input, registeredAt: '2026-01-01T00:00:00Z' };
    this.store.set(input.orgId, cfg);
    return cfg;
  }
  async delete(orgId: string): Promise<boolean> {
    return this.store.delete(orgId);
  }
}

function sampleConfig(orgId = 'org_main'): GithubAppConfig {
  return {
    orgId,
    appId: 12345,
    slug: 'rounds-test',
    clientId: 'Iv1.abc',
    clientSecret: 'shh',
    privateKey: '-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----',
    webhookSecret: null,
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'u_1',
  };
}

interface MakeAppOpts {
  configured?: boolean;
  exchange?: typeof import('../services/github-app.js').exchangeInstallationForToken;
  listInstallations?: typeof import('../services/github-app.js').listGithubAppInstallations;
  convertManifest?: typeof import('../services/github-app.js').convertAppManifest;
  createConnector?: (input: NewConnector) => Promise<Connector>;
  upsertSecret?: (input: { connectorId: string; ciphertext: Uint8Array; keyVersion: number }) => Promise<unknown>;
  authed?: boolean;
  repo?: MemoryGithubAppConfigRepo;
}

function makeApp(opts: MakeAppOpts) {
  const repo = opts.repo ?? new MemoryGithubAppConfigRepo();
  if (opts.configured) repo.seed(sampleConfig());
  const app = express();
  if (opts.authed) {
    app.use((req, _res, next) => {
      (req as { auth?: unknown }).auth = {
        userId: 'u_1',
        orgId: 'org_main',
        orgRole: 'Admin',
        isServerAdmin: false,
        authenticatedBy: 'session',
      };
      next();
    });
  }
  app.use(
    '/api/connectors/github',
    createConnectorsGithubRouter({
      createConnector: opts.createConnector ?? (async (i) => fakeConnector(i)),
      upsertSecret: opts.upsertSecret ?? (async () => undefined),
      githubAppConfig: repo,
      appBaseUrl: 'https://app.example',
      ...(opts.exchange ? { exchange: opts.exchange } : {}),
      ...(opts.listInstallations ? { listInstallations: opts.listInstallations } : {}),
      ...(opts.convertManifest ? { convertManifest: opts.convertManifest } : {}),
    }),
  );
  return { app, repo };
}

describe('GET /api/connectors/github/registration-status', () => {
  it('returns registered:false when no config', async () => {
    const { app } = makeApp({ authed: true });
    const res = await request(app).get('/api/connectors/github/registration-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ registered: false });
  });
  it('returns slug when registered', async () => {
    const { app } = makeApp({ authed: true, configured: true });
    const res = await request(app).get('/api/connectors/github/registration-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ registered: true, slug: 'rounds-test', appId: 12345 });
  });
});

describe('GET /api/connectors/github/manifest', () => {
  it('returns a manifest with redirect/callback urls and a state', async () => {
    const { app } = makeApp({ authed: true });
    const res = await request(app).get('/api/connectors/github/manifest');
    expect(res.status).toBe(200);
    expect(res.body.manifestUrl).toBe('https://github.com/settings/apps/new');
    expect(typeof res.body.state).toBe('string');
    expect(res.body.state.length).toBeGreaterThan(16);
    const manifest = JSON.parse(res.body.manifest);
    expect(manifest.redirect_url).toBe('https://app.example/api/connectors/github/manifest-callback');
    expect(manifest.callback_urls).toEqual(['https://app.example/api/connectors/github/callback']);
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toMatchObject({
      contents: 'read',
      pull_requests: 'write',
    });
  });

  it('403 when there is no auth context', async () => {
    const { app } = makeApp({ authed: false });
    const res = await request(app).get('/api/connectors/github/manifest');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/connectors/github/manifest-callback', () => {
  it('exchanges code → config, persists row, redirects to ?github=registered', async () => {
    const { app, repo } = makeApp({
      authed: true,
      convertManifest: vi.fn(async () => ({
        appId: 999,
        slug: 'rounds-prod',
        clientId: 'Iv1.zzz',
        clientSecret: 'shh',
        privateKey: 'pem',
        webhookSecret: 'wh',
      })),
    });
    // First get a state from the /manifest endpoint
    const manifestRes = await request(app).get('/api/connectors/github/manifest');
    const state = manifestRes.body.state as string;

    const res = await request(app).get(`/api/connectors/github/manifest-callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://app.example/settings?github=registered');
    const cfg = await repo.get('org_main');
    expect(cfg).not.toBeNull();
    expect(cfg!.appId).toBe(999);
    expect(cfg!.slug).toBe('rounds-prod');
    expect(cfg!.webhookSecret).toBe('wh');
  });

  it('redirects to error when state is unknown', async () => {
    const { app } = makeApp({ authed: true });
    const res = await request(app).get('/api/connectors/github/manifest-callback?code=abc&state=mismatch');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('reason=invalid-state');
  });

  it('redirects to error when code or state is missing', async () => {
    const { app } = makeApp({ authed: true });
    const res = await request(app).get('/api/connectors/github/manifest-callback?code=abc');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('github=error');
  });
});

describe('GET /api/connectors/github/install-url', () => {
  it('503 when not registered', async () => {
    const { app } = makeApp({ authed: true });
    const res = await request(app).get('/api/connectors/github/install-url');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_REGISTERED');
  });

  it('returns the install URL with orgId as state when registered', async () => {
    const { app } = makeApp({ authed: true, configured: true });
    const res = await request(app).get('/api/connectors/github/install-url');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('rounds-test');
    expect(res.body.url).toContain('state=org_main');
  });

  it('403 when there is no org context', async () => {
    const { app } = makeApp({ authed: false, configured: true });
    const res = await request(app).get('/api/connectors/github/install-url');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/connectors/github/callback', () => {
  it('creates a connector + secret and redirects on success', async () => {
    const createConnector = vi.fn(async (i: NewConnector) => fakeConnector(i));
    const upsertSecret = vi.fn(async () => undefined);
    const exchange = vi.fn(async () => ({ token: 'ghs_xx', expiresAt: '2026-12-31T00:00:00Z', owner: 'acme' }));
    const { app } = makeApp({ configured: true, createConnector, upsertSecret, exchange });

    const res = await request(app).get('/api/connectors/github/callback?installation_id=42&state=org_main&setup_action=install');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://app.example/settings?github=connected');
    expect(createConnector).toHaveBeenCalledTimes(1);
    expect(createConnector.mock.calls[0]![0]).toMatchObject({
      type: 'github',
      orgId: 'org_main',
      name: 'acme (GitHub)',
      config: { owner: 'acme', installationId: '42' },
    });
    expect(upsertSecret).toHaveBeenCalledTimes(1);
  });

  it('redirects to error page when installation_id is missing', async () => {
    const { app } = makeApp({ configured: true });
    const res = await request(app).get('/api/connectors/github/callback?state=org_main');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('github=error');
  });

  it('redirects to error page when exchange fails', async () => {
    const exchange = vi.fn(async () => { throw new Error('boom'); });
    const { app } = makeApp({ configured: true, exchange });
    const res = await request(app).get('/api/connectors/github/callback?installation_id=42&state=org_main');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('reason=boom');
  });

  it('redirects to error when org has no registered app', async () => {
    const { app } = makeApp({ configured: false });
    const res = await request(app).get('/api/connectors/github/callback?installation_id=42&state=org_main');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toContain('github_not_registered');
  });
});

describe('POST /api/connectors/github/sync-installations', () => {
  it('creates connectors for installed GitHub App installations', async () => {
    const createConnector = vi.fn(async (i: NewConnector) => fakeConnector(i));
    const upsertSecret = vi.fn(async () => undefined);
    const exchange = vi.fn(async (_cfg, installationId: string) => ({
      token: `ghs_${installationId}`,
      expiresAt: '2026-12-31T00:00:00Z',
      owner: installationId === '42' ? 'acme' : 'beta',
    }));
    const listInstallations = vi.fn(async () => [
      { id: '42', owner: 'acme' },
      { id: '43', owner: 'beta' },
    ]);
    const { app } = makeApp({
      authed: true,
      configured: true,
      createConnector,
      upsertSecret,
      exchange,
      listInstallations,
    });

    const res = await request(app).post('/api/connectors/github/sync-installations').send({});
    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(2);
    expect(createConnector).toHaveBeenCalledTimes(2);
    expect(createConnector.mock.calls[0]![0]).toMatchObject({
      id: 'github-42',
      orgId: 'org_main',
      type: 'github',
      name: 'acme (GitHub)',
      config: { owner: 'acme', installationId: '42' },
      status: 'active',
    });
    expect(upsertSecret).toHaveBeenCalledTimes(2);
  });

  it('503 when syncing before registration', async () => {
    const { app } = makeApp({ authed: true, configured: false });
    const res = await request(app).post('/api/connectors/github/sync-installations').send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_REGISTERED');
  });
});
