import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dashboard, DashboardMessage } from '@agentic-obs/common';

// Mock the setup module before importing DashboardService
vi.mock('../../routes/setup.js', () => ({
  getSetupConfig: vi.fn(),
}));

vi.mock('../../routes/llm-factory.js', () => ({
  createLlmGateway: vi.fn(),
}));

vi.mock('@agentic-obs/agent-core', () => ({
  DashboardOrchestratorAgent: vi.fn().mockImplementation(() => ({
    handleMessage: vi.fn().mockResolvedValue('Here is your dashboard analysis.'),
  })),
}));

import { DashboardService } from '../dashboard-service.js';
import { getSetupConfig } from '../../routes/setup.js';
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js';

// -- Minimal mock stores

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

describe('DashboardService', () => {
  let service: DashboardService;
  let dashboardStore: IGatewayDashboardStore;
  let conversationStore: IConversationStore;
  const mockSendEvent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    dashboardStore = createMockDashboardStore();
    conversationStore = createMockConversationStore();
    service = new DashboardService(dashboardStore, conversationStore);
  });

  it('handleChatMessage() throws if LLM not configured', async () => {
    vi.mocked(getSetupConfig).mockReturnValue({
      configured: false,
      datasources: [],
      llm: undefined,
    });

    await expect(
      service.handleChatMessage('dash-1', 'hello', mockSendEvent),
    ).rejects.toThrow('LLM not configured');
  });

  it('handleChatMessage() calls orchestrator and returns reply', async () => {
    vi.mocked(getSetupConfig).mockReturnValue({
      configured: true,
      datasources: [{ id: 'ds-1', type: 'prometheus', name: 'Prom', url: 'http://prom:9090' }],
      llm: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
    });

    const result = await service.handleChatMessage('dash-1', 'Show CPU', mockSendEvent);

    expect(result.replyContent).toBe('Here is your dashboard analysis.');
    expect(result.assistantMessageId).toBeDefined();
  });

  it('handleChatMessage() saves user and assistant messages', async () => {
    vi.mocked(getSetupConfig).mockReturnValue({
      configured: true,
      datasources: [],
      llm: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-6' },
    });

    await service.handleChatMessage('dash-1', 'Show CPU', mockSendEvent);

    // Should have called addMessage twice: once for user, once for assistant
    expect(conversationStore.addMessage).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(conversationStore.addMessage).mock.calls;
    // First call: user message
    expect(calls[0]![0]).toBe('dash-1');
    expect(calls[0]![1]!.role).toBe('user');
    expect(calls[0]![1]!.content).toBe('Show CPU');

    // Second call: assistant message
    expect(calls[1]![0]).toBe('dash-1');
    expect(calls[1]![1]!.role).toBe('assistant');
    expect(calls[1]![1]!.content).toBe('Here is your dashboard analysis.');
  });
});
