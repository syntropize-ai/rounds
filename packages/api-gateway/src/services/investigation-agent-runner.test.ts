import { describe, it, expect, vi } from 'vitest';
import {
  runInvestigationAgent,
  DEFAULT_AGENT_TIMEOUT_MS,
  type InvestigationStatusStore,
} from './investigation-agent-runner.js';
import type { InvestigationStatus } from '@agentic-obs/common';

function mkStore(initial: InvestigationStatus = 'planning') {
  let status: InvestigationStatus = initial;
  const findById = vi.fn(async (_id: string) => ({ status }));
  const updateStatus = vi.fn(async (_id: string, next: InvestigationStatus) => {
    status = next;
  });
  return {
    store: { findById, updateStatus } as InvestigationStatusStore,
    findById,
    updateStatus,
    get status() {
      return status;
    },
  };
}

describe('runInvestigationAgent', () => {
  it('flips a pre-terminal row to completed on a clean agent run', async () => {
    const s = mkStore('planning');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-1',
      runAgent: async () => 'reply text',
    });
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.finalStatus).toBe('completed');
    expect(result.investigationId).toBe('inv-1');
    expect(s.updateStatus).toHaveBeenCalledWith('inv-1', 'completed');
    expect(s.status).toBe('completed');
  });

  it('flips a pre-terminal row to failed when the agent throws', async () => {
    const s = mkStore('investigating');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-2',
      runAgent: async () => {
        throw new Error('LLM 500');
      },
    });
    expect(result.error?.message).toBe('LLM 500');
    expect(result.timedOut).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(s.updateStatus).toHaveBeenCalledWith('inv-2', 'failed');
  });

  it('marks the row failed when the agent exceeds the timeout', async () => {
    const s = mkStore('planning');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-3',
      // Hangs forever — the timeout must terminate it.
      runAgent: () => new Promise<string>(() => {}),
      timeoutMs: 25,
    });
    expect(result.timedOut).toBe(true);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/timed out/i);
    expect(result.finalStatus).toBe('failed');
    expect(s.updateStatus).toHaveBeenCalledWith('inv-3', 'failed');
  });

  it('is a no-op when the row is already terminal (idempotent)', async () => {
    const s = mkStore('completed');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-4',
      runAgent: async () => 'ok',
    });
    expect(result.finalStatus).toBe('completed');
    expect(s.updateStatus).not.toHaveBeenCalled();
  });

  it('does not overwrite a `failed` already set by the agent itself', async () => {
    const s = mkStore('failed');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-5',
      // Agent set failed then returned cleanly.
      runAgent: async () => 'ok',
    });
    expect(result.finalStatus).toBe('failed');
    expect(s.updateStatus).not.toHaveBeenCalled();
  });

  it('skips finalization when no investigation id can be resolved', async () => {
    const s = mkStore('planning');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => null,
      runAgent: async () => 'ok',
    });
    expect(result.investigationId).toBeNull();
    expect(result.finalStatus).toBeNull();
    expect(s.updateStatus).not.toHaveBeenCalled();
  });

  it('still finalizes when resolveInvestigationId throws', async () => {
    const s = mkStore('planning');
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => {
        throw new Error('db down');
      },
      runAgent: async () => 'ok',
    });
    // The lookup failed so we couldn't finalize, but the call returned
    // cleanly without throwing — caller still gets a structured result.
    expect(result.investigationId).toBeNull();
    expect(result.finalStatus).toBeNull();
    expect(s.updateStatus).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal that aborts on timeout', async () => {
    const s = mkStore('planning');
    let signalSeen: AbortSignal | undefined;
    const result = await runInvestigationAgent({
      investigations: s.store,
      resolveInvestigationId: () => 'inv-6',
      runAgent: (signal) => {
        signalSeen = signal;
        return new Promise<string>(() => {});
      },
      timeoutMs: 20,
    });
    expect(result.timedOut).toBe(true);
    expect(signalSeen?.aborted).toBe(true);
  });

  it('exports a sensible default timeout (10 minutes)', () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});
