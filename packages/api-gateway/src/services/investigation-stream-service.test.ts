import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore } from '@agentic-obs/data-layer';
import { InvestigationStreamService } from './investigation-stream-service.js';

function completedInvestigation(): Investigation {
  return {
    id: 'inv_1',
    sessionId: 'ses_1',
    userId: 'u_1',
    intent: 'Investigate latency',
    structuredIntent: {} as Investigation['structuredIntent'],
    plan: {
      entity: 'api',
      objective: 'Find cause',
      steps: [],
      stopConditions: [],
    },
    status: 'completed',
    hypotheses: [],
    actions: [],
    evidence: [],
    symptoms: [],
    workspaceId: 'org_a',
    createdAt: '2026-04-25T00:00:00.000Z',
    updatedAt: '2026-04-25T00:00:00.000Z',
  };
}

describe('InvestigationStreamService', () => {
  it('emits current and final events immediately for terminal investigations', async () => {
    const store = {
      findById: vi.fn().mockResolvedValue(completedInvestigation()),
    } as unknown as IGatewayInvestigationStore;
    const req = new EventEmitter() as Request;
    const writes: string[] = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      end: vi.fn(),
    } as unknown as Response;

    await expect(new InvestigationStreamService(store).stream('inv_1', 'org_a', req, res))
      .resolves.toBe(true);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(writes.join('')).toContain('event: investigation:status');
    expect(writes.join('')).toContain('event: investigation:complete');
    expect(writes.join('')).toContain('event: done');
    expect(res.end).toHaveBeenCalled();
  });

  it('returns false when the investigation is missing', async () => {
    const store = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as IGatewayInvestigationStore;

    await expect(new InvestigationStreamService(store).stream(
      'missing',
      'default',
      new EventEmitter() as Request,
      {} as Response,
    )).resolves.toBe(false);
  });

  it('returns false when the investigation belongs to another workspace', async () => {
    const store = {
      findById: vi.fn().mockResolvedValue({
        ...completedInvestigation(),
        workspaceId: 'org_a',
      }),
    } as unknown as IGatewayInvestigationStore;

    await expect(new InvestigationStreamService(store).stream(
      'inv_1',
      'org_b',
      new EventEmitter() as Request,
      {} as Response,
    )).resolves.toBe(false);
  });
});
