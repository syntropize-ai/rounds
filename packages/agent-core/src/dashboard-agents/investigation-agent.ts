import { parseLlmJson } from './llm-json.js'
import { randomUUID } from 'node:crypto'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common'
import { agentRegistry } from '../runtime/agent-registry.js'
import { VerifierAgent } from '../verification/verifier-agent.js'
import type { IMetricsAdapter } from '../adapters/index.js'
import type {
  PanelConfig,
  PanelQuery,
  PanelVisualization,
  PanelSnapshotData,
  DashboardSseEvent,
  InvestigationReport,
  InvestigationReportSection,
} from '@agentic-obs/common'

const log = createLogger('investigation-agent')

// -- Types

export interface InvestigationDeps {
  gateway: LLMGateway
  model: string
  metrics: IMetricsAdapter
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
  /** Verification report from the verifier agent */
  verificationReport?: import('../verification/types.js').VerificationReport
}

interface InvestigationPlan {
  hypothesis?: string
  /** Explains the investigation strategy: why these queries were chosen,
   *  how they relate to each other, and the logical flow of the investigation. */
  reasoning?: string
  queries: Array<{
    id: string
    description: string
    expr: string
    instant: boolean
    /** Why this query matters for the investigation and what its result
     *  would mean in relation to other queries. */
    rationale?: string
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
  static readonly definition = agentRegistry.get('investigation-runner')!;

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

    // Build a lookup from PromQL expr → raw evidence so we can attach
    // snapshot data to each panel (panels should show point-in-time data,
    // not live queries).
    const evidenceByExpr = new Map<string, QueryEvidence>()
    for (const e of evidence) {
      evidenceByExpr.set(e.expr, e)
    }
    const capturedAt = new Date().toISOString()

    // Build structured report with panels
    const reportSections: InvestigationReportSection[] = []
    const panels: PanelConfig[] = []
    let currentRow = input.gridNextRow
    let currentCol = 0

    for (const section of analysis.sections) {
      if (section.panel) {
        const panel = this.toPanelConfig(section.panel, currentRow, currentCol)

        // Attach snapshot data from the evidence we already collected
        panel.snapshotData = this.buildSnapshotData(panel, evidenceByExpr, capturedAt)

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

    // Step 4: Verify the report
    const verifier = new VerifierAgent()
    const verificationReport = await verifier.verify(
      'investigation_report',
      report,
      {
        metricsAdapter: this.deps.metrics,
      },
    )

    log.info(
      { status: verificationReport.status, issues: verificationReport.issues.length },
      'investigation verification complete',
    )

    sendEvent({
      type: 'verification_report',
      report: verificationReport,
    })

    return { summary: analysis.summary, report, panels, verificationReport }
  }

  // Step 0: Discover what metrics actually exist in Prometheus
  private async discoverMetrics(): Promise<string[]> {
    try {
      return await this.deps.metrics.listMetricNames()
    } catch {
      return []
    }
  }

  // Step 1: LLM plans investigation (with real metric discovery)
  private async planInvestigation(input: InvestigationInput): Promise<InvestigationPlan> {
    // Auto-discover available metrics from Prometheus
    const discoveredMetrics = await this.discoverMetrics()
    log.info({ count: discoveredMetrics.length }, 'discovered metrics from Prometheus')

    const existingContext = input.existingPanels.length > 0
      ? `\n## Current dashboard panels\n${input.existingPanels.map((p) => `- ${p.title} (${(p.queries ?? []).map((q) => q.expr).join(' | ')})`).join('\n')}\n`
      : ''

    // Use discovered metrics if available, otherwise fall back to provided list
    const allMetrics = discoveredMetrics.length > 0 ? discoveredMetrics : (input.availableMetrics ?? [])
    const metricsContext = allMetrics.length > 0
      ? `\n## Available Metrics in This Prometheus Instance\nThese are the ACTUAL metrics available. ONLY use metrics from this list in your queries:\n${allMetrics.join('\n')}\n`
      : ''

    const systemPrompt = `You are a senior SRE investigating a production issue. Given the user's question, plan a systematic investigation by deciding what PromQL queries to run.
${existingContext}${metricsContext}
## Rules
1. **ONLY use metrics that exist in the Available Metrics list above** - do NOT guess or invent metric names
2. Based on the user's question, select the most relevant metrics from the list and plan 3-8 targeted PromQL queries to gather evidence
3. Each query should test a specific aspect of the hypothesis
4. Include both instant queries (for current state) and range queries (for trends)
5. Think about query ORDER — the investigation should follow a logical thread. Each query should build on what the previous one might reveal.

## Output (JSON only, no markdown)
{
  "hypothesis": "Brief initial hypothesis about what might be wrong",
  "reasoning": "Explain your investigation strategy in 3-5 sentences: what you suspect, why you chose these queries in this order, and how the results of earlier queries inform what you'd look for in later ones. This reasoning will be used later to write a coherent narrative report.",
  "queries": [
    {
      "id": "q1",
      "description": "What this query checks",
      "expr": "PromQL expression using ONLY available metrics",
      "instant": false,
      "rationale": "Why this query matters and what its result means for the next step"
    }
  ]
}`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Investigate: ${input.goal}` },
      ], {
        model: this.deps.model,
        maxTokens: 4096,
        temperature: 0,
        responseFormat: 'json',
      })

      const parsed = parseLlmJson(resp.content) as InvestigationPlan
      const queries = Array.isArray(parsed.queries) ? parsed.queries : []
      log.info({ hypothesis: parsed.hypothesis, queryCount: queries.length }, 'investigation plan ready')
      return {
        hypothesis: parsed.hypothesis ?? 'Unknown',
        reasoning: parsed.reasoning,
        queries,
      }
    }
    catch (err) {
      log.error({ err }, 'planInvestigation failed')
      return { hypothesis: 'Failed to plan', queries: [] }
    }
  }

  // Step 2: Execute queries against Prometheus via adapter
  private async executeQueries(
    queries: InvestigationPlan['queries'],
  ): Promise<QueryEvidence[]> {
    return Promise.all(
      queries.map(async (q): Promise<QueryEvidence> => {
        try {
          if (q.instant) {
            const samples = await this.deps.metrics.instantQuery(q.expr)
            return {
              ...q,
              result: {
                resultType: 'vector',
                result: samples.map((s) => ({ metric: s.labels, value: [s.timestamp, String(s.value)] })),
              },
            }
          } else {
            const now = new Date()
            const start = new Date(now.getTime() - 3600_000)
            const ranges = await this.deps.metrics.rangeQuery(q.expr, start, now, '60')
            return {
              ...q,
              result: {
                resultType: 'matrix',
                result: ranges.map((r) => ({ metric: r.metric, values: r.values })),
              },
            }
          }
        }
        catch (err) {
          return { ...q, result: null, error: err instanceof Error ? err.message : 'Query failed' }
        }
      }),
    )
  }

  /** Summarise a single evidence item with key statistics instead of raw JSON */
  private summarizeEvidence(e: QueryEvidence): string {
    if (e.error) {
      return `### ${e.id}: ${e.description}\nQuery: \`${e.expr}\`\nResult: ERROR — ${e.error}`
    }

    const data = e.result as { result?: Array<Record<string, unknown>>; resultType?: string } | null
    const results = Array.isArray(data?.result) ? data.result : []
    const resultType = data?.resultType ?? 'unknown'

    if (resultType === 'matrix') {
      // Time-series: extract key statistics per series
      const seriesSummaries = results.slice(0, 10).map((r: Record<string, unknown>) => {
        const metric = r.metric as Record<string, string> | undefined
        const values = r.values as Array<[number, string]> | undefined
        const label = metric
          ? Object.entries(metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ') || metric['__name__'] || 'series'
          : 'series'

        if (!values || values.length === 0) return `  - {${label}}: no data points`

        const nums = values.map(([, v]) => Number.parseFloat(v))
        const min = Math.min(...nums)
        const max = Math.max(...nums)
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length
        const latest = nums[nums.length - 1]!
        const first = nums[0]!
        const trend = latest > first * 1.1 ? '↑ rising' : latest < first * 0.9 ? '↓ falling' : '→ stable'

        return `  - {${label}}: min=${min.toPrecision(4)}, max=${max.toPrecision(4)}, avg=${avg.toPrecision(4)}, latest=${latest.toPrecision(4)}, trend=${trend} (${values.length} points)`
      })

      const extra = results.length > 10 ? `\n  ... and ${results.length - 10} more series` : ''
      return `### ${e.id}: ${e.description}\nQuery: \`${e.expr}\`\nType: range, ${results.length} series\n${seriesSummaries.join('\n')}${extra}`
    }

    if (resultType === 'vector') {
      // Instant: show all values compactly
      const valueSummaries = results.slice(0, 15).map((r: Record<string, unknown>) => {
        const metric = r.metric as Record<string, string> | undefined
        const value = r.value as [number, string] | undefined
        const label = metric
          ? Object.entries(metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}=${v}`).join(', ') || metric['__name__'] || 'series'
          : 'series'
        return `  - {${label}}: ${value ? value[1] : 'N/A'}`
      })
      const extra = results.length > 15 ? `\n  ... and ${results.length - 15} more` : ''
      return `### ${e.id}: ${e.description}\nQuery: \`${e.expr}\`\nType: instant, ${results.length} results\n${valueSummaries.join('\n')}${extra}`
    }

    // Fallback
    const resultStr = JSON.stringify(data?.result ?? null, null, 2)
    const truncated = resultStr.slice(0, 1500) + (resultStr.length > 1500 ? ' ... [truncated]' : '')
    return `### ${e.id}: ${e.description}\nQuery: \`${e.expr}\`\nType: ${resultType}, ${results.length} results\n${truncated}`
  }

  // Step 3: LLM analyzes evidence + structured report sections
  private async analyzeEvidence(
    input: InvestigationInput,
    plan: InvestigationPlan,
    evidence: QueryEvidence[],
  ): Promise<AnalysisResult> {
    const evidenceSummary = evidence.map((e) => this.summarizeEvidence(e)).join('\n\n')

    // Build the query-level rationale context so the LLM knows the logical
    // thread that ties the queries together.
    const queryRationales = plan.queries
      .map((q) => `- **${q.id}** (${q.description}): ${q.rationale ?? 'N/A'}`)
      .join('\n')

    const systemPrompt = `You are a senior SRE writing an investigation report for your team. Write it like a real post-incident analysis — with your reasoning process, what you checked and why, what the data told you, and what conclusions you drew.

The report is a narrative document with embedded metric panels. It should read like a story: "We started by looking at X because... The data showed Y, which told us... This led us to check Z..."

## Investigation Goal
${input.goal}

## Initial Hypothesis
${plan.hypothesis}

## Investigation Strategy
${plan.reasoning ?? 'No explicit strategy recorded.'}

## Query Rationales (the logical thread connecting each query)
${queryRationales}

## Evidence Gathered
${evidenceSummary}

## Output (JSON)
{
  "summary": "1-2 sentence conclusion for the chat sidebar",
  "sections": [
    {
      "explanation": "Markdown narrative text. Write like a person thinking through the problem.",
      "panel": null
    },
    {
      "explanation": "Narrative text explaining WHY you looked at this metric, WHAT the data shows, and WHAT it means for the investigation.",
      "panel": {
        "title": "Panel Title",
        "description": "Brief panel description",
        "visualization": "time_series",
        "queries": [{ "refId": "A", "expr": "promql_here", "legendFormat": "{{label}}", "instant": false }],
        "width": 12,
        "height": 3,
        "unit": "short"
      }
    }
  ]
}

## Writing Style
- Write in first person plural ("We checked...", "Our investigation found...")
- **Follow the Investigation Strategy and Query Rationales above** — they explain WHY each query was chosen and how they connect. Use this logical thread as the backbone of your narrative. Do NOT treat each query as an isolated finding.
- Structure as a logical narrative: context → hypothesis → evidence → interpretation → conclusion
- Start with a text section setting the scene: what the problem is, what your initial thinking was, and how you approached the investigation
- For each evidence panel, use the query's rationale to explain your REASONING: why you checked this metric, what you expected to see, and what the actual data revealed. Transition naturally from one finding to the next — "This ruled out X, so we turned our attention to Y..." or "Having confirmed X, we needed to determine whether Y was also a factor..."
- Don't just describe data mechanically ("The value is 0.043"). Instead, interpret it ("The error rate of 4.3% is significantly above the normal baseline of <0.1%, confirming our hypothesis that...")
- End with TWO text sections (no panels):
  1. **Conclusion**: what you found, what the root cause is (or isn't)
  2. **Recommendations**: If a root cause was found, give specific remediation steps (e.g. "Scale the payment-gateway deployment to 3 replicas", "Add a circuit breaker on the checkout→payment call"). If no root cause was found, give concrete next-step investigation suggestions — what logs to check, what services to trace, what dashboards to look at, what teams to contact (e.g. "Check application logs for checkout-service for unhandled exceptions", "Trace a failing checkout request end-to-end through Jaeger", "Review recent deployments to checkout and payment services")
- Be honest — if evidence is inconclusive or shows normal behavior, explain why that's actually an important finding ("The fact that CPU/memory are normal tells us this is NOT a resource issue, narrowing our search to...")

## Panel Rules
- Only create panels for the most important 3-6 findings
- Use the SAME working PromQL from evidence (don't invent new queries)
- stat/gauge panels need "instant": true in queries
- CRITICAL: Be honest. If metrics look normal, say so. Don't fabricate issues.`

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

      const parsed = parseLlmJson(resp.content) as AnalysisResult

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'Investigation complete.',
        sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      }
    }
    catch (err) {
      log.error({ err }, 'analyzeEvidence failed')
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

  /** Build snapshot data for a panel by matching its queries against the
   *  evidence we already collected in Phase 2. */
  private buildSnapshotData(
    panel: PanelConfig,
    evidenceByExpr: Map<string, QueryEvidence>,
    capturedAt: string,
  ): PanelSnapshotData {
    const isRangeViz = panel.visualization === 'time_series'
      || panel.visualization === 'heatmap'
      || panel.visualization === 'status_timeline'

    const snapshot: PanelSnapshotData = { capturedAt }

    for (const pq of panel.queries ?? []) {
      const ev = evidenceByExpr.get(pq.expr)
      if (!ev || ev.error || !ev.result) continue

      const raw = ev.result as { resultType?: string; result?: unknown[] }

      if (isRangeViz && raw.resultType === 'matrix') {
        if (!snapshot.range) snapshot.range = []
        const matrixResults = (raw.result ?? []) as Array<{
          metric: Record<string, string>
          values: Array<[number, string]>
        }>
        snapshot.range.push({
          refId: pq.refId,
          legendFormat: pq.legendFormat,
          series: matrixResults.map((r) => ({
            labels: r.metric,
            points: (r.values ?? []).map(([ts, val]) => ({
              ts: ts * 1000,
              value: Number.parseFloat(val),
            })),
          })),
          totalSeries: matrixResults.length,
        })
      } else if (!isRangeViz && raw.resultType === 'vector') {
        const vectorResults = (raw.result ?? []) as Array<{
          metric: Record<string, string>
          value: [number, string]
        }>
        snapshot.instant = {
          data: { result: vectorResults },
        }
      }
    }

    return snapshot
  }
}
