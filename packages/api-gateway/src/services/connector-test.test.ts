/**
 * Unit tests for connector-test backend probes.
 *
 * fetch is stubbed globally per-test; no real network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from '@agentic-obs/common';
import { testConnectorAgainstBackend } from './connector-test.js';

function makeConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'conn_1',
    orgId: 'org_1',
    type: 'prometheus',
    name: 'Test',
    config: { url: 'https://prom.example' },
    status: 'draft',
    lastVerifiedAt: null,
    lastVerifyError: null,
    isDefault: false,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    capabilities: [],
    secretMissing: true,
    ...overrides,
  };
}

function jsonResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

type FetchSig = (url: string, init?: RequestInit) => Promise<Response>;
function mockFetch(impl: FetchSig) {
  return vi.fn<FetchSig>(impl);
}

describe('testConnectorAgainstBackend — http-get', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok:true on a 2xx response', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await testConnectorAgainstBackend(makeConnector(), null);
    expect(out.ok).toBe(true);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://prom.example/api/v1/query?query=vector(1)');
    expect((call[1] as RequestInit).headers).toEqual({});
  });

  it('returns ok:false on a 5xx response', async () => {
    vi.stubGlobal('fetch', mockFetch(async () => jsonResponse(500, 'boom')));
    const out = await testConnectorAgainstBackend(makeConnector(), null);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/HTTP 500/);
    expect(out.detail).toBe('boom');
  });

  it('returns ok:false with timeout message when fetch aborts', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(async (_url, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );
    vi.useFakeTimers();
    const promise = testConnectorAgainstBackend(makeConnector(), null);
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await promise;
    vi.useRealTimers();
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/timed out/);
  });

  it('forwards bearer token when secret + credential=token', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await testConnectorAgainstBackend(makeConnector(), 'sekret');
    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sekret',
    });
  });

  it('returns ok:false when url is missing', async () => {
    const out = await testConnectorAgainstBackend(
      makeConnector({ config: {} }),
      null,
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/no url configured/);
  });

  it('strips trailing slash from url before appending path', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await testConnectorAgainstBackend(
      makeConnector({ config: { url: 'https://prom.example/' } }),
      null,
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('https://prom.example/api/v1/query?query=vector(1)');
  });
});

describe('testConnectorAgainstBackend — humio-query', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a minimal query job with bearer token and repository path', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200, JSON.stringify({ id: 'job-1' })));
    vi.stubGlobal('fetch', fetchMock);
    const out = await testConnectorAgainstBackend(
      makeConnector({
        type: 'humio',
        config: { url: 'https://cloud.us.humio.com/api/v1', repository: 'prod' },
      }),
      'sekret',
    );
    expect(out.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cloud.us.humio.com/api/v1/repositories/prod/queryjobs');
    expect((opts as RequestInit).method).toBe('POST');
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sekret',
      'Content-Type': 'application/json',
    });
  });

  it('requires repository and token', async () => {
    const missingRepo = await testConnectorAgainstBackend(
      makeConnector({ type: 'humio', config: { url: 'https://humio.example' } }),
      'sekret',
    );
    expect(missingRepo.ok).toBe(false);
    expect(missingRepo.message).toMatch(/repository/);

    const missingToken = await testConnectorAgainstBackend(
      makeConnector({
        type: 'humio',
        config: { url: 'https://humio.example', repository: 'prod' },
      }),
      null,
    );
    expect(missingToken.ok).toBe(false);
    expect(missingToken.message).toMatch(/token/i);
  });
});

describe('testConnectorAgainstBackend — kubernetes-version', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses apiServer + token when apiServer is set', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    const out = await testConnectorAgainstBackend(
      makeConnector({
        type: 'kubernetes',
        config: { apiServer: 'https://kube.example/' },
      }),
      'users:\n- name: alice\n  user:\n    token: abc123\n',
    );
    expect(out.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kube.example/version');
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer abc123',
    });
  });

  it('fails clearly when apiServer is unset and not in-cluster', async () => {
    vi.stubGlobal('fetch', mockFetch(async () => jsonResponse(200)));
    const out = await testConnectorAgainstBackend(
      makeConnector({ type: 'kubernetes', config: {} }),
      null,
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/apiServer required/);
  });

  it('uses kubeconfig token directly when secret is a bare token (no users: block)', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await testConnectorAgainstBackend(
      makeConnector({
        type: 'kubernetes',
        config: { apiServer: 'https://kube.example' },
      }),
      'plain-bearer-value',
    );
    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer plain-bearer-value',
    });
  });

  it('can derive apiServer and token from a JSON kubeconfig secret', async () => {
    const fetchMock = mockFetch(async () => jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    const kubeconfig = JSON.stringify({
      clusters: [{ cluster: { server: 'https://kube.from-config' } }],
      users: [{ user: { token: 'token-from-json' } }],
    });
    const out = await testConnectorAgainstBackend(
      makeConnector({ type: 'kubernetes', config: {} }),
      kubeconfig,
    );
    expect(out.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://kube.from-config/version');
    expect((opts as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer token-from-json',
    });
  });
});

describe('testConnectorAgainstBackend — misc', () => {
  it('returns descriptive message for github-api verify kind (handled elsewhere)', async () => {
    const out = await testConnectorAgainstBackend(
      makeConnector({ type: 'github', config: {} }),
      null,
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Connect to GitHub/);
  });
});
