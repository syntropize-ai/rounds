import type { PanelConfig, DashboardVariable } from '@agentic-obs/common'

// -- Planner Output

export interface DashboardPlan {
  title: string
  description: string
  groups: PanelGroup[]
  variables: VariableSuggestion[]
}

export interface PanelGroup {
  id: string
  label: string
  purpose: string
  panelSpecs: PanelSpec[]
}

export interface PanelSpec {
  title: string
  description: string
  visualization: string
  queryIntent: string
}

export interface VariableSuggestion {
  name: string
  label: string
  purpose: string
}

// -- Critic Output

export interface CriticFeedback {
  approved: boolean
  overallScore: number
  issues: CriticIssue[]
}

export interface CriticIssue {
  panelTitle: string
  severity: 'error' | 'warning'
  category: string
  description: string
  suggestedFix?: string
}

// -- Generator I/O

export interface RawPanelSpec {
  title: string
  description: string
  visualization: string
  queries: Array<{
    refId: string
    expr: string
    legendFormat?: string
    instant?: boolean
  }>
  row: number
  col: number
  width: number
  height: number
  unit?: string
  stackMode?: 'none' | 'normal' | 'percent'
  fillOpacity?: number
  decimals?: number
  thresholds?: Array<{ value: number, color: string, label?: string }>
}

// -- Shared Deps

export interface GeneratorDeps {
  gateway: import('@agentic-obs/llm-gateway').LLMGateway
  model: string
  metrics?: import('../adapters/index.js').IMetricsAdapter
  sendEvent: (event: import('@agentic-obs/common').DashboardSseEvent) => void
}

export interface GenerateInput {
  goal: string
  scope?: 'single' | 'group' | 'comprehensive'
  existingPanels: PanelConfig[]
  existingVariables: DashboardVariable[]
}

export interface GenerateOutput {
  title: string
  description: string
  panels: PanelConfig[]
  variables: DashboardVariable[]
  /** Set when discovery found 0 relevant metrics — caller should ask the user for clarification */
  needsClarification?: {
    searchedFor: string
    totalMetricsInPrometheus: number
    candidateMetrics: string[]
  }
}

// -- Injected dependency interfaces for stores consumed by dashboard agents.
// Concrete implementations live in api-gateway (or data-layer); agents depend
// only on these narrow interfaces.

export interface IDashboardAgentStore {
  create?(params: {
    title: string
    description: string
    prompt: string
    userId: string
    datasourceIds: string[]
    useExistingMetrics?: boolean
    folder?: string
    workspaceId?: string
  }): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard>
  findById(id: string): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard | undefined> | undefined
  update(id: string, patch: Partial<Pick<import('@agentic-obs/common').Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'folder'>>): unknown
  updateStatus?(id: string, status: string, error?: string): unknown
  updatePanels(id: string, panels: PanelConfig[]): unknown
  updateVariables(id: string, variables: DashboardVariable[]): unknown
}

export interface IConversationStore {
  addMessage(dashboardId: string, msg: import('@agentic-obs/common').DashboardMessage): import('@agentic-obs/common').DashboardMessage | Promise<import('@agentic-obs/common').DashboardMessage>
  getMessages(dashboardId: string): import('@agentic-obs/common').DashboardMessage[] | Promise<import('@agentic-obs/common').DashboardMessage[]>
  clearMessages(dashboardId: string): void | Promise<void>
  deleteConversation(dashboardId: string): void | Promise<void>
}

export interface IInvestigationReportStore {
  save(report: import('@agentic-obs/common').SavedInvestigationReport): void
}

export interface IInvestigationStore {
  create(params: {
    question: string
    sessionId: string
    userId: string
    entity?: string
    timeRange?: { start: string, end: string }
    tenantId?: string
    workspaceId?: string
  }): import('@agentic-obs/common').Investigation | Promise<import('@agentic-obs/common').Investigation>
  updateStatus(id: string, status: import('@agentic-obs/common').InvestigationStatus): unknown
  updatePlan(id: string, plan: import('@agentic-obs/common').Investigation['plan']): unknown
  updateResult(id: string, result: {
    hypotheses: import('@agentic-obs/common').Hypothesis[]
    evidence: import('@agentic-obs/common').Evidence[]
    conclusion: import('@agentic-obs/common').ExplanationResult | null
  }): unknown
}

export interface IAlertRuleStore {
  create(data: Record<string, unknown>): { name: string, severity: string, evaluationIntervalSec: number, condition: { query: string, operator: string, threshold: number, forDurationSec: number }, id?: string } | Promise<{ name: string, severity: string, evaluationIntervalSec: number, condition: { query: string, operator: string, threshold: number, forDurationSec: number }, id?: string }>
  update?(id: string, patch: Record<string, unknown>): unknown
  findAll?(): { id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[] | Promise<{ id: string, name: string, severity: string, condition: { query: string, operator: string, threshold: number, forDurationSec: number } }[]>
  findById?(id: string): unknown
  delete?(id: string): unknown
}

/** Minimal datasource descriptor passed to the orchestrator. */
export interface DatasourceConfig {
  id: string
  type: string
  name: string
  url: string
  environment?: string
  cluster?: string
  label?: string
  isDefault?: boolean
}
