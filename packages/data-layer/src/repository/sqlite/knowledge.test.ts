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
    title: overrides.title ?? 'Sample entry',
    description: overrides.description ?? 'When the agent investigates latency spikes.',
    body: overrides.body ?? '# Body\n\nMarkdown content here.',
    intentTags: overrides.intentTags ?? ['latency', 'p99'],
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
      source: 'saved',
      sourceRef: 'tmpl-1',
      title: 'Latency p99 by service',
      description: 'Consult when investigating p99 latency by service label.',
      body: '## Recipe\n\n```promql\nhistogram_quantile(0.99, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))\n```',
      intentTags: ['latency', 'service'],
      createdBy: 'u-1',
    });
    const saved = await repo.insert(input);

    expect(saved.id).toBe(input.id);
    expect(saved.orgId).toBe(ORG);
    expect(saved.source).toBe('saved');
    expect(saved.sourceRef).toBe('tmpl-1');
    expect(saved.title).toBe('Latency p99 by service');
    expect(saved.description).toBe(input.description);
    expect(saved.body).toBe(input.body);
    expect(saved.intentTags).toEqual(['latency', 'service']);
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

  it('list filters by source', async () => {
    await repo.insert(buildEntry({ source: 'bundled' }));
    await repo.insert(buildEntry({ source: 'saved' }));
    await repo.insert(buildEntry({ source: 'bundled' }));

    const bundled = await repo.list(ORG, { source: 'bundled' });
    expect(bundled).toHaveLength(2);
    expect(bundled.every((e) => e.source === 'bundled')).toBe(true);

    const saved = await repo.list(ORG, { source: 'saved' });
    expect(saved).toHaveLength(1);
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

  it('update patches title/description/body/intentTags/sourceRef and bumps updated_at', async () => {
    const e = await repo.insert(buildEntry({
      title: 'old title',
      description: 'old desc',
      body: 'old body',
      intentTags: ['a'],
      sourceRef: null,
    }));
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update(ORG, e.id, {
      title: 'new title',
      description: 'new desc',
      body: '# New body\n\nupdated',
      intentTags: ['b', 'c'],
      sourceRef: 'ref-1',
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('new title');
    expect(updated!.description).toBe('new desc');
    expect(updated!.body).toBe('# New body\n\nupdated');
    expect(updated!.intentTags).toEqual(['b', 'c']);
    expect(updated!.sourceRef).toBe('ref-1');
    expect(updated!.updatedAt >= e.updatedAt).toBe(true);
    expect(updated!.useCount).toBe(0);
    expect(updated!.approvedCount).toBe(0);
  });

  it('update preserves fields not present in patch', async () => {
    const e = await repo.insert(buildEntry({ title: 'keep', intentTags: ['x'] }));
    const updated = await repo.update(ORG, e.id, { title: 'changed' });
    expect(updated!.title).toBe('changed');
    expect(updated!.intentTags).toEqual(['x']);
    expect(updated!.description).toBe(e.description);
    expect(updated!.body).toBe(e.body);
  });

  it('update returns null for unknown id', async () => {
    expect(await repo.update(ORG, 'nope', { title: 'x' })).toBeNull();
  });

  it('update respects org_id isolation', async () => {
    const e = await repo.insert(buildEntry({ orgId: 'org-a' }));
    expect(await repo.update('org-b', e.id, { title: 'x' })).toBeNull();
  });

  it('delete removes the row', async () => {
    const e = await repo.insert(buildEntry());
    await repo.delete(ORG, e.id);
    expect(await repo.getById(ORG, e.id)).toBeNull();
  });

  it('listForSearch returns all entries within org', async () => {
    await repo.insert(buildEntry());
    await repo.insert(buildEntry());
    await repo.insert(buildEntry());
    const all = await repo.listForSearch(ORG);
    expect(all).toHaveLength(3);
  });

  it('listForSearch filters by source', async () => {
    await repo.insert(buildEntry({ source: 'bundled' }));
    await repo.insert(buildEntry({ source: 'saved' }));
    const bundled = await repo.listForSearch(ORG, { source: 'bundled' });
    expect(bundled).toHaveLength(1);
    expect(bundled[0]!.source).toBe('bundled');
  });

  it('getById throws when intent_tags is corrupt JSON', async () => {
    const e = await repo.insert(buildEntry());
    db.run(
      sql`UPDATE knowledge_entries SET intent_tags = ${'{not json'} WHERE id = ${e.id}`,
    );
    await expect(repo.getById(ORG, e.id)).rejects.toThrow(
      /corrupt JSON in column "intent_tags"/,
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

  it('insert satisfies KnowledgeEntry shape', async () => {
    const e: KnowledgeEntry = await repo.insert(buildEntry());
    expect(typeof e.createdAt).toBe('string');
    expect(typeof e.updatedAt).toBe('string');
    expect(typeof e.description).toBe('string');
    expect(typeof e.body).toBe('string');
  });
});
