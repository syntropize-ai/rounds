import type { PanelConfig, DashboardVariable } from '@agentic-obs/common'

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
    sessionId?: string
  }): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard>
  findById(id: string): import('@agentic-obs/common').Dashboard | Promise<import('@agentic-obs/common').Dashboard | undefined> | undefined
  findAll?(): import('@agentic-obs/common').Dashboard[] | Promise<import('@agentic-obs/common').Dashboard[]>
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
  findAll?(): import('@agentic-obs/common').Investigation[] | Promise<import('@agentic-obs/common').Investigation[]>
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
  /** Recent state-change events (firings / resolutions) ordered newest first.
   *  Optional — implementations without persistent history may omit. */
  getHistory?(ruleId: string, limit?: number): unknown[] | Promise<unknown[]>
  getAllHistory?(limit?: number): unknown[] | Promise<unknown[]>
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
