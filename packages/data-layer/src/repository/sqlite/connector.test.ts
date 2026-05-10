import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { CONNECTOR_TEMPLATE_BY_TYPE, CONNECTOR_TEMPLATES } from '@agentic-obs/common';
import { SqliteConnectorRepository } from './connector.js';

function seedExtraOrg(db: SqliteClient, id: string): void {
  db.run(sql`
    INSERT INTO org (id, name, created, updated)
    VALUES (${id}, ${id}, datetime('now'), datetime('now'))
  `);
}

describe('SqliteConnectorRepository', () => {
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
      keyVersion: 7,
    });

    const withSecret = await repo.get(connector.id, { orgId: 'org_main' });
    expect(withSecret!.secretMissing).toBe(false);
    expect(Array.from((await repo.getSecret(connector.id))!.ciphertext)).toEqual([1, 2, 3, 4]);
    expect((await repo.getSecret(connector.id))!.keyVersion).toBe(7);

    await repo.delete(connector.id, 'org_main');
    expect(await repo.getSecret(connector.id)).toBeNull();
  });

  it('upserts team policies keyed by connector, team, and capability', async () => {
    const connector = await repo.create({
      orgId: 'org_main',
      type: 'kubernetes',
      name: 'prod-cluster',
      config: { clusterName: 'prod' },
      createdBy: 'user-1',
    });

    await repo.upsertPolicy({
      connectorId: connector.id,
      teamId: 'team-a',
      capability: 'runtime.scale',
      scope: { namespaces: ['payments'] },
      humanPolicy: 'strong_confirm',
      agentPolicy: 'formal_approval',
    });
    await repo.upsertPolicy({
      connectorId: connector.id,
      teamId: 'team-a',
      capability: 'runtime.scale',
      scope: { namespaces: ['sandbox'] },
      humanPolicy: 'allow',
      agentPolicy: 'suggest',
    });

    const policy = await repo.getPolicy(connector.id, 'team-a', 'runtime.scale');
    expect(policy).toMatchObject({
      scope: { namespaces: ['sandbox'] },
      humanPolicy: 'allow',
      agentPolicy: 'suggest',
    });
    expect(await repo.listPolicies({ connectorId: connector.id, teamId: 'team-a' })).toHaveLength(1);
  });
});
