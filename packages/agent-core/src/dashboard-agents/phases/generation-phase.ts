import { parseLlmJson } from '../llm-json.js'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@agentic-obs/common'
import type {
  PanelConfig,
  PanelQuery,
  PanelVisualization,
  DashboardVariable,
} from '@agentic-obs/common'

const log = createLogger('generation-phase')
import type { DiscoveryResult } from '../discovery-agent.js'
import type { ResearchResult } from '../research-agent.js'
import type {
  GeneratorDeps,
  GenerateInput,
  PanelGroup,
  CriticFeedback,
  RawPanelSpec,
} from '../types.js'

const MAX_CRITIC_ROUNDS = 2

const VALID_VISUALIZATIONS = new Set<string>([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
])

export class GenerationPhase {
  constructor(private deps: GeneratorDeps) {}

  async generateAndCriticLoop(
    group: PanelGroup,
    input: GenerateInput,
    research: ResearchResult | undefined,
    discovery: DiscoveryResult | undefined,
    startRow: number,
  ): Promise<PanelConfig[]> {
    let rawPanels: RawPanelSpec[] = []
    let feedback: CriticFeedback | undefined

    for (let round = 0; round <= MAX_CRITIC_ROUNDS; round++) {
      this.deps.sendEvent?.({
        type: 'tool_call',
        tool: 'generate_group',
        args: { group: group.label, round },
        displayText: `Generating "${group.label}"${round > 0 ? ` (revision ${round})` : ''}`,
      })

      rawPanels = await this.generateGroup(group, input, research, discovery, startRow, feedback)

      this.deps.sendEvent?.({
        type: 'tool_result',
        tool: 'generate_group',
        summary: `Generated ${rawPanels.length} panel(s) for "${group.label}"`,
        success: rawPanels.length > 0,
      })

      this.deps.sendEvent?.({
        type: 'tool_call',
        tool: 'critic',
        args: { group: group.label, panelCount: rawPanels.length },
        displayText: `Reviewing "${group.label}" (${rawPanels.length} panels)`,
      })

      feedback = await this.critique(rawPanels, group, input)

      this.deps.sendEvent?.({
        type: 'tool_result',
        tool: 'critic',
        summary: `Score: ${feedback.overallScore}/10, ${feedback.issues.length} issue(s)`,
        success: feedback.approved,
      })

      if (feedback.approved)
        break

      this.deps.sendEvent?.({
        type: 'thinking',
        content: `Critic found ${feedback.issues.length} issues in "${group.label}" - revising...`,
      })
    }

    return this.toPanelConfigs(rawPanels, startRow)
  }

  // Validate queries against Prometheus (if available)
  async validateQueries(panels: PanelConfig[]): Promise<PanelConfig[]> {
    if (!this.deps.prometheusUrl)
      return panels

    const validated: PanelConfig[] = []
    for (const panel of panels) {
      let allValid = true
      for (const query of panel.queries ?? []) {
        const ok = await this.queryPrometheus(query.expr)
        if (!ok) {
          allValid = false
          break
        }
      }

      if (allValid) {
        validated.push(panel)
      }
      else {
        this.deps.sendEvent?.({
          type: 'tool_result',
          tool: 'validate_query',
          summary: `Dropped "${panel.title}" - query validation failed`,
          success: false,
        })
      }
    }

    return validated
  }

  // Variable Detection
  detectVariables(
    panels: PanelConfig[],
    input: GenerateInput,
    discovery?: DiscoveryResult,
  ): DashboardVariable[] {
    const existingNames = new Set(input.existingVariables.map((v) => v.name))
    const variables: DashboardVariable[] = []

    const referencedVars = new Set<string>()
    for (const panel of panels) {
      for (const query of panel.queries ?? []) {
        const matches = query.expr.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? []
        for (const m of matches)
          referencedVars.add(m.slice(1))
      }
    }

    for (const varName of referencedVars) {
      if (existingNames.has(varName))
        continue

      let sourceMetric: string | undefined
      if (discovery) {
        for (const [metric, labels] of Object.entries(discovery.labelsByMetric)) {
          if (labels.includes(varName)) {
            sourceMetric = metric
            break
          }
        }
      }

      variables.push({
        name: varName,
        label: varName.charAt(0).toUpperCase() + varName.slice(1),
        type: 'query',
        query: sourceMetric ? `label_values(${sourceMetric}, ${varName})` : `label_values(${varName})`,
        current: '',
        multi: true,
        includeAll: true,
      } as DashboardVariable)

      existingNames.add(varName)
    }

    return variables
  }

  // Generator
  private async generateGroup(
    group: PanelGroup,
    input: GenerateInput,
    research: ResearchResult | undefined,
    discovery: DiscoveryResult | undefined,
    startRow: number,
    criticFeedback?: CriticFeedback,
  ): Promise<RawPanelSpec[]> {
    const researchContext = research && research.keyMetrics.length > 0
      ? `\n## Research Context\nKey metrics from web search: ${research.keyMetrics.join(', ')}\nThese are reference alongside your own knowledge.\n`
      : ''

    const metricsSection = discovery && discovery.metrics.length > 0
      ? `\n## Available Metrics (from Prometheus - supplementary)\n${discovery.metrics.slice(0, 15).join('\n')}\nThese metrics exist in the cluster. Prefer them when relevant, but also include important standard metrics that may not be in this list. List metrics use your knowledge of standard metric naming for this technology.\n`
      : ''

    const labelsSection = discovery && Object.keys(discovery.labelsByMetric).length > 0
      ? `\n## Labels\n${Object.entries(discovery.labelsByMetric).slice(0, 15).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}\n`
      : ''

    const feedbackSection = criticFeedback
      ? `\n## Critic Feedback - FIX THESE ISSUES\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} / Fix: ${i.suggestedFix}`).join('\n')}\n`
      : ''

    const panelSpecsText = group.panelSpecs.map((s) => `- ${s.title} (${s.queryIntent}) (${s.visualization}) ${s.width}x${s.height}`).join('\n')

    const systemPrompt = `You are a PromQL expert generating dashboard panels for the "${group.label}" section.

## Section Purpose
${group.purpose}

## Panel Specifications
${panelSpecsText}
${researchContext}${metricsSection}${labelsSection}${feedbackSection}

## IMPORTANT
Each panel spec above specifies its visualization type in parentheses. You MUST use exactly that visualization type.
Do not change pie to time_series, do not change histogram to bar, etc.

## PromQL Rules
- rate() on counters (*_total, *_count) with [5m]
- histogram_quantile for percentiles from *_bucket, NEVER avg()
- Error ratios: divide error rate by total rate
- sum by() / avg by() for aggregation
- For stat/gauge/pie/histogram/bar panels add "instant": true to the query
- Multi-series comparison: separate queries with refId A/B/C

## Layout
Grid starts at row ${startRow}, 12-column grid.
- stat: width=3, height=2
- time_series full: width=12, height=3
- time_series paired: width=6, height=3
- bar/table/histogram: width=6, height=3
- gauge/pie: width=4, height=3
- heatmap: width=12, height=3
- status_timeline: width=12, height=2

## Visualization selection
- pie: use for proportional breakdowns (e.g. traffic share by service). Query should return multiple instant values.
- histogram: use for latency/size distributions from bucket metrics. Query the raw bucket metric with instant=true.
- heatmap: use for latency heatmaps over time. Query a bucket metric as range over time without transform.
- status_timeline: use for up/down or health status over time. Query should return 0/1 values per target as range queries.

## Output
Return a JSON array of panel specs. Use diverse visualization types - NOT just time_series.
[
  { "title": "Request Rate", "visualization": "stat", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 0, "col": 0, "width": 3, "height": 2 },
  { "title": "Latency Trend", "visualization": "time_series", "queries": [{ "refId": "A", "expr": "", "legendFormat": "{{pod}}" }], "row": 2, "col": 0, "width": 6, "height": 3 },
  { "title": "Traffic by Service", "visualization": "pie", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 2, "col": 6, "width": 4, "height": 3 },
  { "title": "Latency Distribution", "visualization": "histogram", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 5, "col": 0, "width": 6, "height": 3 },
  { "title": "Service Health", "visualization": "status_timeline", "queries": [{ "refId": "A", "expr": "" }], "row": 8, "col": 0, "width": 12, "height": 2 }
]

Full panel spec keys: title, description, visualization, queries: [{refId, expr, legendFormat, instant}], row, col, width, height, unit, stackMode, fillOpacity, thresholds, decimals.
Valid units: bytes, bytes/s, seconds, ms, percentunit, percent, reqps, short, none
ONLY return the JSON array without markdown.`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Section: ${group.label}\nGoal: ${input.goal}` },
      ], {
        model: this.deps.model,
        maxTokens: 8192,
        temperature: 0.2,
        responseFormat: 'json',
      })
      // Fix invalid JSON escape sequences from LLM (e.g. \s, \d in PromQL regex)
      const parsed = parseLlmJson(resp.content) as unknown
      return Array.isArray(parsed) ? parsed as RawPanelSpec[] : []
    }
    catch (err) {
      log.warn({ err }, 'generateGroup failed')
      return []
    }
  }

  // Critic (pure LLM reasoning)
  private async critique(
    panels: RawPanelSpec[],
    group: PanelGroup,
    input: GenerateInput,
  ): Promise<CriticFeedback> {
    const systemPrompt = `You are a senior SRE reviewing dashboard panels for quality and correctness.

## Review Context
Dashboard goal: ${input.goal}
Section: ${group.label} -> ${group.purpose}
Expected scope: ${input.scope}

## Review Criteria
1. Technology Relevance
2. PromQL Correctness
3. Visualization Appropriateness
4. Panel Count Appropriateness
5. Completeness
6. Redundancy

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "Error",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | panel_count | missing_coverage | redundant",
      "description": "what is wrong",
      "suggestedFix": "How to fix it"
    }
  ]
}

approved = true if overallScore >= 8 AND no severity=error issues.`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Panels to review:\n${JSON.stringify(panels, null, 2)}` },
      ], {
        model: this.deps.model,
        maxTokens: 2048,
        temperature: 0,
        responseFormat: 'json',
      })

      const parsed = parseLlmJson(resp.content) as CriticFeedback
      return {
        approved: !!parsed.approved,
        overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 5,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      }
    }
    catch {
      // If critic fails, approve by default (don't block generation)
      return { approved: true, overallScore: 7, issues: [] }
    }
  }

  // Convert raw specs to PanelConfig
  private toPanelConfigs(rawPanels: RawPanelSpec[], startRow: number): PanelConfig[] {
    return rawPanels.map((raw) => {
      const visualization = VALID_VISUALIZATIONS.has(raw.visualization)
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
        title: raw.title ?? 'Panel',
        description: raw.description ?? '',
        queries,
        visualization,
        row: Math.max(0, raw.row ?? startRow),
        col: Math.min(11, Math.max(0, raw.col ?? 0)),
        width: Math.max(2, Math.min(12, raw.width ?? 6)),
        height: Math.max(2, raw.height ?? 3),
        refreshIntervalSec: 30,
        unit: raw.unit,
        stackMode: raw.stackMode,
        fillOpacity: raw.fillOpacity,
        decimals: raw.decimals,
        thresholds: raw.thresholds,
      } as PanelConfig
    })
  }

  private async queryPrometheus(expr: string): Promise<boolean> {
    try {
      if (!this.deps.prometheusUrl)
        return true

      const url = `${this.deps.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}&time=${Math.floor(Date.now() / 1000)}`
      const res = await fetch(url, { headers: this.deps.prometheusHeaders })
      if (!res.ok)
        return false
      const body = await res.json() as { status?: string }
      return body.status === 'success'
    }
    catch {
      return true // Network error shouldn't block
    }
  }
}
