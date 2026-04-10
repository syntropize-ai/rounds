import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dashboard-service.js', () => ({
  DashboardService: vi.fn().mockImplementation(() => ({
    handleChatMessage: vi.fn().mockResolvedValue({
      replyContent: 'Dashboard reply',
      assistantMessageId: 'msg-1',
      navigate: '/investigations/inv-2',
    }),
  })),
}));

vi.mock('../intent-service.js', () => ({
  IntentService: vi.fn().mockImplementation(() => ({
    processMessage: vi.fn().mockResolvedValue({
      intent: 'dashboard',
      dashboardId: 'dash-2',
      navigate: '/dashboards/dash-2',
    }),
    classifyIntent: vi.fn().mockResolvedValue('investigate'),
    executeDashboardIntent: vi.fn(),
    executeAlertIntent: vi.fn(),
    executeInvestigateIntent: vi.fn(),
  })),
}));

vi.mock('../../routes/setup.js', () => ({
  getSetupConfig: vi.fn().mockReturnValue({
    llm: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
    datasources: [],
  }),
}));

vi.mock('../../routes/llm-factory.js', () => ({
  createLlmGateway: vi.fn().mockReturnValue({
    complete: vi.fn().mockResolvedValue({ content: 'Investigation reply' }),
  }),
}));

import { AgentChatService } from '../agent-chat-service.js';
import { DashboardService } from '../dashboard-service.js';
import { IntentService } from '../intent-service.js';

describe('AgentChatService', () => {
  const deps = {
    dashboardStore: {} as any,
    conversationStore: {} as any,
    investigationReportStore: {
      findByDashboard: vi.fn().mockResolvedValue([]),
    } as any,
    alertRuleStore: {} as any,
    investigationStore: {
      findById: vi.fn().mockResolvedValue({
        id: 'inv-1',
        intent: 'Why is p95 high?',
        sessionId: 'ses-1',
        status: 'completed',
        plan: { objective: 'Why is p95 high?' },
        evidence: [],
        hypotheses: [],
      }),
      getConclusion: vi.fn().mockResolvedValue({
        summary: 'Checkout traffic increased.',
      }),
    } as any,
    feedStore: {} as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    deps.investigationReportStore.findByDashboard = vi.fn().mockResolvedValue([]);
    deps.investigationStore.findById = vi.fn().mockResolvedValue({
      id: 'inv-1',
      intent: 'Why is p95 high?',
      sessionId: 'ses-1',
      status: 'completed',
      plan: { objective: 'Why is p95 high?' },
      evidence: [],
      hypotheses: [],
    });
    deps.investigationStore.getConclusion = vi.fn().mockResolvedValue({
      summary: 'Checkout traffic increased.',
    });
  });

  it('routes home chat through IntentService', async () => {
    const service = new AgentChatService(deps);
    const sendEvent = vi.fn();

    const result = await service.chat('Create a dashboard', { kind: 'home' }, sendEvent as any);

    expect(IntentService).toHaveBeenCalled();
    expect(result.navigate).toBe('/dashboards/dash-2');
  });

  it('routes dashboard chat through DashboardService', async () => {
    const service = new AgentChatService(deps);
    const sendEvent = vi.fn();

    const result = await service.chat('Explain this panel', { kind: 'dashboard', id: 'dash-1' }, sendEvent as any);

    expect(DashboardService).toHaveBeenCalled();
    expect(result.navigate).toBe('/investigations/inv-2');
    expect(result.replyContent).toBe('Dashboard reply');
  });

  it('answers investigation follow-up in the current investigation context', async () => {
    const service = new AgentChatService(deps);
    const sendEvent = vi.fn();

    const result = await service.chat('What is the root cause?', { kind: 'investigation', id: 'inv-1' }, sendEvent as any);

    expect(result.navigate).toBe('/investigations/inv-1');
    expect(result.replyContent).toBe('Investigation reply');
    expect(sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'reply',
      content: 'Investigation reply',
    }));
  });
});
