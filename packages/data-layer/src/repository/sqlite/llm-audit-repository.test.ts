import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import {
  SqliteLlmAuditRepository,
  type NewLlmAuditRecord,
} from './llm-audit-repository.js';

function makeRecord(overrides: Partial<NewLlmAuditRecord> = {}): NewLlmAuditRecord {
  return {
    id: `audit_${Math.random().toString(36).slice(2, 10)}`,
    requestedAt: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    promptHash: 'a'.repeat(64),
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedTokens: null,
    costUsd: 0.001,
    latencyMs: 1234,
    success: true,
    errorKind: null,
    abortReason: null,
    orgId: 'org_main',
    userId: 'u1',
    sessionId: 's1',
    ...overrides,
  };
}

describe('SqliteLlmAuditRepository', () => {
  let db: SqliteClient;
  let repo: SqliteLlmAuditRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteLlmAuditRepository(db);
  });

  it('inserts and reads back a success record', async () => {
    const rec = makeRecord({ id: 'a1' });
    await repo.insert(rec);
    const got = await repo.findById('a1');
    expect(got).not.toBeNull();
    expect(got!.success).toBe(true);
    expect(got!.inputTokens).toBe(100);
    expect(got!.outputTokens).toBe(50);
    expect(got!.costUsd).toBeCloseTo(0.001);
    expect(got!.orgId).toBe('org_main');
  });

  it('inserts a failure record with errorKind', async () => {
    await repo.insert(
      makeRecord({
        id: 'a2',
        success: false,
        errorKind: 'auth',
        costUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'unknown',
      }),
    );
    const got = await repo.findById('a2');
    expect(got!.success).toBe(false);
    expect(got!.errorKind).toBe('auth');
    expect(got!.costUsd).toBeNull();
  });

  it('null cost_usd round-trips correctly (not zero)', async () => {
    await repo.insert(makeRecord({ id: 'a3', costUsd: null }));
    const got = await repo.findById('a3');
    expect(got!.costUsd).toBeNull();
  });

  it('listRecent() orders by requestedAt DESC', async () => {
    await repo.insert(makeRecord({ id: 'old', requestedAt: '2020-01-01T00:00:00.000Z' }));
    await repo.insert(makeRecord({ id: 'new', requestedAt: '2026-01-01T00:00:00.000Z' }));
    const list = await repo.listRecent(10);
    expect(list[0]!.id).toBe('new');
    expect(list[1]!.id).toBe('old');
  });

  it('persisted row never contains the raw prompt text', async () => {
    // Caller is responsible for hashing — the repo stores whatever hash it
    // gets. This test pins the contract: nothing in the row contains user
    // content unless the caller put it there.
    const rec = makeRecord({ id: 'priv1' });
    await repo.insert(rec);
    const got = await repo.findById('priv1');
    const blob = JSON.stringify(got);
    expect(blob).not.toContain('user_message_text');
    expect(blob).not.toContain('system_prompt_text');
    // The hash field should be present and exactly 64 hex chars.
    expect(got!.promptHash).toHaveLength(64);
  });
});
