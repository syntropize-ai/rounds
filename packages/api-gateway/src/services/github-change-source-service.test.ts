import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../../data-layer/src/db/sqlite-client.js';
import { createTestDb } from '../../../data-layer/src/test-support/test-db.js';
import { SqliteChangeSourceRepository } from '../../../data-layer/src/repository/sqlite/change-source.js';
import { GitHubChangeSourceRegistry } from './github-change-source-service.js';

function deploymentPayload(patch: Record<string, unknown> = {}) {
  return {
    deployment: {
      id: 123,
      ref: 'main',
      sha: 'abc123',
      environment: 'production',
      description: 'Deploy main to production',
      created_at: new Date().toISOString(),
      creator: { login: 'octocat' },
    },
    repository: { full_name: 'openobs/openobs' },
    ...patch,
  };
}

describe('GitHubChangeSourceRegistry', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let db: SqliteClient;
  let registry: GitHubChangeSourceRegistry;

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-github-change-service-xxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(() => {
    db = createTestDb();
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_a', 'Org A', 'now', 'now')`);
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_b', 'Org B', 'now', 'now')`);
    registry = new GitHubChangeSourceRegistry(new SqliteChangeSourceRepository(db));
  });

  it('creates org-scoped GitHub sources with a one-time plain secret', async () => {
    const source = await registry.create({
      orgId: 'org_a',
      name: 'Prod deploys',
      owner: 'openobs',
      repo: 'openobs',
      secret: 'super-secret',
    });

    expect(source.orgId).toBe('org_a');
    expect(source.secret).toBe('super-secret');
    expect(source.secretMasked).toBe('••••••cret');
    expect(source.webhookPath).toBe(`/api/change-sources/github/${source.id}/webhook`);
    await expect(registry.list('org_a')).resolves.toHaveLength(1);
    await expect(registry.list('org_b')).resolves.toEqual([]);
    expect((await registry.list('org_a'))[0]).not.toHaveProperty('secret');
  });

  it('ingests GitHub deployment webhooks into a queryable changes adapter', async () => {
    const source = await registry.create({ orgId: 'org_a', name: 'Prod deploys' });

    const result = await registry.ingestGitHubWebhook(source.id, 'deployment', deploymentPayload());

    expect(result).toMatchObject({
      ok: true,
      ignored: false,
      record: {
        service: 'openobs/openobs',
        kind: 'deploy',
        summary: 'Deploy main to production',
      },
    });

    const adapters = await registry.listAdapters('org_a');
    expect(adapters).toHaveLength(1);
    const records = await adapters[0]!.adapter.listRecent({ windowMinutes: 60 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      service: 'openobs/openobs',
      metadata: { author: 'octocat', version: 'abc123' },
    });
  });

  it('ignores disabled event types and foreign org deletes', async () => {
    const source = await registry.create({
      orgId: 'org_a',
      name: 'Prod deploys',
      events: ['deployment'],
    });

    await expect(
      registry.ingestGitHubWebhook(source.id, 'deployment_status', deploymentPayload()),
    ).resolves.toMatchObject({ ok: true, ignored: true });
    await expect(registry.delete('org_b', source.id)).resolves.toBe(false);
    await expect(registry.list('org_a')).resolves.toHaveLength(1);
  });
});
