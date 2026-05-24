import { describe, it, expect, vi } from 'vitest';
import type {
  Connector,
  ConnectorLookupOptions,
  ConnectorPolicy,
  Identity,
  ListConnectorPoliciesOptions,
  ListConnectorsOptions,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import { GithubToolRunner } from './github-tool-runner.js';

function mkConnector(overrides: Partial<Connector> = {}): Connector {
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

const IDENTITY: Identity = {
  userId: 'u1',
  orgId: 'org_a',
  orgRole: 'Admin',
  isServerAdmin: false,
  authenticatedBy: 'session',
};

function fakeRepo(state: {
  connectors: Connector[];
  policies?: ConnectorPolicy[];
}): IConnectorRepository {
  return {
    list: async (opts: ListConnectorsOptions) =>
      state.connectors.filter((c) => c.orgId === opts.orgId),
    get: async (id: string, opts: ConnectorLookupOptions) =>
      state.connectors.find((c) => c.id === id && c.orgId === opts.orgId) ?? null,
    create: async () => { throw new Error('not used'); },
    update: async () => null,
    delete: async () => false,
    count: async () => state.connectors.length,
    findByCapability: async () => [],
    getSecret: async () => null,
    upsertSecret: async () => { throw new Error('not used'); },
    deleteSecret: async () => false,
    listPolicies: async (opts: ListConnectorPoliciesOptions) => {
      const rows = state.policies ?? [];
      return rows.filter(
        (p) =>
          p.connectorId === opts.connectorId &&
          (opts.capability === undefined || p.capability === opts.capability),
      );
    },
    getPolicy: async () => null,
    upsertPolicy: async () => { throw new Error('not used'); },
    deletePolicy: async () => false,
  };
}

interface FakeTokenSvc {
  getInstallationToken(orgId: string, connectorId: string): Promise<string>;
}

function tokenSvc(token = 'ghs_test'): FakeTokenSvc {
  return { getInstallationToken: async () => token };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mkPolicy(capability: string, humanPolicy: 'allow' | 'ask' | 'block'): ConnectorPolicy {
  return {
    connectorId: 'gh-org',
    subjectType: 'org',
    subjectId: 'org_a',
    capability,
    humanPolicy,
    grafanaScope: null,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'u1',
  };
}

describe('GithubToolRunner', () => {
  describe('connector resolution', () => {
    it('defaults to the single github connector when no id is provided', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ repositories: [] }));
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('0 repos');
      expect(fetchImpl).toHaveBeenCalled();
    });

    it('errors when multiple github connectors exist and no id is provided', async () => {
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({
          connectors: [mkConnector({ id: 'gh-a', name: 'A' }), mkConnector({ id: 'gh-b', name: 'B' })],
        }),
        orgId: 'org_a',
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('Multiple GitHub connectors');
      expect(r.observation).toContain('gh-a (A)');
      expect(r.observation).toContain('gh-b (B)');
    });

    it('errors when no github connector is configured', async () => {
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [] }),
        orgId: 'org_a',
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('No GitHub connector configured');
    });

    it('errors when an explicit connectorId points to a non-github connector', async () => {
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({
          connectors: [mkConnector({ id: 'kube', type: 'kubernetes', name: 'Prod' })],
        }),
        orgId: 'org_a',
      });
      const r = await runner.listRepos({ connectorId: 'kube', identity: IDENTITY });
      expect(r.observation).toContain('not "github"');
    });
  });

  describe('policy gate', () => {
    it('blocks when org policy says block on vcs.repo.read', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ repositories: [] }));
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({
          connectors: [mkConnector()],
          policies: [mkPolicy('vcs.repo.read', 'block')],
        }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('Blocked by connector policy');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('listRepos', () => {
    it('shapes the response into owner/name/private rows', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          repositories: [
            {
              full_name: 'acme/web',
              name: 'web',
              owner: { login: 'acme' },
              private: true,
              default_branch: 'main',
              description: 'web app',
            },
          ],
        }),
      );
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('acme/web');
      expect(r.data).toEqual([
        {
          owner: 'acme',
          name: 'web',
          fullName: 'acme/web',
          private: true,
          defaultBranch: 'main',
          description: 'web app',
        },
      ]);
    });
  });

  describe('listPrs / getPr', () => {
    it('listPrs shapes PR rows', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse([
          {
            number: 42,
            title: 'add KB tab',
            state: 'open',
            user: { login: 'alice' },
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-02T00:00:00Z',
            head: { ref: 'feat/kb' },
            base: { ref: 'main' },
            html_url: 'https://github.com/acme/web/pull/42',
            draft: false,
          },
        ]),
      );
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.listPrs({ owner: 'acme', repo: 'web', identity: IDENTITY });
      expect(r.data).toMatchObject([
        { number: 42, author: 'alice', headBranch: 'feat/kb', baseBranch: 'main' },
      ]);
    });

    it('getPr returns 404 observation when GitHub 404s', async () => {
      const fetchImpl = vi.fn(async () =>
        new Response('not found', { status: 404 }),
      );
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.getPr({ owner: 'acme', repo: 'web', number: 9999, identity: IDENTITY });
      expect(r.observation).toContain('not found');
    });
  });

  describe('auth error', () => {
    it('maps 401 to a reconnect-instruction observation', async () => {
      const fetchImpl = vi.fn(async () => new Response('Bad credentials', { status: 401 }));
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.listRepos({ identity: IDENTITY });
      expect(r.observation).toContain('GitHub auth failed');
      expect(r.observation).toContain('Reconnect');
    });
  });

  describe('getDiff', () => {
    it('returns the raw diff text on success', async () => {
      const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n';
      const fetchImpl = vi.fn(async () =>
        new Response(diff, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.getDiff({ owner: 'acme', repo: 'web', number: 1, identity: IDENTITY });
      expect(r.observation).toBe(diff);
      expect(r.truncated).toBeUndefined();
    });

    it('truncates with a marker when the diff exceeds the cap', async () => {
      const big = 'a'.repeat(300 * 1024);
      const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
      const runner = new GithubToolRunner({
        tokens: tokenSvc() as never,
        connectors: fakeRepo({ connectors: [mkConnector()] }),
        orgId: 'org_a',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const r = await runner.getDiff({ owner: 'acme', repo: 'web', number: 1, identity: IDENTITY });
      expect(r.truncated).toBe(true);
      expect(r.observation).toContain('[diff truncated at');
      // Body is capped at 256 KB + the marker line.
      expect(r.observation.length).toBeLessThan(big.length);
    });
  });
});
