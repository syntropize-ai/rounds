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
import { GENERATION_PRINCIPLES, buildGroundingContext } from '../system-context.js'
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

/** Enforce reasonable panel width based on visualization type */
function clampWidth(panel: RawPanelSpec): number {
  const w = panel.width ?? 6;
  const viz = panel.visualization;
  if (viz === 'stat' || viz === 'gauge') return Math.min(w, 4);
  if (viz === 'pie' || viz === 'bar' || viz === 'histogram' || viz === 'table') return Math.min(w, 6);
  return w;
}

/** Calculate panel height based on content needs */
function calcHeight(panel: RawPanelSpec): number {
  const viz = panel.visualization;
  const queryCount = panel.queries?.length ?? 1;

  // Compact visualizations
  if (viz === 'stat' || viz === 'gauge') return 3;

  // Table needs more rows for data
  if (viz === 'table') return Math.max(4, Math.min(6, queryCount + 3));

  // Time series / bar / histogram: base 3 + extra for multi-query legend
  // Each query likely produces 1+ series; legend needs ~16px per entry
  // At rowHeight=80, each grid row ≈ 80px
  // Base chart needs 3 rows; add 1 row per 3 legend entries above 2
  const legendRows = queryCount > 2 ? Math.ceil((queryCount - 2) / 3) : 0;
  return Math.max(3, Math.min(6, 3 + legendRows));
}

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
    if (!this.deps.metrics)
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

    const groundingContext = discovery
      ? buildGroundingContext({
          discoveredMetrics: discovery.metrics,
          labelsByMetric: discovery.labelsByMetric,
          sampleValues: discovery.sampleValues,
        })
      : ''

    const feedbackSection = criticFeedback
      ? `\n## Critic Feedback - FIX THESE ISSUES\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} / Fix: ${i.suggestedFix}`).join('\n')}\n`
      : ''

    const panelSpecsText = group.panelSpecs.map((s) => `- ${s.title} (${s.queryIntent}) (${s.visualization}) ${s.width}x${s.height}`).join('\n')

    const systemPrompt = `You are a PromQL expert generating dashboard panels for the "${group.label}" section.
${GENERATION_PRINCIPLES}

## Section Purpose
${group.purpose}

## Panel Specifications
${panelSpecsText}
${researchContext}${groundingContext}${feedbackSection}

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
- stat/gauge panels are for SINGLE values only. Do NOT use stat/gauge for grouped queries that return multiple region/tenant/service/pod series.
- If a query uses by(...), topk(...), or otherwise compares multiple entities, prefer bar, table, pie, or time_series instead of stat.
- Use percentunit ONLY for ratios in the 0..1 range that should be displayed as percentages.
- Metrics named *_score, *_health_score, or similar are usually scores, not 0..1 ratios. Do NOT assume percentunit for them.

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
Return a JSON array of panel specs.
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
      const panels = Array.isArray(parsed) ? parsed as RawPanelSpec[] : []
      // Enforce reasonable widths — LLM often sets everything to 12
      return panels.map((p) => ({ ...p, width: clampWidth(p), height: calcHeight(p) }))
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
Expected scope: ${input.scope ?? 'auto / inferred from the user request'}

Treat the section label and purpose as a hard organizational boundary. If a panel's primary signal belongs to another theme, flag it as section_mismatch instead of approving it just because the query itself is valid.

## Review Criteria
1. Scope Obedience — did this section ONLY produce what was requested? Any unrequested metric families or scope expansion is an error.
2. Technology Relevance
3. PromQL Correctness
4. Visualization Appropriateness - stat/gauge must be single-value panels; grouped multi-series queries should not use stat/gauge.
5. Section Discipline - does every panel belong in this section's theme/purpose, or is it a business panel inside a platform section (or vice versa)?
6. Duplicate Coverage - are multiple panels in this section expressing the same signal at the same level of detail with only minor variations?
7. Panel Count Appropriateness
8. Completeness

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "Error",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | section_mismatch | duplicate_coverage | panel_count | missing_coverage | redundant",
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
      if (!this.deps.metrics)
        return true

      const result = await this.deps.metrics.testQuery(expr)
      return result.ok
    }
    catch {
      return true // Network error shouldn't block
    }
  }
}
