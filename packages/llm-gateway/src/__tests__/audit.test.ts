import { describe, it, expect } from 'vitest';
import { InMemoryAuditSink, type AuditEntry } from '../audit.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'test-1',
    requestedAt: new Date().toISOString(),
    provider: 'test',
    model: 'test-model',
    promptHash: 'abc123',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedTokens: null,
    costUsd: null,
    latencyMs: 100,
    success: true,
    errorKind: null,
    abortReason: null,
    orgId: null,
    userId: null,
    sessionId: null,
    ...overrides,
  };
}

describe('InMemoryAuditSink', () => {
  it('should record and retrieve entries', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(makeEntry({ id: '1' }));
    await sink.record(makeEntry({ id: '2' }));

    expect(sink.getEntries()).toHaveLength(2);
  });

  it('should filter by model', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(makeEntry({ model: 'gpt-4' }));
    await sink.record(makeEntry({ model: 'claude' }));
    await sink.record(makeEntry({ model: 'gpt-4' }));

    expect(sink.getEntriesByModel('gpt-4')).toHaveLength(2);
    expect(sink.getEntriesByModel('claude')).toHaveLength(1);
  });

  it('should calculate total tokens', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(makeEntry({ totalTokens: 100 }));
    await sink.record(makeEntry({ totalTokens: 200 }));

    expect(sink.getTotalTokens()).toBe(300);
  });

  it('should clear entries', async () => {
    const sink = new InMemoryAuditSink();
    await sink.record(makeEntry());
    sink.clear();

    expect(sink.getEntries()).toHaveLength(0);
  });
});
