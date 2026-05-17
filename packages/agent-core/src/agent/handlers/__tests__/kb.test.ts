/**
 * Tests for kb_search / kb_get / kb_recommend handlers.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  IKnowledgeRepository,
  KnowledgeEntry,
  KnowledgeInsertInput,
} from '@agentic-obs/common';
import { handleKbSearch } from '../kb-search.js';
import { handleKbGet } from '../kb-get.js';
import { handleKbRecommend } from '../kb-recommend.js';
import { makeFakeActionContext } from '../_test-helpers.js';

function inMemoryKb(seed: KnowledgeInsertInput[] = []): IKnowledgeRepository {
  const rows = new Map<string, KnowledgeEntry>();
  // Seed synchronously so the test body doesn't have to await before
  // exercising the handler.
  for (const s of seed) {
    const now = new Date().toISOString();
    rows.set(`${s.orgId}::${s.id}`, {
      ...s, useCount: 0, approvedCount: 0, rejectedCount: 0,
      createdAt: now, updatedAt: now,
    });
  }
  const repo: IKnowledgeRepository = {
    async insert(input) {
      const now = new Date().toISOString();
      const entry: KnowledgeEntry = {
        ...input, useCount: 0, approvedCount: 0, rejectedCount: 0,
        createdAt: now, updatedAt: now,
      };
      rows.set(`${input.orgId}::${input.id}`, entry);
      return entry;
    },
    async getById(orgId, id) { return rows.get(`${orgId}::${id}`) ?? null; },
    async list(orgId, opts) {
      const out: KnowledgeEntry[] = [];
      for (const [k, v] of rows) {
        if (!k.startsWith(`${orgId}::`)) continue;
        if (opts?.kind && v.kind !== opts.kind) continue;
        out.push(v);
      }
      return out;
    },
    async bumpUseCount(orgId, id) {
      const cur = rows.get(`${orgId}::${id}`);
      if (cur) rows.set(`${orgId}::${id}`, { ...cur, useCount: cur.useCount + 1 });
    },
    async recordFeedback() {},
    async delete() {},
    async listForSearch(orgId, opts) { return this.list(orgId, opts); },
  };
  return repo;
}

const KAFKA_TEMPLATE: KnowledgeInsertInput = {
  id: 'tpl-kafka',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  kind: 'template',
  title: 'Kafka cluster overview',
  intentTags: ['kafka', 'consumer', 'lag'],
  content: {
    panels: [{
      queries: [{ expr: 'sum(rate(kafka_server_brokertopicmetrics_messagesin_total[5m]))' }],
    }],
  },
  createdBy: null,
};
const REDIS_TEMPLATE: KnowledgeInsertInput = {
  id: 'tpl-redis',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  kind: 'template',
  title: 'Redis instance health',
  intentTags: ['redis', 'cache'],
  content: {
    panels: [{ queries: [{ expr: 'redis_connected_clients_info' }] }],
  },
  createdBy: null,
};
const RED_PATTERN: KnowledgeInsertInput = {
  id: 'pat-red',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  kind: 'pattern',
  title: 'RED method',
  intentTags: ['red', 'http'],
  content: { applicableWhen: 'request services' },
  createdBy: null,
};

describe('handleKbSearch', () => {
  it('returns matching entries by intent tag', async () => {
    const ctx = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA_TEMPLATE, REDIS_TEMPLATE, RED_PATTERN]),
    });
    const out = await handleKbSearch(ctx, { query: 'kafka' });
    const parsed = JSON.parse(out);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    expect(parsed.entries[0].id).toBe('tpl-kafka');
  });

  it('returns a clear message when no KB repo is wired', async () => {
    const ctx = makeFakeActionContext({ knowledge: undefined });
    const out = await handleKbSearch(ctx, { query: 'kafka' });
    expect(out).toMatch(/not configured/i);
  });

  it('errors on missing query', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([]) });
    const out = await handleKbSearch(ctx, {});
    expect(out).toMatch(/required/);
  });

  it('reports zero matches gracefully', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([REDIS_TEMPLATE]) });
    const out = await handleKbSearch(ctx, { query: 'kafka' });
    expect(out).toMatch(/No KB entries matched/);
  });
});

describe('handleKbGet', () => {
  it('returns the entry and bumps useCount', async () => {
    const repo = inMemoryKb([KAFKA_TEMPLATE]);
    const ctx = makeFakeActionContext({ knowledge: repo });
    const out = await handleKbGet(ctx, { id: 'tpl-kafka' });
    expect(JSON.parse(out).entry.id).toBe('tpl-kafka');
    // bumpUseCount is fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));
    const entry = await repo.getById('test-org', 'tpl-kafka');
    expect(entry!.useCount).toBe(1);
  });

  it('404 message when entry missing', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([]) });
    const out = await handleKbGet(ctx, { id: 'nope' });
    expect(out).toMatch(/not found/);
  });
});

describe('handleKbRecommend', () => {
  it('ranks intent-matching template higher than unrelated entries', async () => {
    const ctx = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA_TEMPLATE, REDIS_TEMPLATE, RED_PATTERN]),
    });
    const out = await handleKbRecommend(ctx, { intent: 'kafka consumer lag dashboard' });
    const parsed = JSON.parse(out);
    expect(parsed.entries[0].id).toBe('tpl-kafka');
    expect(parsed.entries.length).toBeLessThanOrEqual(3);
  });

  it('penalizes templates whose required metrics are not exposed', async () => {
    const ctx = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA_TEMPLATE, REDIS_TEMPLATE]),
    });
    // Two templates equally matching intent ("instance overview") but only
    // redis metrics are exposed — coverage tilts the score to redis.
    const out1 = await handleKbRecommend(ctx, {
      intent: 'instance health',
      // availableMetrics omitted → coverage defaults to 0.5 (unknown).
    });
    const out2 = await handleKbRecommend(ctx, {
      intent: 'instance health',
      availableMetrics: ['redis_connected_clients_info'],
    });
    const before = JSON.parse(out1).entries[0].id;
    const after = JSON.parse(out2).entries[0].id;
    // Without coverage data, redis wins on title overlap; with coverage
    // exposing only redis metrics, redis remains #1 and its score >= before.
    expect(after).toBe('tpl-redis');
    // And the kafka entry's score in the coverage-aware ranking should be
    // strictly less than its score without coverage info (penalty applied).
    const kafkaAfter = JSON.parse(out2).entries.find((e: { id: string }) => e.id === 'tpl-kafka');
    const kafkaBefore = JSON.parse(out1).entries.find((e: { id: string }) => e.id === 'tpl-kafka');
    expect(kafkaAfter.score).toBeLessThan(kafkaBefore.score);
    expect(before).toBe('tpl-redis');
  });

  it('empty KB returns a helpful message', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([]) });
    const out = await handleKbRecommend(ctx, { intent: 'kafka' });
    expect(out).toMatch(/No templates/);
  });
});
