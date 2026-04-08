import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Dashboard, DashboardMessage, DashboardSseEvent } from '@agentic-obs/common'
import { OrchestratorAgent } from './orchestrator-agent.js'

function createDashboard(): Dashboard {
  const now = new Date().toISOString()
  return {
    id: 'dash-1',
    type: 'dashboard',
    title: 'Latency',
    description: '',
    prompt: '',
    userId: 'u1',
    status: 'ready',
    panels: [],
    variables: [],
    refreshIntervalSec: 60,
    datasourceIds: [],
    useExistingMetrics: true,
    createdAt: now,
    updatedAt: now,
  }
}

describe('OrchestratorAgent structured alert follow-up', () => {
  const sendEvent = vi.fn()
  const gateway = {
    complete: vi.fn(),
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('modifies the active alert without calling the LLM for a threshold follow-up', async () => {
    const dashboard = createDashboard()
    const history: DashboardMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Created alert.',
        actions: [
          {
            type: 'create_alert_rule',
            ruleId: 'alert_1',
            name: 'HighHTTPPLatency90thPercentile',
            severity: 'high',
            query: 'histogram_quantile(0.9, ...)',
            operator: '>',
            threshold: 300,
            forDurationSec: 300,
            evaluationIntervalSec: 60,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ]

    const alertRuleStore = {
      create: vi.fn(),
      findAll: vi.fn().mockResolvedValue({
        list: [
          {
            id: 'alert_1',
            name: 'HighHTTPPLatency90thPercentile',
            severity: 'high',
            evaluationIntervalSec: 60,
            condition: {
              query: 'histogram_quantile(0.9, ...)',
              operator: '>',
              threshold: 300,
              forDurationSec: 300,
            },
          },
        ],
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'alert_1',
        name: 'HighHTTPPLatency90thPercentile',
        condition: {
          query: 'histogram_quantile(0.9, ...)',
          operator: '>',
          threshold: 300,
          forDurationSec: 300,
        },
      }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
    }

    const agent = new OrchestratorAgent({
      gateway,
      model: 'test-model',
      store: {
        findById: vi.fn().mockResolvedValue(dashboard),
        update: vi.fn(),
        updatePanels: vi.fn(),
        updateVariables: vi.fn(),
      },
      conversationStore: {
        addMessage: vi.fn(),
        getMessages: vi.fn().mockResolvedValue(history),
        clearMessages: vi.fn(),
        deleteConversation: vi.fn(),
      },
      investigationReportStore: { save: vi.fn() },
      alertRuleStore: alertRuleStore as any,
      sendEvent,
    })

    const reply = await agent.handleMessage('dash-1', '算了改成150ms就通知我吧')

    expect(gateway.complete).not.toHaveBeenCalled()
    expect(alertRuleStore.update).toHaveBeenCalledWith(
      'alert_1',
      expect.objectContaining({
        condition: expect.objectContaining({
          threshold: 150,
          operator: '>',
        }),
      }),
    )
    expect(reply).toContain('updated successfully')
  })

  it('deletes the active alert without calling the LLM for a delete follow-up', async () => {
    const dashboard = createDashboard()
    const history: DashboardMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Created alert.',
        actions: [
          {
            type: 'create_alert_rule',
            ruleId: 'alert_1',
            name: 'HighHTTPPLatency90thPercentile',
            severity: 'high',
            query: 'histogram_quantile(0.9, ...)',
            operator: '>',
            threshold: 300,
            forDurationSec: 300,
            evaluationIntervalSec: 60,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ]

    const deleteFn = vi.fn().mockResolvedValue(true)

    const agent = new OrchestratorAgent({
      gateway,
      model: 'test-model',
      store: {
        findById: vi.fn().mockResolvedValue(dashboard),
        update: vi.fn(),
        updatePanels: vi.fn(),
        updateVariables: vi.fn(),
      },
      conversationStore: {
        addMessage: vi.fn(),
        getMessages: vi.fn().mockResolvedValue(history),
        clearMessages: vi.fn(),
        deleteConversation: vi.fn(),
      },
      investigationReportStore: { save: vi.fn() },
      alertRuleStore: {
        create: vi.fn(),
        findAll: vi.fn().mockResolvedValue({
          list: [
            {
              id: 'alert_1',
              name: 'HighHTTPPLatency90thPercentile',
              severity: 'high',
              condition: {
                query: 'histogram_quantile(0.9, ...)',
                operator: '>',
                threshold: 300,
                forDurationSec: 300,
              },
            },
          ],
        }),
        delete: deleteFn,
      } as any,
      sendEvent,
    })

    const reply = await agent.handleMessage('dash-1', '删掉它吧')

    expect(gateway.complete).not.toHaveBeenCalled()
    expect(deleteFn).toHaveBeenCalledWith('alert_1')
    expect(reply).toContain('deleted')
  })
})
