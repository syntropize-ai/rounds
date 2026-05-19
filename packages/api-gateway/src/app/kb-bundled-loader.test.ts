import { describe, it, expect } from 'vitest';
import { BUNDLED_SEEDS, type IKnowledgeRepository, type KnowledgeEntry, type KnowledgeInsertInput } from '@agentic-obs/common';
import { ensureBundledSeeds } from './kb-bundled-loader.js';

function inMemoryKbRepo(): IKnowledgeRepository {
  const rows = new Map<string, KnowledgeEntry>();
  return {
    async insert(input: KnowledgeInsertInput) {
      const now = new Date().toISOString();
      const entry: KnowledgeEntry = {
        ...input,
        useCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(`${input.orgId}::${input.id}`, entry);
      return entry;
    },
    async getById(orgId, id) {
      return rows.get(`${orgId}::${id}`) ?? null;
    },
    async list(orgId, opts) {
      const out: KnowledgeEntry[] = [];
      for (const [k, v] of rows) {
        if (!k.startsWith(`${orgId}::`)) continue;
        if (opts?.kind && v.kind !== opts.kind) continue;
        out.push(v);
      }
      return out;
    },
    async bumpUseCount() {},
    async recordFeedback() {},
    async delete(orgId, id) { rows.delete(`${orgId}::${id}`); },
    async listForSearch(orgId, opts) {
      return this.list(orgId, opts);
    },
  };
}

describe('ensureBundledSeeds', () => {
  it('inserts every bundled seed on first run', async () => {
    const repo = inMemoryKbRepo();
    const result = await ensureBundledSeeds(repo, 'org_main');
    expect(result.inserted).toBe(BUNDLED_SEEDS.length);
    expect(result.skipped).toBe(0);
  });

  it('is idempotent on second run', async () => {
    const repo = inMemoryKbRepo();
    await ensureBundledSeeds(repo, 'org_main');
    const second = await ensureBundledSeeds(repo, 'org_main');
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(BUNDLED_SEEDS.length);
  });

  it('per-org scoping — same id seeds in different orgs', async () => {
    const repo = inMemoryKbRepo();
    await ensureBundledSeeds(repo, 'org_a');
    const second = await ensureBundledSeeds(repo, 'org_b');
    expect(second.inserted).toBe(BUNDLED_SEEDS.length);
  });
});
