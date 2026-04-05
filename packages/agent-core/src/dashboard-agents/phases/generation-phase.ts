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

export class GenerationPhase {
  constructor(private deps: GeneratorDeps) {}

  async generateAndCriticLoop(
    group: PanelGroup,
    allGroups: PanelGroup[],
    plannedVariables: Array<{ name: string }>,
    input: GenerateInput,
    research: ResearchResult | undefined,
    discovery: DiscoveryResult | undefined,
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

      rawPanels = await this.generateGroup(group, allGroups, plannedVariables, input, research, discovery, feedback)

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

      feedback = await this.critique(rawPanels, group, allGroups, plannedVariables, input)

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

    return this.toPanelConfigs(rawPanels)
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
    allGroups: PanelGroup[],
    plannedVariables: Array<{ name: string }>,
    input: GenerateInput,
    research: ResearchResult | undefined,
    discovery: DiscoveryResult | undefined,
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
          metadataByMetric: discovery.metadataByMetric,
        })
      : ''

    const feedbackSection = criticFeedback
      ? `\n## Critic Feedback - FIX THESE ISSUES\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} / Fix: ${i.suggestedFix}`).join('\n')}\n`
      : ''

    const panelSpecsText = group.panelSpecs.map((s) => `- ${s.title} (${s.queryIntent}) (${s.visualization})`).join('\n')
    const sectionMap = allGroups
      .map((g) => {
        const specs = g.panelSpecs.map((s) => `${s.title}: ${s.queryIntent}`).join('; ')
        return `- ${g.label} -> ${g.purpose}${specs ? ` | assigned coverage: ${specs}` : ''}${g.id === group.id ? ' [CURRENT SECTION]' : ''}`
      })
      .join('\n')
    const allPlannedVariables = [...input.existingVariables.map((v) => v.name), ...plannedVariables.map((v) => v.name)]
    const plannedVariablesText = allPlannedVariables.length
      ? [...new Set(allPlannedVariables)].map((name) => `- $${name}`).join('\n')
      : '- none'

    const systemPrompt = `You are a PromQL expert generating dashboard panels for the "${group.label}" section.
${GENERATION_PRINCIPLES}

## Section Purpose
${group.purpose}

## Full Dashboard Section Map
${sectionMap}

## Planned Dashboard Variables
${plannedVariablesText}

## Panel Specifications
${panelSpecsText}
${researchContext}${groundingContext}${feedbackSection}

## IMPORTANT
Each panel spec above specifies its visualization type in parentheses. You MUST use exactly that visualization type.
Do not change pie to time_series, do not change histogram to bar, etc.
Treat the section map as a hard ownership map. This section should cover its assigned signals and should NOT recreate signals already assigned to other sections unless the perspective is clearly different.
Treat the planned variable list as a hard contract. If no variables are planned, do NOT introduce template variables such as $instance, $job, $namespace, or similar placeholders in queries.
For first-look health dashboards, do not add second-order exporter detail or drill-down panels unless that deeper signal is explicitly assigned in the section map.

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

## Visualization selection
- pie: use for proportional breakdowns (e.g. traffic share by service). Query should return multiple instant values.
- histogram: use for latency/size distributions from bucket metrics. Query the raw bucket metric with instant=true.
- heatmap: use for latency heatmaps over time. Query a bucket metric as range over time without transform.
- status_timeline: use for up/down or health status over time. Query should return 0/1 values per target as range queries.

## Output
Return a JSON array of panel specs. Panel order in the array determines layout position — no row/col/width/height needed.
[
  { "title": "Request Rate", "visualization": "stat", "queries": [{ "refId": "A", "expr": "", "instant": true }] },
  { "title": "Latency Trend", "visualization": "time_series", "queries": [{ "refId": "A", "expr": "", "legendFormat": "{{pod}}" }] },
  { "title": "Traffic by Service", "visualization": "pie", "queries": [{ "refId": "A", "expr": "", "instant": true }] },
  { "title": "Latency Distribution", "visualization": "histogram", "queries": [{ "refId": "A", "expr": "", "instant": true }] },
  { "title": "Service Health", "visualization": "status_timeline", "queries": [{ "refId": "A", "expr": "" }] }
]

Full panel spec keys: title, description, visualization, queries: [{refId, expr, legendFormat, instant}], unit, stackMode, fillOpacity, thresholds, decimals.
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
    allGroups: PanelGroup[],
    plannedVariables: Array<{ name: string }>,
    input: GenerateInput,
  ): Promise<CriticFeedback> {
    const sectionMap = allGroups
      .map((g) => {
        const specs = g.panelSpecs.map((s) => `${s.title}: ${s.queryIntent}`).join('; ')
        return `- ${g.label} -> ${g.purpose}${specs ? ` | assigned coverage: ${specs}` : ''}${g.id === group.id ? ' [CURRENT SECTION]' : ''}`
      })
      .join('\n')

    const systemPrompt = `You are a senior SRE reviewing dashboard panels for quality and correctness.

## Review Context
Dashboard goal: ${input.goal}
Section: ${group.label} -> ${group.purpose}
Expected scope: ${input.scope ?? 'auto / inferred from the user request'}
Full section map:
${sectionMap}

Planned variables:
${[...new Set([...input.existingVariables.map((v) => v.name), ...plannedVariables.map((v) => v.name)])].map((name) => `- $${name}`).join('\n') || '- none'}

Treat the section label and purpose as a hard organizational boundary. If a panel's primary signal belongs to another theme, flag it as section_mismatch instead of approving it just because the query itself is valid.
Treat the planned variable list as a hard contract. If queries introduce template variables that are not in the planned variable list, flag that as promql_error.

## Review Criteria
1. Scope Obedience — did this section ONLY produce what was requested? Any unrequested metric families or scope expansion is an error.
2. Technology Relevance
3. PromQL Correctness
4. Visualization Appropriateness - stat/gauge must be single-value panels; grouped multi-series queries should not use stat/gauge.
5. Section Discipline - does every panel belong in this section's theme/purpose, or is it a business panel inside a platform section (or vice versa)?
6. Duplicate Coverage - are multiple panels in this section expressing the same signal at the same level of detail with only minor variations?
7. First-Look Discipline - for broad health dashboards, prioritize the core panels an operator would want first. Flag exporter-detail, specialist diagnostics, or drill-down panels that appear too early unless the user's intent is clearly deeper analysis.
8. Panel Count Appropriateness
9. Completeness

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "Error",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | section_mismatch | duplicate_coverage | front_page_drift | panel_count | missing_coverage | redundant",
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

  // Convert raw specs to PanelConfig (layout is applied later by the layout engine)
  private toPanelConfigs(rawPanels: RawPanelSpec[]): PanelConfig[] {
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
        row: 0,
        col: 0,
        width: 6,
        height: 3,
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
