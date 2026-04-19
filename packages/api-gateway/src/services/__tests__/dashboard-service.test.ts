import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dashboard, DashboardMessage, InstanceLlmConfig, InstanceDatasource } from '@agentic-obs/common';

vi.mock('../../routes/llm-factory.js', () => ({
  createLlmGateway: vi.fn(),
}));

vi.mock('@agentic-obs/agent-core', () => ({
  DashboardOrchestratorAgent: vi.fn(function MockDashboardOrchestratorAgent() {
    return {
      handleMessage: vi.fn().mockResolvedValue('Here is your dashboard analysis.'),
      consumeConversationActions: vi.fn().mockReturnValue([]),
      consumeNavigate: vi.fn().mockReturnValue(undefined),
    };
  }),
}));

import { DashboardService } from '../dashboard-service.js';
import type { SetupConfigService } from '../setup-config-service.js';
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js';
import { DashboardOrchestratorAgent } from '@agentic-obs/agent-core';

// -- Minimal stubs ----------------------------------------------------

function createMockDashboardStore(): IGatewayDashboardStore {
  const dashboards = new Map<string, Dashboard>();
  return {
    create: vi.fn((params) => {
      const d = { id: 'dash-1', ...params, status: 'generating', panels: [], variables: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as Dashboard;
      dashboards.set(d.id, d);
      return d;
    }),
    findById: vi.fn((id: string) => dashboards.get(id)),
    findAll: vi.fn(() => [...dashboards.values()]),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(),
    updateVariables: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockConversationStore(): IConversationStore {
  const messages = new Map<string, DashboardMessage[]>();
  return {
    addMessage: vi.fn((dashboardId: string, msg: DashboardMessage) => {
      const existing = messages.get(dashboardId) ?? [];
      existing.push(msg);
      messages.set(dashboardId, existing);
      return msg;
    }),
    getMessages: vi.fn((dashboardId: string) => messages.get(dashboardId) ?? []),
    clearMessages: vi.fn(),
    deleteConversation: vi.fn(),
  };
}

function createStubSetupConfig(
  llm: InstanceLlmConfig | null,
  datasources: InstanceDatasource[] = [],
): SetupConfigService {
  return {
    getLlm: vi.fn().mockResolvedValue(llm),
    listDatasources: vi.fn().mockResolvedValue(datasources),
  } as unknown as SetupConfigService;
}

function buildLlm(partial: Partial<InstanceLlmConfig> = {}): InstanceLlmConfig {
  return {
    provider: 'anthropic',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    baseUrl: null,
    authType: null,
    region: null,
    updatedAt: '2026-04-18T00:00:00.000Z',
    updatedBy: null,
    ...partial,
  };
}

function buildDatasource(partial: Partial<InstanceDatasource> = {}): InstanceDatasource {
  return {
    id: 'ds-1',
    orgId: null,
    type: 'prometheus',
    name: 'Prom',
    url: 'http://prom:9090',
    environment: null,
    cluster: null,
    label: null,
    isDefault: false,
    apiKey: null,
    username: null,
    password: null,
    createdAt: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
    updatedBy: null,
    ...partial,
  };
}

describe('DashboardService', () => {
  let service: DashboardService;
  let dashboardStore: IGatewayDashboardStore;
  let conversationStore: IConversationStore;
  const mockSendEvent = vi.fn();
  const stubAccessControl = {
    getUserPermissions: vi.fn().mockResolvedValue([]),
    evaluate: vi.fn().mockResolvedValue(true),
    ensurePermissions: vi.fn().mockResolvedValue([]),
    filterByPermission: vi.fn(async (_id: unknown, items: readonly unknown[]) => [...items]),
  };
  const testIdentity = {
    userId: 'u-test', orgId: 'o-test', orgRole: 'Admin' as const,
    isServerAdmin: false, authenticatedBy: 'session' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dashboardStore = createMockDashboardStore();
    conversationStore = createMockConversationStore();
  });

  it('handleChatMessage() throws if LLM not configured', async () => {
    service = new DashboardService({
      store: dashboardStore,
      conversationStore,
      investigationReportStore: {} as never,
      alertRuleStore: {} as never,
      accessControl: stubAccessControl as never,
      setupConfig: createStubSetupConfig(null),
    });

    await expect(
      service.handleChatMessage('dash-1', 'hello', undefined, mockSendEvent, testIdentity),
    ).rejects.toThrow('LLM not configured');
  });

  it('handleChatMessage() calls orchestrator and returns reply', async () => {
    service = new DashboardService({
      store: dashboardStore,
      conversationStore,
      investigationReportStore: {} as never,
      alertRuleStore: {} as never,
      accessControl: stubAccessControl as never,
      setupConfig: createStubSetupConfig(buildLlm(), [buildDatasource()]),
    });

    const result = await service.handleChatMessage('dash-1', 'Show CPU', undefined, mockSendEvent, testIdentity);

    expect(result.replyContent).toBe('Here is your dashboard analysis.');
    expect(result.assistantMessageId).toBeDefined();
  });

  it('handleChatMessage() saves user and assistant messages', async () => {
    service = new DashboardService({
      store: dashboardStore,
      conversationStore,
      investigationReportStore: {} as never,
      alertRuleStore: {} as never,
      accessControl: stubAccessControl as never,
      setupConfig: createStubSetupConfig(buildLlm()),
    });

    await service.handleChatMessage('dash-1', 'Show CPU', undefined, mockSendEvent, testIdentity);

    expect(conversationStore.addMessage).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(conversationStore.addMessage).mock.calls;
    expect(calls[0]![0]).toBe('dash-1');
    expect(calls[0]![1]!.role).toBe('user');
    expect(calls[0]![1]!.content).toBe('Show CPU');
    expect(calls[1]![0]).toBe('dash-1');
    expect(calls[1]![1]!.role).toBe('assistant');
    expect(calls[1]![1]!.content).toBe('Here is your dashboard analysis.');
  });

  it('handleChatMessage() forwards absolute time range and timezone to the orchestrator', async () => {
    service = new DashboardService({
      store: dashboardStore,
      conversationStore,
      investigationReportStore: {} as never,
      alertRuleStore: {} as never,
      accessControl: stubAccessControl as never,
      setupConfig: createStubSetupConfig(buildLlm()),
    });

    await service.handleChatMessage(
      'dash-1',
      'Explain Average Latency',
      {
        start: '2026-04-08T01:16:00.000Z',
        end: '2026-04-08T01:45:00.000Z',
        timezone: 'America/Toronto',
      },
      mockSendEvent,
      testIdentity,
    );

    expect(vi.mocked(DashboardOrchestratorAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: {
          start: '2026-04-08T01:16:00.000Z',
          end: '2026-04-08T01:45:00.000Z',
          timezone: 'America/Toronto',
        },
      }),
    );
  });

  it('handleChatMessage() does not create a duplicate investigation when dashboard investigate emits completion', async () => {
    const investigationStore = {
      create: vi.fn(),
      updateStatus: vi.fn(),
    };

    vi.mocked(DashboardOrchestratorAgent).mockImplementationOnce(function MockDashboardOrchestratorAgent(args: any) {
      return {
        handleMessage: vi.fn().mockImplementation(async () => {
          args.sendEvent({
            type: 'tool_result',
            tool: 'investigate',
            summary: 'Investigation complete — 3 evidence panels added.',
            success: true,
          });
          return 'Investigation summary.';
        }),
        consumeConversationActions: vi.fn().mockReturnValue([]),
        consumeNavigate: vi.fn().mockReturnValue('/investigations/inv-1'),
      } as any;
    });

    service = new DashboardService({
      store: dashboardStore,
      conversationStore,
      investigationReportStore: {} as never,
      alertRuleStore: {} as never,
      investigationStore: investigationStore as never,
      accessControl: stubAccessControl as never,
      setupConfig: createStubSetupConfig(buildLlm(), [buildDatasource()]),
    });

    await service.handleChatMessage('dash-1', 'Why is p95 high?', undefined, mockSendEvent, testIdentity);

    expect(investigationStore.create).not.toHaveBeenCalled();
    expect(investigationStore.updateStatus).not.toHaveBeenCalled();
  });
});
