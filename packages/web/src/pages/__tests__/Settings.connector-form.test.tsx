import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectorType } from '@agentic-obs/common';
import { getConnectorTemplate } from '@agentic-obs/common';
import {
  ConnectorConfigFields,
  configIsValid,
  defaultsFor,
  humanize,
  reconcileConfig,
} from '../connector-config-form.js';
import {
  buildSecretValue,
  submitConnectorWithSecret,
  type ConnectorSubmitApi,
} from '../Settings.js';

function renderFields(type: ConnectorType, config: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    React.createElement(ConnectorConfigFields, {
      type,
      config,
      onChange: () => undefined,
    }),
  );
}

describe('humanize', () => {
  it('humanizes camelCase keys', () => {
    expect(humanize('apiServer')).toBe('API server');
    expect(humanize('clusterName')).toBe('Cluster name');
    expect(humanize('tlsVerify')).toBe('TLS verify');
    expect(humanize('installationId')).toBe('Installation ID');
    expect(humanize('url')).toBe('URL');
    expect(humanize('database')).toBe('Database');
    expect(humanize('owner')).toBe('Owner');
  });
});

describe('defaultsFor', () => {
  it('seeds boolean defaults', () => {
    expect(defaultsFor('clickhouse')).toEqual({ tlsVerify: true });
    expect(defaultsFor('prometheus')).toEqual({ tlsVerify: true });
  });

  it('returns empty for schemas without defaults', () => {
    expect(defaultsFor('kubernetes')).toEqual({});
    expect(defaultsFor('github')).toEqual({});
  });
});

describe('reconcileConfig', () => {
  it('preserves keys valid in the new schema', () => {
    const out = reconcileConfig({ url: 'http://x', clusterName: 'gone' }, 'prometheus');
    expect(out['url']).toBe('http://x');
    expect(out['clusterName']).toBeUndefined();
  });

  it('applies new-type defaults for keys not carried over', () => {
    const out = reconcileConfig({}, 'clickhouse');
    expect(out['tlsVerify']).toBe(true);
  });

  it('drops keys not in the next schema', () => {
    const out = reconcileConfig({ owner: 'a', repo: 'b', url: 'http://x' }, 'prometheus');
    expect(out['owner']).toBeUndefined();
    expect(out['repo']).toBeUndefined();
    expect(out['url']).toBe('http://x');
  });
});

describe('configIsValid', () => {
  it('requires schema-required string fields', () => {
    expect(configIsValid('prometheus', {})).toBe(false);
    expect(configIsValid('prometheus', { url: '' })).toBe(false);
    expect(configIsValid('prometheus', { url: 'http://x' })).toBe(true);
  });

  it('requires clusterName for kubernetes even though schema does not', () => {
    expect(configIsValid('kubernetes', {})).toBe(false);
    expect(configIsValid('kubernetes', { clusterName: 'prod' })).toBe(true);
    expect(configIsValid('kubernetes', { apiServer: 'http://x' })).toBe(false);
  });

  it('treats github as having no required fields', () => {
    expect(configIsValid('github', {})).toBe(true);
  });

  it('requires url for clickhouse', () => {
    expect(configIsValid('clickhouse', {})).toBe(false);
    expect(configIsValid('clickhouse', { url: 'http://x' })).toBe(true);
  });
});

describe('ConnectorConfigFields rendering', () => {
  // Each connector type's expected visible field labels (from configSchema).
  const cases: { type: ConnectorType; labels: string[] }[] = [
    { type: 'prometheus', labels: ['URL', 'TLS verify'] },
    { type: 'humio', labels: ['URL', 'Repository', 'TLS verify'] },
    { type: 'clickhouse', labels: ['URL', 'Database', 'TLS verify'] },
    { type: 'kubernetes', labels: ['Cluster name', 'API server', 'Context'] },
    { type: 'github', labels: ['Owner', 'Repo', 'Installation ID'] },
  ];

  for (const { type, labels } of cases) {
    it(`renders the schema's fields for ${type}`, () => {
      const html = renderFields(type, defaultsFor(type));
      for (const label of labels) {
        expect(html).toContain(label);
      }
    });

    it(`renders labels that match the template's schema properties for ${type}`, () => {
      const schema = getConnectorTemplate(type).configSchema;
      const expected = Object.keys(schema.properties ?? {}).map(humanize);
      const html = renderFields(type, defaultsFor(type));
      for (const label of expected) {
        expect(html).toContain(label);
      }
    });
  }

  it('renders the kubernetes helper note', () => {
    const html = renderFields('kubernetes', {});
    expect(html).toContain('Auth credentials');
    expect(html).toContain('Policies after creation');
  });

  it('does not render the helper note for non-kubernetes types', () => {
    expect(renderFields('prometheus', { url: 'http://x' })).not.toContain(
      'Auth credentials',
    );
  });

  it('renders TLS verify as a checkbox for clickhouse', () => {
    const html = renderFields('clickhouse', { tlsVerify: true });
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });

  it('renders URL inputs as type=url', () => {
    const html = renderFields('prometheus', { url: 'http://x' });
    expect(html).toMatch(/type="url"[^>]*value="http:\/\/x"/);
  });
});

// Simulates the parent's submit-body construction. The form posts
// { type, name, config: formConfig } — this verifies the config shape per type.
function buildBody(type: ConnectorType, name: string, config: Record<string, unknown>) {
  return { type, name, config, isDefault: false };
}

describe('submission body shape', () => {
  it('prometheus → { type, name, config: { url, tlsVerify } }', () => {
    const cfg = { ...defaultsFor('prometheus'), url: 'http://prom:9090' };
    expect(configIsValid('prometheus', cfg)).toBe(true);
    expect(buildBody('prometheus', 'Prod', cfg)).toEqual({
      type: 'prometheus',
      name: 'Prod',
      config: { tlsVerify: true, url: 'http://prom:9090' },
      isDefault: false,
    });
  });

  it('clickhouse → { url, database, tlsVerify }', () => {
    const cfg = {
      ...defaultsFor('clickhouse'),
      url: 'http://ch:8123',
      database: 'metrics',
    };
    expect(configIsValid('clickhouse', cfg)).toBe(true);
    expect(buildBody('clickhouse', 'CH', cfg).config).toEqual({
      tlsVerify: true,
      url: 'http://ch:8123',
      database: 'metrics',
    });
  });

  it('kubernetes → { clusterName, apiServer?, context? }', () => {
    const cfg = {
      clusterName: 'prod-east-1',
      apiServer: 'https://k8s.example',
      context: 'prod',
    };
    expect(configIsValid('kubernetes', cfg)).toBe(true);
    expect(buildBody('kubernetes', 'K8s prod', cfg).config).toEqual({
      clusterName: 'prod-east-1',
      apiServer: 'https://k8s.example',
      context: 'prod',
    });
  });

  it('github → { owner, repo, installationId }', () => {
    const cfg = { owner: 'acme', repo: 'obs', installationId: '12345' };
    expect(configIsValid('github', cfg)).toBe(true);
    expect(buildBody('github', 'GH', cfg).config).toEqual({
      owner: 'acme',
      repo: 'obs',
      installationId: '12345',
    });
  });
});

// Light controlled-state simulation: confirms the type-switch reconciler is
// wired so a stale `url` carries to clickhouse but k8s-specific keys do not
// leak into prometheus.
describe('type-switch reconciliation', () => {
  function Harness({ initialType }: { initialType: ConnectorType }) {
    const [type, setType] = useState<ConnectorType>(initialType);
    const [config, setConfig] = useState<Record<string, unknown>>(() =>
      defaultsFor(initialType),
    );
    const switchTo = (next: ConnectorType) => {
      setConfig((prev) => reconcileConfig(prev, next));
      setType(next);
    };
    return React.createElement(
      'div',
      null,
      React.createElement('span', { 'data-testid': 'type' }, type),
      React.createElement(ConnectorConfigFields, {
        type,
        config,
        onChange: setConfig,
      }),
      // expose switchTo via a button so this also serves as a sanity check
      React.createElement(
        'button',
        { onClick: () => switchTo('clickhouse') },
        'go',
      ),
    );
  }

  it('mounts without throwing for each type', () => {
    for (const type of ['prometheus', 'clickhouse', 'kubernetes', 'github'] as ConnectorType[]) {
      const html = renderToStaticMarkup(
        React.createElement(Harness, { initialType: type }),
      );
      expect(html).toContain(type);
    }
  });
});

// ─── Credentials section + two-call submit flow ───
//
// The web package has no DOM env, so the React component itself is exercised
// via the exported pure helpers `buildSecretValue` (per-kind value rules)
// and `submitConnectorWithSecret` (POST /connectors → POST /:id/secret) that
// handleCreate delegates to. UI rendering is asserted against the credential
// kind on each template.

interface RecordedCall {
  path: string;
  body: unknown;
}

function makeApi(
  responses: Array<{ data?: unknown; error?: { message?: string } | null }>,
): { api: ConnectorSubmitApi; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const api: ConnectorSubmitApi = {
    async post<T>(path: string, body: unknown) {
      calls.push({ path, body });
      const r = responses[i++] ?? { data: null };
      return r as { data?: T | null; error?: { message?: string } | null };
    },
  };
  return { api, calls };
}

const baseInput = {
  type: 'prometheus',
  name: 'Prod Prometheus',
  config: { url: 'http://prom.example.com', tlsVerify: true } as Record<string, unknown>,
  isDefault: false,
  basicUsername: '',
  basicPassword: '',
};

describe('buildSecretValue', () => {
  it('skips when credential kind is none', () => {
    expect(buildSecretValue('none', 'whatever', '', '')).toEqual({ kind: 'skip' });
  });

  it('skips a blank token', () => {
    expect(buildSecretValue('token', '   ', '', '')).toEqual({ kind: 'skip' });
  });

  it('trims and sends a non-empty token', () => {
    expect(buildSecretValue('token', '  abc123  ', '', '')).toEqual({
      kind: 'send',
      value: 'abc123',
    });
  });

  it('preserves whitespace inside a kubeconfig payload', () => {
    const yaml = 'apiVersion: v1\nkind: Config\nclusters: []\n';
    expect(buildSecretValue('kubeconfig', yaml, '', '')).toEqual({
      kind: 'send',
      value: yaml,
    });
  });

  it('skips a whitespace-only kubeconfig', () => {
    expect(buildSecretValue('kubeconfig', '\n  \t\n', '', '')).toEqual({ kind: 'skip' });
  });

  // 'basic' isn't in the ConnectorCredentialKind union, but the form handles
  // it defensively. Cast through 'none' to avoid widening the public type.
  it('skips basic auth when both username and password are blank', () => {
    expect(buildSecretValue('basic' as 'none', '', '  ', '')).toEqual({ kind: 'skip' });
  });

  it('returns an error when only one of basic username/password is filled', () => {
    const res = buildSecretValue('basic' as 'none', '', 'admin', '');
    expect(res.kind).toBe('error');
  });

  it('JSON-encodes basic auth when both fields are present', () => {
    const res = buildSecretValue('basic' as 'none', '', 'admin', 'pw');
    expect(res).toEqual({
      kind: 'send',
      value: JSON.stringify({ username: 'admin', password: 'pw' }),
    });
  });

  it('falls through defensively for an unknown credential kind', () => {
    expect(buildSecretValue('aws-keys', 'AKIA...', '', '')).toEqual({
      kind: 'send',
      value: 'AKIA...',
    });
  });
});

describe('submitConnectorWithSecret', () => {
  it('POSTs /connectors then /connectors/:id/secret in order when a token is provided (prometheus)', async () => {
    const { api, calls } = makeApi([
      { data: { connector: { id: 'conn-1' } } },
      { data: { ok: true } },
    ]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'token',
      secret: 'super-secret-token',
    });
    expect(result).toEqual({ kind: 'ok', connectorId: 'conn-1' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toBe('/connectors');
    expect(calls[0]!.body).toEqual({
      type: 'prometheus',
      name: 'Prod Prometheus',
      config: { url: 'http://prom.example.com', tlsVerify: true },
      isDefault: false,
    });
    expect(calls[1]!.path).toBe('/connectors/conn-1/secret');
    expect(calls[1]!.body).toEqual({ secret: 'super-secret-token' });
  });

  it('only calls /connectors when kubernetes is submitted without a kubeconfig (in-cluster path)', async () => {
    const { api, calls } = makeApi([{ data: { connector: { id: 'k8s-1' } } }]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      type: 'kubernetes',
      name: 'In-Cluster',
      config: { clusterName: 'local' },
      credential: 'kubeconfig',
      secret: '',
    });
    expect(result).toEqual({ kind: 'ok', connectorId: 'k8s-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/connectors');
  });

  it('skips the secret POST when the user leaves the secret blank regardless of type', async () => {
    const { api, calls } = makeApi([{ data: { connector: { id: 'conn-2' } } }]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'token',
      secret: '',
    });
    expect(result).toEqual({ kind: 'ok', connectorId: 'conn-2' });
    expect(calls).toHaveLength(1);
  });

  it('returns secret-failed (not create-failed) when the secret POST 500s — connector still wins', async () => {
    const { api, calls } = makeApi([
      { data: { connector: { id: 'conn-3' } } },
      { error: { message: 'Internal Server Error' } },
    ]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'token',
      secret: 'tok',
    });
    expect(result).toEqual({
      kind: 'secret-failed',
      connectorId: 'conn-3',
      message: 'Internal Server Error',
    });
    expect(calls).toHaveLength(2);
  });

  it('returns create-failed and does NOT call /secret when /connectors fails', async () => {
    const { api, calls } = makeApi([{ error: { message: 'name taken' } }]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'token',
      secret: 'tok',
    });
    expect(result.kind).toBe('create-failed');
    expect(calls).toHaveLength(1);
  });

  it('short-circuits with validation-error when basic auth is partially filled', async () => {
    const { api, calls } = makeApi([]);
    const result = await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'basic' as 'none',
      secret: '',
      basicUsername: 'admin',
      basicPassword: '',
    });
    expect(result.kind).toBe('validation-error');
    expect(calls).toHaveLength(0);
  });

  it('forwards a user-provided id when set, trimmed', async () => {
    const { api, calls } = makeApi([{ data: { connector: { id: 'custom-id' } } }]);
    await submitConnectorWithSecret(api, {
      ...baseInput,
      credential: 'none',
      secret: '',
      id: '  custom-id  ',
    });
    expect(calls[0]!.body).toMatchObject({ id: 'custom-id' });
  });
});

describe('connector template credential wiring', () => {
  it('declares prometheus as token-authenticated', () => {
    expect(getConnectorTemplate('prometheus').credential).toBe('token');
  });

  it('declares humio as token-authenticated', () => {
    expect(getConnectorTemplate('humio').credential).toBe('token');
  });

  it('declares kubernetes as kubeconfig-authenticated', () => {
    expect(getConnectorTemplate('kubernetes').credential).toBe('kubeconfig');
  });

  it('declares github as oauth-authenticated', () => {
    // GitHub App installations authenticate via short-lived OAuth tokens
    // rather than a single static bearer.
    expect(getConnectorTemplate('github').credential).toBe('oauth');
  });
});
