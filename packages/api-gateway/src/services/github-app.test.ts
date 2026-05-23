/**
 * Unit tests for the GitHub App helpers (config-based — no env vars).
 */

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GithubAppConfig } from '@agentic-obs/data-layer';
import {
  buildInstallUrl,
  convertAppManifest,
  exchangeInstallationForToken,
  signAppJwt,
} from './github-app.js';

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function makeConfig(privateKey: string): GithubAppConfig {
  return {
    orgId: 'org_main',
    appId: 12345,
    slug: 'rounds-test',
    clientId: 'Iv1.abc',
    clientSecret: 'shh',
    privateKey,
    webhookSecret: null,
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'u_1',
  };
}

describe('buildInstallUrl', () => {
  it('includes state param and slug', () => {
    const { privateKey } = makeKeyPair();
    const url = buildInstallUrl(makeConfig(privateKey), 'org_abc');
    expect(url).toBe(
      'https://github.com/apps/rounds-test/installations/new?state=org_abc',
    );
  });
});

describe('signAppJwt', () => {
  it('produces a 3-part RS256 JWT signed with the private key', () => {
    const { publicKey, privateKey } = makeKeyPair();
    const jwt = signAppJwt(makeConfig(privateKey));
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(payload.iss).toBe('12345');
    expect(typeof payload.exp).toBe('number');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    const sig = Buffer.from(parts[2]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(verifier.verify(publicKey, sig)).toBe(true);
  });
});

describe('exchangeInstallationForToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints an installation token and surfaces owner login', async () => {
    const { privateKey } = makeKeyPair();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/access_tokens')) {
        return new Response(
          JSON.stringify({ token: 'ghs_123', expires_at: '2026-12-31T00:00:00Z' }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ account: { login: 'acme' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await exchangeInstallationForToken(makeConfig(privateKey), '999');
    expect(result).toEqual({
      token: 'ghs_123',
      expiresAt: '2026-12-31T00:00:00Z',
      owner: 'acme',
    });
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('throws when installation lookup fails', async () => {
    const { privateKey } = makeKeyPair();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(
      exchangeInstallationForToken(makeConfig(privateKey), '999'),
    ).rejects.toThrow(/lookup failed/);
  });
});

describe('convertAppManifest', () => {
  it('parses the GitHub manifest conversion response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        id: 777,
        slug: 'rounds-org',
        client_id: 'Iv1.def',
        client_secret: 'sec',
        pem: '-----BEGIN PRIVATE KEY-----\nXX\n-----END PRIVATE KEY-----',
        webhook_secret: 'wh',
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
    const result = await convertAppManifest('codeAbc', fetchImpl);
    expect(result).toEqual({
      appId: 777,
      slug: 'rounds-org',
      clientId: 'Iv1.def',
      clientSecret: 'sec',
      privateKey: '-----BEGIN PRIVATE KEY-----\nXX\n-----END PRIVATE KEY-----',
      webhookSecret: 'wh',
    });
  });

  it('throws when GitHub returns non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    await expect(convertAppManifest('code', fetchImpl)).rejects.toThrow(/manifest conversion failed/);
  });

  it('throws when response is missing required fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 })) as unknown as typeof fetch;
    await expect(convertAppManifest('code', fetchImpl)).rejects.toThrow(/missing required fields/);
  });
});
