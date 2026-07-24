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
    findSeriesFull: vi.fn().mockResolvedValue([]),
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

describe('OrchestratorAgent alert follow-up (ReAct loop)', () => {
  const sendEvent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  type LoopResponse = { content: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
  function queueGateway(responses: LoopResponse[]) {
    const q = [...responses]
    return {
      complete: vi.fn().mockImplementation(() => Promise.resolve(q.shift() ?? { content: 'done', toolCalls: [] })),
    }
  }

  function alertHistory(): DashboardMessage[] {
    return [
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
  }

  function makeAlertRuleStore() {
    return {
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
      delete: vi.fn().mockResolvedValue(true),
    }
  }

  function makeAgent(gateway: ReturnType<typeof queueGateway>, alertRuleStore: ReturnType<typeof makeAlertRuleStore>) {
    return new OrchestratorAgent({
      gateway: gateway as any,
      model: 'test-model',
      store: {
        findById: vi.fn().mockResolvedValue(createDashboard()),
        update: vi.fn(),
        updatePanels: vi.fn(),
        updateVariables: vi.fn(),
      },
      conversationStore: {
        addMessage: vi.fn(),
        getMessages: vi.fn().mockResolvedValue(alertHistory()),
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
  }

  it('modifies the active alert when the LLM emits an alert_rule_write update call', async () => {
    const gateway = queueGateway([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'alert_rule_write', input: { op: 'update', ruleId: 'alert_1', patch: { threshold: 150 } } }],
      },
      { content: 'Updated the existing alert to trigger at 150ms.', toolCalls: [] },
    ])
    const alertRuleStore = makeAlertRuleStore()
    const agent = makeAgent(gateway, alertRuleStore)

    const reply = await agent.handleMessage('just change it to 150ms and notify me', 'dash-1')

    expect(gateway.complete).toHaveBeenCalledTimes(2)
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

  it('deletes the active alert when the LLM emits an alert_rule_write delete call', async () => {
    const gateway = queueGateway([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'alert_rule_write', input: { op: 'delete', ruleId: 'alert_1' } }],
      },
      { content: 'Deleted the existing alert.', toolCalls: [] },
    ])
    const alertRuleStore = makeAlertRuleStore()
    const agent = makeAgent(gateway, alertRuleStore)

    const reply = await agent.handleMessage('delete it', 'dash-1')

    expect(gateway.complete).toHaveBeenCalledTimes(2)
    expect(alertRuleStore.delete).toHaveBeenCalledWith('alert_1')
    expect(reply.toLowerCase()).toContain('deleted')
  })

  it('does not delete the alert for an analysis question containing "drop"', async () => {
    const gateway = queueGateway([
      { content: 'p99 dropped at 3pm because traffic shifted away from the slow route.', toolCalls: [] },
    ])
    const alertRuleStore = makeAlertRuleStore()
    const agent = makeAgent(gateway, alertRuleStore)

    const reply = await agent.handleMessage('why did p99 drop at 3pm?', 'dash-1')

    expect(gateway.complete).toHaveBeenCalled()
    expect(alertRuleStore.delete).not.toHaveBeenCalled()
    expect(alertRuleStore.update).not.toHaveBeenCalled()
    expect(reply).toContain('traffic')
  })

  it('does not rewrite the threshold for a data question containing a number', async () => {
    const gateway = queueGateway([
      { content: 'Here is the CPU usage over the last 30 minutes.', toolCalls: [] },
    ])
    const alertRuleStore = makeAlertRuleStore()
    const agent = makeAgent(gateway, alertRuleStore)

    const reply = await agent.handleMessage('show me the last 30 minutes of CPU', 'dash-1')

    expect(gateway.complete).toHaveBeenCalled()
    expect(alertRuleStore.update).not.toHaveBeenCalled()
    expect(alertRuleStore.delete).not.toHaveBeenCalled()
    expect(reply).toContain('CPU')
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

describe('OrchestratorAgent investigation reopen (follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  type LoopResponse = { content: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
  function queueGateway(responses: LoopResponse[]) {
    const q = [...responses]
    return {
      // Anything past the queue ends the turn with plain text.
      complete: vi.fn().mockImplementation(() => Promise.resolve(q.shift() ?? { content: 'done', toolCalls: [] })),
    }
  }

  it('reopens an existing report and updates it in place (same id, sections rehydrated)', async () => {
    const existingReport = {
      id: 'report_x',
      dashboardId: 'inv_1', // investigation id lives here
      goal: 'why slow',
      summary: 'old summary',
      sections: [
        { type: 'text', content: '## Symptom\n\np99 high.' },
        { type: 'evidence', content: 'p99 by route shows the bad Envoy path.' },
        { type: 'text', content: '## Unresolved\n\nWhich EnvoyFilter?' },
      ],
      createdAt: '2026-04-26T00:00:00.000Z',
      provenance: { runId: 'inv_1', model: 'test-model', evidenceCount: 1, readToolCalls: 2, metricReadCalls: 1, opsReadCalls: 1 },
    }
    const reportStore = {
      save: vi.fn(),
      findByDashboard: vi.fn().mockResolvedValue([existingReport]),
    }
    const investigation = {
      id: 'inv_1',
      sessionId: 'ses_1',
      userId: 'u1',
      intent: 'why slow',
      structuredIntent: {},
      plan: { entity: 'api', objective: 'why slow', steps: [], stopConditions: [] },
      status: 'completed',
      hypotheses: [],
      actions: [],
      evidence: [],
      symptoms: [],
      workspaceId: 'test-org', // matches makeTestIdentity().orgId
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    const investigationStore = {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue(investigation),
      updateStatus: vi.fn(),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    }
    const gateway = queueGateway([
      { content: '', toolCalls: [{ id: 'c1', name: 'investigation_add_text', input: { content: '## Root cause\n\nEnvoyFilter foo merges a bad filter_chain_match.' } }] },
      { content: '', toolCalls: [{ id: 'r1', name: 'investigation_record_check', input: {
        hypothesis: 'EnvoyFilter foo is causing the bad Envoy path',
        signalType: 'config',
        tool: 'ops_run_command',
        query: 'kubectl get envoyfilter foo -o yaml',
        result: 'EnvoyFilter foo contains a filter_chain_match for the failing path',
        interpretation: 'Supports a specific config object root cause.',
        status: 'supported',
      } }] },
      { content: '', toolCalls: [{ id: 'r2', name: 'investigation_record_check', input: {
        hypothesis: 'traffic or scrape artifact explains the symptom',
        signalType: 'metric',
        tool: 'metrics_range_query',
        query: 'request rate and errors by route',
        result: 'traffic is present; errors isolate to the Envoy path',
        interpretation: 'Rules out no traffic and scrape artifact.',
        status: 'ruled_out',
      } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'investigation_complete', input: {
        summary: 'EnvoyFilter foo is the likely cause; delete it.',
        rootCause: {
          status: 'likely',
          object: 'EnvoyFilter/foo',
          field: 'filter_chain_match',
          cause: 'bad filter_chain_match routes requests into the failing Envoy path',
        },
        confidence: 0.86,
        evidenceRefs: ['check_1', 'check_2'],
        ruledOut: ['no traffic', 'scrape artifact'],
        nextAction: 'Delete or roll back EnvoyFilter foo.',
        validationMethod: 'verify p99 latency returns to baseline after rollback',
      } }] },
      { content: 'Delete EnvoyFilter foo.', toolCalls: [] },
    ])

    const agent = new OrchestratorAgent({
      gateway: gateway as any,
      model: 'test-model',
      store: {
        findById: vi.fn().mockResolvedValue(undefined),
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
      investigationReportStore: reportStore as any,
      investigationStore: investigationStore as any,
      alertRuleStore: { create: vi.fn() } as any,
      adapters: buildFakeMetricsAdapters(),
      sendEvent: vi.fn(),
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    await agent.handleMessage(
      'keep digging on that EnvoyFilter',
      undefined,
      undefined,
      { reopenInvestigationId: 'inv_1' },
    )

    // Reopen consulted the report store + ownership gate.
    expect(reportStore.findByDashboard).toHaveBeenCalledWith('inv_1')
    expect(investigationStore.findById).toHaveBeenCalledWith('inv_1')
    // Updated the SAME row (id reused) rather than inserting a new report.
    expect(reportStore.save).toHaveBeenCalledTimes(1)
    const saved = reportStore.save.mock.calls[0]![0]
    expect(saved.id).toBe('report_x')
    expect(saved.dashboardId).toBe('inv_1')
    // Prior 3 sections rehydrated + the new one appended + auto evidence/conclusion sections.
    expect(saved.sections).toHaveLength(6)
    expect(saved.sections.some((s: { content: string }) => s.content.includes('## Root cause'))).toBe(true)
    expect(saved.sections.some((s: { content: string }) => s.content.includes('## Evidence Trail'))).toBe(true)
    expect(saved.sections.some((s: { content: string }) => s.content.includes('EnvoyFilter foo contains'))).toBe(true)
  })

  it('keeps a prior passed gate when a reopened follow-up records no new checks', async () => {
    const priorGate = {
      status: 'passed' as const,
      reasons: [],
      rootCause: {
        status: 'likely' as const,
        object: 'EnvoyFilter/foo',
        field: 'filter_chain_match',
        cause: 'bad filter_chain_match routes requests into the failing Envoy path',
      },
      confidence: 0.86,
      evidenceRefs: ['check_1', 'check_2'],
      ruledOut: ['no traffic', 'scrape artifact'],
      validationMethod: 'verify p99 latency returns to baseline after rollback',
      evaluatedAt: '2026-04-26T00:00:00.000Z',
    }
    const existingReport = {
      id: 'report_x',
      dashboardId: 'inv_1',
      goal: 'why slow',
      summary: 'EnvoyFilter foo is the likely cause.',
      sections: [
        { type: 'text', content: '## Symptom\n\np99 high.' },
        { type: 'evidence', content: 'p99 by route shows the bad Envoy path.' },
      ],
      createdAt: '2026-04-26T00:00:00.000Z',
      provenance: { runId: 'inv_1', model: 'test-model', evidenceCount: 1, rootCauseGate: priorGate },
    }
    const reportStore = {
      save: vi.fn(),
      findByDashboard: vi.fn().mockResolvedValue([existingReport]),
    }
    const investigationStore = {
      create: vi.fn(),
      findById: vi.fn().mockResolvedValue({
        id: 'inv_1',
        sessionId: 'ses_1',
        userId: 'u1',
        intent: 'why slow',
        structuredIntent: {},
        plan: { entity: 'api', objective: 'why slow', steps: [], stopConditions: [] },
        status: 'completed',
        hypotheses: [],
        actions: [],
        evidence: [],
        symptoms: [],
        workspaceId: 'test-org',
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
      }),
      updateStatus: vi.fn(),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    }
    // Follow-up adds prose only — no investigation_record_check this session.
    const gateway = queueGateway([
      { content: '', toolCalls: [{ id: 'c1', name: 'investigation_add_text', input: { content: '## Remediation note\n\nDeleting EnvoyFilter foo is safe during business hours.' } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'investigation_complete', input: {
        summary: 'EnvoyFilter foo is the likely cause; delete it.',
        rootCause: {
          status: 'likely',
          object: 'EnvoyFilter/foo',
          field: 'filter_chain_match',
          cause: 'bad filter_chain_match routes requests into the failing Envoy path',
        },
        confidence: 0.86,
        evidenceRefs: ['check_1', 'check_2'],
        ruledOut: ['no traffic', 'scrape artifact'],
        nextAction: 'Delete or roll back EnvoyFilter foo.',
      } }] },
      { content: 'Done.', toolCalls: [] },
    ])

    const agent = new OrchestratorAgent({
      gateway: gateway as any,
      model: 'test-model',
      store: {
        findById: vi.fn().mockResolvedValue(undefined),
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
      investigationReportStore: reportStore as any,
      investigationStore: investigationStore as any,
      alertRuleStore: { create: vi.fn() } as any,
      adapters: buildFakeMetricsAdapters(),
      sendEvent: vi.fn(),
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    await agent.handleMessage(
      'add a remediation note',
      undefined,
      undefined,
      { reopenInvestigationId: 'inv_1' },
    )

    expect(reportStore.save).toHaveBeenCalledTimes(1)
    const saved = reportStore.save.mock.calls[0]![0]
    expect(saved.id).toBe('report_x')
    // The verified report is NOT downgraded: gate stays passed with the prior
    // confidence, and no Unresolved section is appended.
    expect(saved.provenance?.rootCauseGate?.status).toBe('passed')
    expect(saved.provenance?.rootCauseGate?.confidence).toBe(0.86)
    expect(saved.sections).toHaveLength(3)
    expect(saved.sections.some((s: { content: string }) => s.content.includes('## Unresolved'))).toBe(false)
  })

  it('does not reopen when no prior report exists (fresh follow-up)', async () => {
    const reportStore = { save: vi.fn(), findByDashboard: vi.fn().mockResolvedValue([]) }
    const gateway = queueGateway([{ content: 'Nothing to add.', toolCalls: [] }])
    const agent = new OrchestratorAgent({
      gateway: gateway as any,
      model: 'test-model',
      store: { findById: vi.fn().mockResolvedValue(undefined), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() },
      conversationStore: { addMessage: vi.fn(), getMessages: vi.fn().mockResolvedValue([]), clearMessages: vi.fn(), deleteConversation: vi.fn() },
      investigationReportStore: reportStore as any,
      investigationStore: { create: vi.fn(), findById: vi.fn().mockResolvedValue(undefined), updateStatus: vi.fn(), updatePlan: vi.fn(), updateResult: vi.fn() } as any,
      alertRuleStore: { create: vi.fn() } as any,
      adapters: buildFakeMetricsAdapters(),
      sendEvent: vi.fn(),
      identity: makeTestIdentity(),
      accessControl: new AccessControlStub(),
    })

    await agent.handleMessage('follow up', undefined, undefined, { reopenInvestigationId: 'inv_missing' })

    // findById returns undefined -> ownership gate stops before findByDashboard.
    expect(reportStore.save).not.toHaveBeenCalled()
  })
})
