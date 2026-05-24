/**
 * Postgres KnowledgeRepository — integration tests.
 *
 * See `./instance-config.test.ts` for the POSTGRES_TEST_URL contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../db/client.js';
import { applyPostgresSchema } from './schema-applier.js';
import { PostgresKnowledgeRepository } from './knowledge.js';

const PG_URL = process.env['POSTGRES_TEST_URL'];
const describeIfPg = PG_URL ? describe : describe.skip;
const ORG = 'org_main';

type InsertInput = Parameters<PostgresKnowledgeRepository['insert']>[0];

function buildEntry(overrides: Partial<InsertInput> = {}): InsertInput {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    orgId: overrides.orgId ?? ORG,
    source: overrides.source ?? 'bundled',
    sourceRef: overrides.sourceRef ?? null,
    title: overrides.title ?? 'Sample entry',
    description: overrides.description ?? 'When investigating latency issues.',
    body: overrides.body ?? '# Body\n\nMarkdown content.',
    intentTags: overrides.intentTags ?? ['latency', 'p99'],
    createdBy: overrides.createdBy ?? null,
  };
}

describeIfPg('PostgresKnowledgeRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let db: DbClient;

  beforeAll(async () => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-instance-config-repositories-xxxxxxxx';
    db = createDbClient({ url: PG_URL! });
    await applyPostgresSchema(db);
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE knowledge_entries`);
  });

  it('insert + getById round-trip preserves every field', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const input = buildEntry({
      source: 'saved',
      sourceRef: 'tmpl-1',
      title: 'Latency p99',
      description: 'Use when triaging slow endpoints.',
      body: '## Steps\n\n1. Query p99\n2. Group by service',
      intentTags: ['latency', 'service'],
      createdBy: 'u-1',
    });
    const saved = await repo.insert(input);

    expect(saved.id).toBe(input.id);
    expect(saved.source).toBe('saved');
    expect(saved.sourceRef).toBe('tmpl-1');
    expect(saved.title).toBe('Latency p99');
    expect(saved.description).toBe(input.description);
    expect(saved.body).toBe(input.body);
    expect(saved.intentTags).toEqual(['latency', 'service']);
    expect(saved.useCount).toBe(0);
    expect(saved.approvedCount).toBe(0);
    expect(saved.rejectedCount).toBe(0);

    const fetched = await repo.getById(ORG, input.id);
    expect(fetched).toEqual(saved);
  });

  it('getById returns null for unknown id', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    expect(await repo.getById(ORG, 'nope')).toBeNull();
  });

  it('getById respects org_id isolation', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry({ orgId: 'org-a' }));
    expect(await repo.getById('org-b', e.id)).toBeNull();
  });

  it('list filters by source and respects limit', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    await repo.insert(buildEntry({ source: 'bundled' }));
    await repo.insert(buildEntry({ source: 'saved' }));
    await repo.insert(buildEntry({ source: 'bundled' }));

    expect(await repo.list(ORG, { source: 'bundled' })).toHaveLength(2);
    expect(await repo.list(ORG, { source: 'saved' })).toHaveLength(1);
    expect(await repo.list(ORG, { limit: 1 })).toHaveLength(1);
  });

  it('bumpUseCount increments useCount', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await repo.bumpUseCount(ORG, e.id);
    await repo.bumpUseCount(ORG, e.id);
    expect((await repo.getById(ORG, e.id))!.useCount).toBe(2);
  });

  it('recordFeedback(true/false) increments the respective counter', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await repo.recordFeedback(ORG, e.id, true);
    await repo.recordFeedback(ORG, e.id, false);
    const after = await repo.getById(ORG, e.id);
    expect(after!.approvedCount).toBe(1);
    expect(after!.rejectedCount).toBe(1);
  });

  it('update patches title/description/body/intentTags/sourceRef', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry({ title: 'old', description: 'old', body: 'old' }));
    const updated = await repo.update(ORG, e.id, {
      title: 'new',
      description: 'new desc',
      body: '# new body',
      intentTags: ['x', 'y'],
      sourceRef: 'ref-1',
    });
    expect(updated!.title).toBe('new');
    expect(updated!.description).toBe('new desc');
    expect(updated!.body).toBe('# new body');
    expect(updated!.intentTags).toEqual(['x', 'y']);
    expect(updated!.sourceRef).toBe('ref-1');
  });

  it('delete removes the row', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await repo.delete(ORG, e.id);
    expect(await repo.getById(ORG, e.id)).toBeNull();
  });

  it('listForSearch returns all when source omitted, filters when provided', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    await repo.insert(buildEntry({ source: 'bundled' }));
    await repo.insert(buildEntry({ source: 'saved' }));
    expect(await repo.listForSearch(ORG)).toHaveLength(2);
    expect(await repo.listForSearch(ORG, { source: 'bundled' })).toHaveLength(1);
  });

  it('getById throws when intent_tags is corrupt JSON', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await db.execute(
      sql`UPDATE knowledge_entries SET intent_tags = ${'{not json'} WHERE id = ${e.id}`,
    );
    await expect(repo.getById(ORG, e.id)).rejects.toThrow(
      /corrupt JSON in column "intent_tags"/,
    );
  });
});
