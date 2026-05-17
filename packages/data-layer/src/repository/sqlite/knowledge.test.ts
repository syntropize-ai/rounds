import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteKnowledgeRepository } from './knowledge.js';
import type { KnowledgeEntry } from '../interfaces.js';

const ORG = 'org_main';

type InsertInput = Parameters<SqliteKnowledgeRepository['insert']>[0];

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

describe('SqliteKnowledgeRepository', () => {
  let db: SqliteClient;
  let repo: SqliteKnowledgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteKnowledgeRepository(db);
  });

  it('insert + getById round-trip preserves every field', async () => {
    const input = buildEntry({
      kind: 'template',
      source: 'saved',
      sourceRef: 'tmpl-1',
      title: 'Latency p99 by service',
      intentTags: ['latency', 'service'],
      content: { panels: [{ title: 'p99' }] },
      createdBy: 'u-1',
    });
    const saved = await repo.insert(input);

    expect(saved.id).toBe(input.id);
    expect(saved.orgId).toBe(ORG);
    expect(saved.source).toBe('saved');
    expect(saved.sourceRef).toBe('tmpl-1');
    expect(saved.kind).toBe('template');
    expect(saved.title).toBe('Latency p99 by service');
    expect(saved.intentTags).toEqual(['latency', 'service']);
    expect(saved.content).toEqual({ panels: [{ title: 'p99' }] });
    expect(saved.useCount).toBe(0);
    expect(saved.approvedCount).toBe(0);
    expect(saved.rejectedCount).toBe(0);
    expect(saved.createdBy).toBe('u-1');
    expect(saved.createdAt).toEqual(saved.updatedAt);

    const fetched = await repo.getById(ORG, input.id);
    expect(fetched).toEqual(saved);
  });

  it('getById returns null for an unknown id', async () => {
    expect(await repo.getById(ORG, 'nope')).toBeNull();
  });

  it('getById respects org_id isolation', async () => {
    const e = await repo.insert(buildEntry({ orgId: 'org-a' }));
    expect(await repo.getById('org-b', e.id)).toBeNull();
  });

  it('list filters by kind and source', async () => {
    await repo.insert(buildEntry({ kind: 'pattern', source: 'bundled' }));
    await repo.insert(buildEntry({ kind: 'pattern', source: 'saved' }));
    await repo.insert(buildEntry({ kind: 'template', source: 'bundled' }));

    const patterns = await repo.list(ORG, { kind: 'pattern' });
    expect(patterns).toHaveLength(2);
    expect(patterns.every((e) => e.kind === 'pattern')).toBe(true);

    const bundled = await repo.list(ORG, { source: 'bundled' });
    expect(bundled).toHaveLength(2);
    expect(bundled.every((e) => e.source === 'bundled')).toBe(true);

    const bundledPatterns = await repo.list(ORG, {
      kind: 'pattern',
      source: 'bundled',
    });
    expect(bundledPatterns).toHaveLength(1);
  });

  it('list respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insert(buildEntry({ title: `t${i}` }));
    }
    const limited = await repo.list(ORG, { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('bumpUseCount increments useCount', async () => {
    const e = await repo.insert(buildEntry());
    await repo.bumpUseCount(ORG, e.id);
    await repo.bumpUseCount(ORG, e.id);
    const after = await repo.getById(ORG, e.id);
    expect(after!.useCount).toBe(2);
  });

  it('recordFeedback(true) increments approved_count', async () => {
    const e = await repo.insert(buildEntry());
    await repo.recordFeedback(ORG, e.id, true);
    await repo.recordFeedback(ORG, e.id, true);
    const after = await repo.getById(ORG, e.id);
    expect(after!.approvedCount).toBe(2);
    expect(after!.rejectedCount).toBe(0);
  });

  it('recordFeedback(false) increments rejected_count', async () => {
    const e = await repo.insert(buildEntry());
    await repo.recordFeedback(ORG, e.id, false);
    const after = await repo.getById(ORG, e.id);
    expect(after!.rejectedCount).toBe(1);
    expect(after!.approvedCount).toBe(0);
  });

  it('delete removes the row', async () => {
    const e = await repo.insert(buildEntry());
    await repo.delete(ORG, e.id);
    expect(await repo.getById(ORG, e.id)).toBeNull();
  });

  it('listForSearch returns all entries when kind omitted', async () => {
    await repo.insert(buildEntry({ kind: 'pattern' }));
    await repo.insert(buildEntry({ kind: 'template' }));
    await repo.insert(buildEntry({ kind: 'metric_doc' }));
    const all = await repo.listForSearch(ORG);
    expect(all).toHaveLength(3);
  });

  it('listForSearch filters by kind when provided', async () => {
    await repo.insert(buildEntry({ kind: 'pattern' }));
    await repo.insert(buildEntry({ kind: 'template' }));
    const justPatterns = await repo.listForSearch(ORG, { kind: 'pattern' });
    expect(justPatterns).toHaveLength(1);
    expect(justPatterns[0]!.kind).toBe('pattern');
  });

  it('getById throws when content column is corrupt JSON', async () => {
    const e = await repo.insert(buildEntry());
    db.run(
      sql`UPDATE knowledge_entries SET content = ${'{not json'} WHERE id = ${e.id}`,
    );
    await expect(repo.getById(ORG, e.id)).rejects.toThrow(
      /corrupt JSON in column "content"/,
    );
  });

  it('getById throws when intent_tags is not an array', async () => {
    const e = await repo.insert(buildEntry());
    db.run(
      sql`UPDATE knowledge_entries SET intent_tags = ${JSON.stringify({ not: 'array' })} WHERE id = ${e.id}`,
    );
    await expect(repo.getById(ORG, e.id)).rejects.toThrow(
      /expected array in column "intent_tags"/,
    );
  });

  it('list throws when content is corrupt for any row', async () => {
    const _good = await repo.insert(buildEntry({ title: 'good' }));
    const bad = await repo.insert(buildEntry({ title: 'bad' }));
    db.run(
      sql`UPDATE knowledge_entries SET content = ${'{nope'} WHERE id = ${bad.id}`,
    );
    await expect(repo.list(ORG)).rejects.toThrow(/corrupt JSON/);
  });

  it('insert satisfies KnowledgeEntry shape', async () => {
    const e: KnowledgeEntry = await repo.insert(buildEntry());
    expect(typeof e.createdAt).toBe('string');
    expect(typeof e.updatedAt).toBe('string');
  });
});
