/**
 * Tests for kb_search / kb_get / kb_recommend handlers (unified skill-style).
 */
import { describe, it, expect } from 'vitest';
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
        if (opts?.source && v.source !== opts.source) continue;
        out.push(v);
      }
      return out;
    },
    async update(orgId, id, patch) {
      const cur = rows.get(`${orgId}::${id}`);
      if (!cur) return null;
      const next: KnowledgeEntry = {
        ...cur,
        title: patch.title ?? cur.title,
        description: patch.description ?? cur.description,
        body: patch.body ?? cur.body,
        intentTags: patch.intentTags ?? cur.intentTags,
        sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : cur.sourceRef,
        updatedAt: new Date().toISOString(),
      };
      rows.set(`${orgId}::${id}`, next);
      return next;
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

const KAFKA: KnowledgeInsertInput = {
  id: 'sk-kafka',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  title: 'Kafka cluster overview',
  description: 'Pick exporter metrics and panels for a Kafka cluster overview dashboard.',
  body: 'Use kafka_server_brokertopicmetrics_messagesin_total and consumer lag metrics.',
  intentTags: ['kafka', 'consumer', 'lag'],
  createdBy: null,
};
const REDIS: KnowledgeInsertInput = {
  id: 'sk-redis',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  title: 'Redis instance health',
  description: 'Surface Redis instance health using redis_exporter metrics.',
  body: 'Watch redis_connected_clients_info and memory usage.',
  intentTags: ['redis', 'cache'],
  createdBy: null,
};
const RED: KnowledgeInsertInput = {
  id: 'sk-red',
  orgId: 'test-org',
  source: 'bundled',
  sourceRef: null,
  title: 'RED method',
  description: 'Apply the RED method (Rate, Errors, Duration) to a request service.',
  body: 'Use one panel-row per service with request rate, error rate, and duration.',
  intentTags: ['red', 'http'],
  createdBy: null,
};

describe('handleKbSearch', () => {
  it('returns matching entries by intent tag', async () => {
    const ctx = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA, REDIS, RED]),
    });
    const out = await handleKbSearch(ctx, { query: 'kafka' });
    const parsed = JSON.parse(out);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(1);
    expect(parsed.entries[0].id).toBe('sk-kafka');
    expect(parsed.entries[0].description).toBeTypeOf('string');
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
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([REDIS]) });
    const out = await handleKbSearch(ctx, { query: 'kafka' });
    expect(out).toMatch(/No KB entries matched/);
  });
});

describe('handleKbGet', () => {
  it('returns the entry and bumps useCount', async () => {
    const repo = inMemoryKb([KAFKA]);
    const ctx = makeFakeActionContext({ knowledge: repo });
    const out = await handleKbGet(ctx, { id: 'sk-kafka' });
    const parsed = JSON.parse(out);
    expect(parsed.entry.id).toBe('sk-kafka');
    expect(parsed.entry.description).toBeTypeOf('string');
    expect(parsed.entry.body).toBeTypeOf('string');
    // bumpUseCount is fire-and-forget; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));
    const entry = await repo.getById('test-org', 'sk-kafka');
    expect(entry!.useCount).toBe(1);
  });

  it('404 message when entry missing', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([]) });
    const out = await handleKbGet(ctx, { id: 'nope' });
    expect(out).toMatch(/not found/);
  });
});

describe('handleKbRecommend', () => {
  it('ranks intent-matching entry higher than unrelated entries', async () => {
    const ctx = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA, REDIS, RED]),
    });
    const out = await handleKbRecommend(ctx, { intent: 'kafka consumer lag dashboard' });
    const parsed = JSON.parse(out);
    expect(parsed.entries[0].id).toBe('sk-kafka');
    expect(parsed.entries.length).toBeLessThanOrEqual(3);
  });

  it('penalizes entries whose required metrics are not exposed (server-side resolution)', async () => {
    const { AdapterRegistry } = await import('../../../adapters/registry.js');
    const ctxNoAdapter = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA, REDIS]),
    });
    const reg = new AdapterRegistry();
    reg.register({
      info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
      metrics: {
        listMetricNames: async () => ['redis_connected_clients_info'],
      } as never,
    });
    const ctxWithAdapter = makeFakeActionContext({
      knowledge: inMemoryKb([KAFKA, REDIS]),
      adapters: reg,
      allConnectors: [{ id: 'prom', type: 'prometheus', isDefault: true } as never],
    });

    const out1 = await handleKbRecommend(ctxNoAdapter, { intent: 'instance health' });
    const out2 = await handleKbRecommend(ctxWithAdapter, { intent: 'instance health' });
    const before = JSON.parse(out1).entries[0].id;
    const after = JSON.parse(out2).entries[0].id;
    expect(after).toBe('sk-redis');
    const kafkaAfter = JSON.parse(out2).entries.find((e: { id: string }) => e.id === 'sk-kafka');
    const kafkaBefore = JSON.parse(out1).entries.find((e: { id: string }) => e.id === 'sk-kafka');
    expect(kafkaAfter.score).toBeLessThan(kafkaBefore.score);
    expect(before).toBe('sk-redis');
  });

  it('empty KB returns a helpful message', async () => {
    const ctx = makeFakeActionContext({ knowledge: inMemoryKb([]) });
    const out = await handleKbRecommend(ctx, { intent: 'kafka' });
    expect(out).toMatch(/No knowledge base entries/);
  });
});
