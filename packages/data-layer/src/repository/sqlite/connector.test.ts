import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { CONNECTOR_TEMPLATE_BY_TYPE, CONNECTOR_TEMPLATES } from '@agentic-obs/common';
import { CONNECTOR_SECRET_KEY_VERSION } from '../connector-shared.js';
import { SqliteConnectorRepository } from './connector.js';

function seedExtraOrg(db: SqliteClient, id: string): void {
  db.run(sql`
    INSERT INTO org (id, name, created, updated)
    VALUES (${id}, ${id}, datetime('now'), datetime('now'))
  `);
}

/** Read the stored row without going through the repository's decryption. */
function rawSecretRow(
  db: SqliteClient,
  connectorId: string,
): { ciphertext: Uint8Array; key_version: number } | undefined {
  return db.all<{ ciphertext: Uint8Array; key_version: number }>(
    sql`SELECT ciphertext, key_version FROM connector_secrets WHERE connector_id = ${connectorId}`,
  )[0];
}

describe('SqliteConnectorRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];

  beforeAll(() => {
    // AES-GCM needs a ≥32-char key; tests supply one if operator didn't.
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-connector-secrets-xxxxxxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  let db: SqliteClient;
  let repo: SqliteConnectorRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConnectorRepository(db);
  });

  it('materializes capabilities from the connector template on create', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'prometheus',
      name: 'prod-prom',
      config: { url: 'https://prom.example.com' },
      status: 'active',
      isDefault: true,
      createdBy: 'user-1',
    });

    expect(connector.capabilities).toEqual(
      CONNECTOR_TEMPLATE_BY_TYPE.prometheus.capabilities,
    );
    expect(connector.secretMissing).toBe(true);
    expect(connector.defaultFor).toBe('prometheus');
    expect(await repo.findByCapability('org_main', 'metrics.query')).toHaveLength(1);
  });

  it('covers every initial template type required by the redesign', () => {
    expect(CONNECTOR_TEMPLATES.map((t) => t.type).sort()).toEqual([
      'clickhouse',
      'elasticsearch',
      'github',
      'humio',
      'jaeger',
      'kubernetes',
      'loki',
      'otel',
      'prometheus',
      'tempo',
      'victoria-metrics',
    ]);
  });

  it('keeps only one default per org and type', async () => {
    const first = await repo.create({
      orgId: 'org_main',
      type: 'loki',
      name: 'loki-a',
      config: { url: 'https://loki-a.example.com' },
      isDefault: true,
      createdBy: 'user-1',
    });
    const second = await repo.create({
      orgId: 'org_main',
      type: 'loki',
      name: 'loki-b',
      config: { url: 'https://loki-b.example.com' },
      isDefault: true,
      createdBy: 'user-1',
    });

    expect((await repo.get(first.id, { orgId: 'org_main' }))!.isDefault).toBe(false);
    expect((await repo.get(second.id, { orgId: 'org_main' }))!.isDefault).toBe(true);
  });

  it('enforces org scope and allows same type/name in another org', async () => {
    seedExtraOrg(db, 'org_other');
    const main = await repo.create({
      id: 'prom-main',
      orgId: 'org_main',
      type: 'prometheus',
      name: 'shared',
      config: { url: 'https://main.example.com' },
      createdBy: 'user-1',
    });
    const other = await repo.create({
      id: 'prom-other',
      orgId: 'org_other',
      type: 'prometheus',
      name: 'shared',
      config: { url: 'https://other.example.com' },
      createdBy: 'user-1',
    });

    expect((await repo.list({ orgId: 'org_main' })).map((c) => c.id)).toEqual([main.id]);
    expect(await repo.get(other.id, { orgId: 'org_main' })).toBeNull();
    expect(await repo.update(other.id, { name: 'leak' }, 'org_main')).toBeNull();
    expect(await repo.delete(other.id, 'org_main')).toBe(false);
    expect(await repo.count('org_main')).toBe(1);
  });

  it('stores opaque connector secrets separately and cascades them on delete', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'github',
      name: 'github',
      config: { owner: 'acme' },
      createdBy: 'user-1',
    });

    await repo.upsertSecret({
      connectorId: connector.id,
      ciphertext: new Uint8Array([1, 2, 3, 4]),
    });

    const withSecret = await repo.get(connector.id, { orgId: 'org_main' });
    expect(withSecret!.secretMissing).toBe(false);
    expect(Array.from((await repo.getSecret(connector.id))!.ciphertext)).toEqual([1, 2, 3, 4]);
    expect((await repo.getSecret(connector.id))!.keyVersion).toBe(CONNECTOR_SECRET_KEY_VERSION);

    await repo.delete(connector.id, 'org_main');
    expect(await repo.getSecret(connector.id)).toBeNull();
  });

  it('encrypts secrets at rest — the stored column never holds the plaintext', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'kubernetes',
      name: 'prod-cluster',
      config: { clusterName: 'prod' },
      createdBy: 'user-1',
    });
    const kubeconfig = 'apiVersion: v1\nusers:\n- user:\n    token: sup3r-s3cret-token\n';

    await repo.upsertSecret({
      connectorId: connector.id,
      ciphertext: new TextEncoder().encode(kubeconfig),
    });

    // Round trip through the repository returns the plaintext back.
    const read = await repo.getSecret(connector.id);
    expect(Buffer.from(read!.ciphertext).toString('utf8')).toBe(kubeconfig);

    // ...but the raw column is an AES-GCM envelope, not the credential.
    const raw = rawSecretRow(db, connector.id)!;
    const stored = Buffer.from(raw.ciphertext).toString('utf8');
    expect(stored).not.toContain('sup3r-s3cret-token');
    expect(stored).not.toContain('apiVersion');
    expect(stored).toMatch(/^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
    expect(raw.key_version).toBe(CONNECTOR_SECRET_KEY_VERSION);
  });

  it('fails loudly when a stored secret cannot be decrypted', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'prometheus',
      name: 'prom',
      config: { url: 'https://prom.example.com' },
      createdBy: 'user-1',
    });
    await repo.upsertSecret({
      connectorId: connector.id,
      ciphertext: new TextEncoder().encode('tok'),
    });
    db.run(sql`
      UPDATE connector_secrets SET ciphertext = ${Buffer.from('not-an-envelope', 'utf8')}
      WHERE connector_id = ${connector.id}
    `);

    await expect(repo.getSecret(connector.id)).rejects.toThrow(/malformed ciphertext/);
  });

  it('upserts policies keyed by connector, subject (org|team), and capability', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'kubernetes',
      name: 'prod-cluster',
      config: { clusterName: 'prod' },
      createdBy: 'user-1',
    });

    await repo.upsertPolicy({
      connectorId: connector.id,
      subjectType: 'team',
      subjectId: 'team-a',
      capability: 'runtime.scale',
      scope: { namespaces: ['payments'] },
      humanPolicy: 'ask',
    });
    await repo.upsertPolicy({
      connectorId: connector.id,
      subjectType: 'team',
      subjectId: 'team-a',
      capability: 'runtime.scale',
      scope: { namespaces: ['sandbox'] },
      humanPolicy: 'allow',
    });

    const policy = await repo.getPolicy(connector.id, 'team', 'team-a', 'runtime.scale');
    expect(policy).toMatchObject({
      scope: { namespaces: ['sandbox'] },
      humanPolicy: 'allow',
    });
    expect(
      await repo.listPolicies({
        connectorId: connector.id,
        subjectType: 'team',
        subjectId: 'team-a',
      }),
    ).toHaveLength(1);

    // Org-level subject coexists with team-level on the same capability.
    await repo.upsertPolicy({
      connectorId: connector.id,
      subjectType: 'org',
      subjectId: 'org_main',
      capability: 'runtime.scale',
      scope: null,
      humanPolicy: 'block',
    });
    expect(await repo.listPolicies({ connectorId: connector.id })).toHaveLength(2);

    expect(
      await repo.deletePolicy(connector.id, 'team', 'team-a', 'runtime.scale'),
    ).toBe(true);
    expect(await repo.listPolicies({ connectorId: connector.id })).toHaveLength(1);
  });
});
