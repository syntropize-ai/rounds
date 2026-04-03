import { randomUUID } from 'node:crypto'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type {
  PanelConfig,
  PanelQuery,
  PanelVisualization,
  DashboardSseEvent,
  InvestigationReport,
  InvestigationReportSection,
} from '@agentic-obs/common'

// -- Types

export interface InvestigationDeps {
  gateway: LLMGateway
  model: string
  prometheusUrl: string
  prometheusHeaders: Record<string, string>
  sendEvent: (event: DashboardSseEvent) => void
}

export interface InvestigationInput {
  goal: string
  existingPanels: PanelConfig[]
  availableMetrics?: string[]
  gridNextRow: number
}

export interface InvestigationOutput {
  /** Short 1-2 sentence summary for the chat reply */
  summary: string
  /** Full structured report for the left-side report view */
  report: InvestigationReport
  /** Evidence panels (already included in report sections too) */
  panels: PanelConfig[]
}

interface InvestigationPlan {
  hypothesis?: string
  queries: Array<{
    id: string
    description: string
    expr: string
    instant: boolean
  }>
}

interface QueryEvidence {
  id: string
  description: string
  expr: string
  instant: boolean
  result: unknown
  error?: string
}

interface AnalysisSection {
  explanation: string
  panel?: {
    title: string
    description: string
    visualization: string
    queries: Array<{ refId: string, expr: string, legendFormat?: string, instant?: boolean }>
    width: number
    height: number
    unit?: string
    thresholds?: Array<{ value: number, color: string, label?: string }>
  }
}

interface AnalysisResult {
  summary: string
  sections: AnalysisSection[]
}

const VALID_VISUALIZATIONS = new Set<string>([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
])

// -- Investigation Sub-Agent

export class InvestigationAgent {
  constructor(private deps: InvestigationDeps) {}

  async investigate(input: InvestigationInput): Promise<InvestigationOutput> {
    const { sendEvent } = this.deps

    // Step 1: Plan investigation queries
    sendEvent({
      type: 'tool_call',
      tool: 'investigate_plan',
      args: { goal: input.goal },
      displayText: `Planning investigation: ${input.goal}`,
    })

    const plan = await this.planInvestigation(input)

    sendEvent({
      type: 'tool_result',
      tool: 'investigate_plan',
      summary: `Hypothesis: ${plan.hypothesis} - ${plan.queries.length} queries planned`,
      success: true,
    })

    // Step 2: Execute queries against Prometheus (parallel)
    sendEvent({
      type: 'tool_call',
      tool: 'investigate_query',
      args: { count: plan.queries.length },
      displayText: `Executing ${plan.queries.length} investigation queries...`,
    })

    const evidence = await this.executeQueries(plan.queries)
    const successCount = evidence.filter((e) => !e.error).length

    sendEvent({
      type: 'tool_result',
      tool: 'investigate_query',
      summary: `${successCount}/${evidence.length} queries returned data`,
      success: successCount > 0,
    })

    // Step 3: Analyze results -> structured report
    sendEvent({
      type: 'tool_call',
      tool: 'investigate_analyze',
      args: { evidenceCount: evidence.length },
      displayText: 'Analyzing evidence and generating report...',
    })

    const analysis = await this.analyzeEvidence(input, plan, evidence)

    sendEvent({
      type: 'tool_result',
      tool: 'investigate_analyze',
      summary: `Report ready - ${analysis.sections.filter((s) => s.panel).length} evidence panels`,
      success: true,
    })

    // Build structured report with panels
    const reportSections: InvestigationReportSection[] = []
    const panels: PanelConfig[] = []
    let currentRow = input.gridNextRow
    let currentCol = 0

    for (const section of analysis.sections) {
      if (section.panel) {
        const panel = this.toPanelConfig(section.panel, currentRow, currentCol)
        panels.push(panel)

        // Auto-layout
        currentCol += panel.width
        if (currentCol >= 12) {
          currentCol = 0
          currentRow += panel.height
        }

        reportSections.push({
          type: 'evidence',
          content: section.explanation,
          panel,
        })
      }
      else {
        reportSections.push({
          type: 'text',
          content: section.explanation,
        })
      }
    }

    const report: InvestigationReport = {
      summary: analysis.summary,
      sections: reportSections,
    }

    return { summary: analysis.summary, report, panels }
  }

  // Step 1: LLM plans investigation
  private async planInvestigation(input: InvestigationInput): Promise<InvestigationPlan> {
    const existingContext = input.existingPanels.length > 0
      ? `\n## Current dashboard panels\n${input.existingPanels.map((p) => `- ${p.title} (${(p.queries ?? []).map((q) => q.expr).join(' | ')})`).join('\n')}\n`
      : ''

    const metricsContext = input.availableMetrics && input.availableMetrics.length > 0
      ? `\n## Available Metrics in Prometheus\n${input.availableMetrics.join('\n')}\n`
      : ''

    const systemPrompt = `You are a senior SRE investigating a production issue. Given the user's question, plan a systematic investigation by deciding what Prometheus queries to run.
${existingContext}${metricsContext}

## Rules
1. Think about what could cause the symptom the user describes
2. Plan 3-8 targeted PromQL queries to gather evidence
3. Each query should test a specific aspect of the hypothesis
4. Use rate() on counters, histogram_quantile() for latency percentiles
5. Include both instant queries (for current state) and range queries (for trends)
6. If the user's question references a specific service/namespace, include that in your queries

## Output (JSON)
{
  "hypothesis": "Brief initial hypothesis about what might be wrong",
  "queries": [
    {
      "id": "q1",
      "description": "What this query checks",
      "expr": "PromQL expression",
      "instant": false
    }
  ]
}`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Investigate: ${input.goal}` },
      ], {
        model: this.deps.model,
        maxTokens: 2048,
        temperature: 0,
        responseFormat: 'json',
      })

      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as InvestigationPlan
      return {
        hypothesis: parsed.hypothesis ?? 'Unknown',
        queries: Array.isArray(parsed.queries) ? parsed.queries : [],
      }
    }
    catch (err) {
      console.error('[InvestigationAgent] planInvestigation failed:', err instanceof Error ? err.message : err)
      return { hypothesis: 'Failed to plan', queries: [] }
    }
  }

  // Step 2: Execute queries against Prometheus
  private async executeQueries(
    queries: InvestigationPlan['queries'],
  ): Promise<QueryEvidence[]> {
    return Promise.all(
      queries.map(async (q): Promise<QueryEvidence> => {
        try {
          const endpoint = q.instant ? 'query' : 'query_range'
          const now = Math.floor(Date.now() / 1000)
          const params = q.instant
            ? `query=${encodeURIComponent(q.expr)}&time=${now}`
            : `query=${encodeURIComponent(q.expr)}&start=${now - 3600}&end=${now}&step=60`
          const url = `${this.deps.prometheusUrl}/api/v1/${endpoint}?${params}`

          const res = await fetch(url, {
            headers: this.deps.prometheusHeaders,
            signal: AbortSignal.timeout(10_000),
          })

          if (!res.ok) {
            return { ...q, result: null, error: `HTTP ${res.status}` }
          }

          const body = await res.json() as { status?: string, data?: unknown, error?: string }
          if (body.status !== 'success') {
            return { ...q, result: null, error: body.error ?? 'Query failed' }
          }

          return { ...q, result: body.data }
        }
        catch (err) {
          return { ...q, result: null, error: err instanceof Error ? err.message : 'Query failed' }
        }
      }),
    )
  }

  // Step 3: LLM analyzes evidence + structured report sections
  private async analyzeEvidence(
    input: InvestigationInput,
    plan: InvestigationPlan,
    evidence: QueryEvidence[],
  ): Promise<AnalysisResult> {
    const evidenceSummary = evidence.map((e) => {
      if (e.error) {
        return `- ${e.description}\nQuery: ${e.expr}\nResult: ERROR - ${e.error}`
      }

      const data = e.result as { result?: unknown[]; resultType?: unknown } | null
      const resultCount = Array.isArray(data?.result) ? data.result.length : 0
      const resultStr = JSON.stringify(data?.result ?? null, null, 2)
      const truncated = resultStr.slice(0, 1500) + (resultStr.length > 1500 ? ' ... [truncated]' : '')
      return `- ${e.description}\nQuery: ${e.expr}\nType: ${data?.resultType ?? 'unknown'}, ${resultCount} series/data\n${truncated}`
    }).join('\n\n')

    const systemPrompt = `You are a senior SRE writing an investigation report. Analyze the Prometheus evidence and produce a structured report.

The report will be displayed as a document with alternating text explanations and evidence panels.
Each section should either be a text explanation or a text explanation paired with a supporting panel.

## Initial hypothesis
${plan.hypothesis}

## Investigation Goal
${input.goal}

## Evidence Gathered
${evidenceSummary}

## Output (JSON)
{
  "summary": "1-2 sentence conclusion for the chat sidebar (e.g. high CPU usage on pod-xyz is causing request timeouts. Recommend scaling up or investigating the memory leak.)",
  "sections": [
    {
      "explanation": "Markdown text explaining the finding. Reference specific values. This text appears above/alongside the panel.",
      "panel": null
    },
    {
      "explanation": "CPU usage has been consistently above 90% for the past 30 minutes on pod-xyz, which directly correlates with the latency spike observed at 14:32 UTC.",
      "panel": {
        "title": "CPU Usage - pod-xyz",
        "description": "Shows the CPU spike correlating with the latency increase",
        "visualization": "time_series",
        "queries": [{ "refId": "A", "expr": "rate(container_cpu_usage_seconds_total{pod=\"pod-xyz\"}[5m])", "legendFormat": "{{container}}", "instant": false }],
        "width": 12,
        "height": 3,
        "unit": "percentunit"
      }
    }
  ]

## Rules
- Start with a summary section (text only) giving the high-level conclusion
- Follow with evidence sections - each important finding gets its own section with explanation + panel
- End with recommendations section (text only)
- Only create panels for evidence that supports findings (use the SAME working PromQL from evidence)
- stat/gauge panels need "instant": true in queries
- Keep 3-6 evidence panels each with a clear explanation of what it shows and why it matters
- Explanations should be specific - cite actual metric values, time ranges, thresholds, etc.
- CRITICAL: Be honest about what the data shows. If metrics look normal, say so clearly. Do NOT fabricate issues or over-interpret normal data. It is perfectly valid to conclude "the metrics investigated appear healthy - the issue may be in application logic, external dependencies, or areas not covered by current metrics." Never force root cause if the evidence doesn't support one.`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Analyze the evidence and write the investigation report.' },
      ], {
        model: this.deps.model,
        maxTokens: 4096,
        temperature: 0,
        responseFormat: 'json',
      })

      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as AnalysisResult

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'Investigation complete.',
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      }
    }
    catch (err) {
      console.error('[InvestigationAgent] analyzeEvidence failed:', err instanceof Error ? err.message : err)
      const basicSummary = `Investigation of "${input.goal}" completed with evidence, but report generation failed.`
      return {
        summary: basicSummary,
        sections: [{ explanation: basicSummary }],
      }
    }
  }

  // Convert single raw panel to PanelConfig
  private toPanelConfig(
    raw: NonNullable<AnalysisSection['panel']>,
    row: number,
    col: number,
  ): PanelConfig {
    const visualization: PanelVisualization = VALID_VISUALIZATIONS.has(raw.visualization)
      ? raw.visualization as PanelVisualization
      : 'time_series'

    const queries: PanelQuery[] = (raw.queries ?? []).map((q) => ({
      refId: q.refId,
      expr: q.expr,
      legendFormat: q.legendFormat,
      instant: q.instant,
    }))

    return {
      id: randomUUID(),
      title: raw.title ?? 'Evidence',
      description: raw.description ?? '',
      queries,
      visualization,
      row,
      col,
      width: Math.min(12, Math.max(1, raw.width ?? 12)),
      height: Math.max(2, raw.height ?? 3),
      refreshIntervalSec: 30,
      unit: raw.unit,
      thresholds: raw.thresholds,
      sectionId: 'investigation',
      sectionLabel: 'Investigation Evidence',
    } as PanelConfig
  }
}
