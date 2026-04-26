import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Dashboard, DashboardMessage } from '@agentic-obs/common'
import { OrchestratorAgent } from './orchestrator-agent.js'
import { AccessControlStub, makeTestIdentity } from './test-helpers.js'
import { AdapterRegistry, type IMetricsAdapter } from '../adapters/index.js'

/**
 * Build a fresh AdapterRegistry that owns a single fake Prometheus metrics
 * adapter under `id: 'prom-test'` (+ `isDefault: true`). Tests can override
 * specific adapter methods via `overrides`.
 */
function buildFakeMetricsAdapters(overrides: Partial<IMetricsAdapter> = {}): AdapterRegistry {
  const registry = new AdapterRegistry()
  const metrics: IMetricsAdapter = {
    listMetricNames: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue([]),
    listLabelValues: vi.fn().mockResolvedValue([]),
    findSeries: vi.fn().mockResolvedValue([]),
    fetchMetadata: vi.fn().mockResolvedValue({}),
    instantQuery: vi.fn().mockResolvedValue([]),
    rangeQuery: vi.fn().mockResolvedValue([]),
    testQuery: vi.fn().mockResolvedValue({ ok: true }),
    isHealthy: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
  registry.register({
    info: {
      id: 'prom-test',
      name: 'Prom Test',
      type: 'prometheus',
      signalType: 'metrics',
      isDefault: true,
    },
    metrics,
  })
  return registry
}

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
    gateway.complete.mockResolvedValueOnce({ content: 'Updated the existing alert to trigger at 150ms.' })
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
      adapters: buildFakeMetricsAdapters(),
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    const reply = await agent.handleMessage('just change it to 150ms and notify me', 'dash-1')

    expect(gateway.complete).toHaveBeenCalledTimes(1)
    expect(alertRuleStore.update).toHaveBeenCalledWith(
      'alert_1',
      expect.objectContaining({
        condition: expect.objectContaining({
          threshold: 150,
          operator: '>',
        }),
      }),
    )
    expect(reply).toContain('150ms')
  })

  it('deletes the active alert without calling the LLM for a delete follow-up', async () => {
    const dashboard = createDashboard()
    gateway.complete.mockResolvedValueOnce({ content: 'Deleted the existing alert.' })
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
      adapters: buildFakeMetricsAdapters(),
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    const reply = await agent.handleMessage('delete it', 'dash-1')

    expect(gateway.complete).toHaveBeenCalledTimes(1)
    expect(deleteFn).toHaveBeenCalledWith('alert_1')
    expect(reply.toLowerCase()).toContain('deleted')
  })
})

describe('OrchestratorAgent panel explanation', () => {
  const sendEvent = vi.fn()
  const gateway = {
    complete: vi.fn(),
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('explains a panel using live data without routing to investigation', async () => {
    const now = new Date().toISOString()
    const dashboard: Dashboard = {
      id: 'dash-1',
      type: 'dashboard',
      title: 'Latency',
      description: '',
      prompt: '',
      userId: 'u1',
      status: 'ready',
      panels: [
        {
          id: 'panel-avg',
          title: 'Average Latency',
          description: '',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr: 'rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])' }],
          row: 0,
          col: 0,
          width: 6,
          height: 3,
        },
      ],
      variables: [],
      refreshIntervalSec: 60,
      datasourceIds: [],
      useExistingMetrics: true,
      createdAt: now,
      updatedAt: now,
    }

    gateway.complete.mockResolvedValueOnce({
      content: 'Over the past hour, Average Latency has been stable around 0.24s, ranging from 0.21s to 0.27s with no significant degradation trend.',
      toolCalls: [],
    })

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
        getMessages: vi.fn().mockResolvedValue([]),
        clearMessages: vi.fn(),
        deleteConversation: vi.fn(),
      },
      investigationReportStore: { save: vi.fn() },
      alertRuleStore: { create: vi.fn() } as any,
      adapters: buildFakeMetricsAdapters({
        rangeQuery: vi.fn().mockResolvedValue([
          {
            metric: {},
            values: [
              [1, '0.21'],
              [2, '0.24'],
              [3, '0.27'],
            ],
          },
        ]),
      }),
      timeRange: {
        start: '2026-04-08T00:00:00.000Z',
        end: '2026-04-08T01:00:00.000Z',
      },
      sendEvent,
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    const reply = await agent.handleMessage('explain the Average Latency data trend', 'dash-1')

    expect(reply).toContain('Average Latency')
    expect(gateway.complete).toHaveBeenCalledTimes(1)
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'reply',
      content: 'Over the past hour, Average Latency has been stable around 0.24s, ranging from 0.21s to 0.27s with no significant degradation trend.',
    })
  })
})

