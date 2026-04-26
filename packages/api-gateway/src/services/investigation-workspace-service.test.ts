import { describe, expect, it, vi } from 'vitest';
import type { Investigation } from '@agentic-obs/common';
import type { IGatewayInvestigationStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import { InvestigationWorkspaceService } from './investigation-workspace-service.js';

function investigation(partial: Partial<Investigation>): Investigation {
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
    status: 'planning',
    hypotheses: [],
    actions: [],
    evidence: [],
    symptoms: [],
    createdAt: '2026-04-25T00:00:00.000Z',
    updatedAt: '2026-04-25T00:00:00.000Z',
    ...partial,
  };
}

function store(investigations: Investigation[]): IGatewayInvestigationStore {
  return {
    findAll: vi.fn().mockResolvedValue(investigations),
    findById: vi.fn(async (id: string) => investigations.find((inv) => inv.id === id) ?? null),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as IGatewayInvestigationStore;
}

function reports(): IInvestigationReportRepository {
  return {
    findByDashboard: vi.fn().mockResolvedValue([{ id: 'rep_1' }, { id: 'rep_2' }]),
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as IInvestigationReportRepository;
}

describe('InvestigationWorkspaceService', () => {
  it('lists summaries for the requested workspace only', async () => {
    const svc = new InvestigationWorkspaceService(
      store([
        investigation({ id: 'inv_a', workspaceId: 'org_a' }),
        investigation({ id: 'inv_b', workspaceId: 'org_b' }),
        investigation({ id: 'inv_default' }),
      ]),
      reports(),
    );

    await expect(svc.listSummaries('org_a')).resolves.toEqual([
      {
        id: 'inv_a',
        status: 'planning',
        intent: 'Investigate latency',
        sessionId: 'ses_1',
        userId: 'u_1',
        createdAt: '2026-04-25T00:00:00.000Z',
        updatedAt: '2026-04-25T00:00:00.000Z',
      },
    ]);
  });

  it('deletes an investigation and cascades its reports within the workspace', async () => {
    const investigationStore = store([investigation({ id: 'inv_a', workspaceId: 'org_a' })]);
    const reportStore = reports();
    const svc = new InvestigationWorkspaceService(investigationStore, reportStore);

    await expect(svc.deleteWithReports('inv_a', 'org_a')).resolves.toBe(true);

    expect(investigationStore.delete).toHaveBeenCalledWith('inv_a');
    expect(reportStore.findByDashboard).toHaveBeenCalledWith('inv_a');
    expect(reportStore.delete).toHaveBeenCalledWith('rep_1');
    expect(reportStore.delete).toHaveBeenCalledWith('rep_2');
  });

  it('does not delete when the investigation is outside the workspace', async () => {
    const investigationStore = store([investigation({ id: 'inv_a', workspaceId: 'org_a' })]);
    const reportStore = reports();
    const svc = new InvestigationWorkspaceService(investigationStore, reportStore);

    await expect(svc.deleteWithReports('inv_a', 'org_b')).resolves.toBe(false);

    expect(investigationStore.delete).not.toHaveBeenCalled();
    expect(reportStore.findByDashboard).not.toHaveBeenCalled();
  });
});
