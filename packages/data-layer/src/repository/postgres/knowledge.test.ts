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
    kind: overrides.kind ?? 'pattern',
    title: overrides.title ?? 'Sample entry',
    intentTags: overrides.intentTags ?? ['latency', 'p99'],
    content: overrides.content ?? { promql: 'up' },
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
      kind: 'template',
      source: 'saved',
      sourceRef: 'tmpl-1',
      title: 'Latency p99',
      intentTags: ['latency', 'service'],
      content: { panels: [{ title: 'p99' }] },
      createdBy: 'u-1',
    });
    const saved = await repo.insert(input);

    expect(saved.id).toBe(input.id);
    expect(saved.source).toBe('saved');
    expect(saved.sourceRef).toBe('tmpl-1');
    expect(saved.kind).toBe('template');
    expect(saved.intentTags).toEqual(['latency', 'service']);
    expect(saved.content).toEqual({ panels: [{ title: 'p99' }] });
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

  it('list filters by kind/source and respects limit', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    await repo.insert(buildEntry({ kind: 'pattern', source: 'bundled' }));
    await repo.insert(buildEntry({ kind: 'pattern', source: 'saved' }));
    await repo.insert(buildEntry({ kind: 'template', source: 'bundled' }));

    expect(await repo.list(ORG, { kind: 'pattern' })).toHaveLength(2);
    expect(await repo.list(ORG, { source: 'bundled' })).toHaveLength(2);
    expect(
      await repo.list(ORG, { kind: 'pattern', source: 'bundled' }),
    ).toHaveLength(1);
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

  it('delete removes the row', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await repo.delete(ORG, e.id);
    expect(await repo.getById(ORG, e.id)).toBeNull();
  });

  it('listForSearch returns all when kind omitted, filters when provided', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    await repo.insert(buildEntry({ kind: 'pattern' }));
    await repo.insert(buildEntry({ kind: 'template' }));
    expect(await repo.listForSearch(ORG)).toHaveLength(2);
    expect(await repo.listForSearch(ORG, { kind: 'pattern' })).toHaveLength(1);
  });

  it('getById throws when content column is corrupt JSON', async () => {
    const repo = new PostgresKnowledgeRepository(db);
    const e = await repo.insert(buildEntry());
    await db.execute(
      sql`UPDATE knowledge_entries SET content = ${'{not json'} WHERE id = ${e.id}`,
    );
    await expect(repo.getById(ORG, e.id)).rejects.toThrow(
      /corrupt JSON in column "content"/,
    );
  });
});
