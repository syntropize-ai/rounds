import { parseLlmJson } from './llm-json.js'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@agentic-obs/common'
import type {
  PanelConfig,
  PanelQuery,
  PanelVisualization,
  DashboardVariable,
} from '@agentic-obs/common'

const log = createLogger('panel-adder')
import type {
  GeneratorDeps,
  RawPanelSpec,
  CriticFeedback,
} from './types.js'
import { GENERATION_PRINCIPLES } from './system-context.js'

// -- PanelAdder I/O

export interface DatasourceContext {
  name: string
  type: string // e.g. 'prometheus', 'victoria-metrics', 'loki'
  metrics: string[]
  labelsByMetric: Record<string, string[]>
}

export interface PanelAdderInput {
  goal: string
  existingPanels: PanelConfig[]
  existingVariables: DashboardVariable[]
  /** @deprecated use datasources instead */
  availableMetrics: string[]
  /** @deprecated use datasources instead */
  labelsByMetric: Record<string, string[]>
  /** All connected datasources with their discovered metrics */
  datasources?: DatasourceContext[]
  gridNextRow: number
}

export interface PanelAdderOutput {
  panels: PanelConfig[]
  variables?: DashboardVariable[]
}

// -- Constants

const MAX_CRITIC_RETRIES = 1

const VALID_VISUALIZATIONS = new Set<string>([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
])

// -- PanelAdderAgent

export class PanelAdderAgent {
  constructor(private deps: GeneratorDeps) {}

  async addPanels(input: PanelAdderInput): Promise<PanelAdderOutput> {
    const { sendEvent } = this.deps
    let rawPanels: RawPanelSpec[] = []
    let feedback: CriticFeedback | undefined

    for (let round = 0; round <= MAX_CRITIC_RETRIES; round++) {
      // -- Generate
      sendEvent({
        type: 'tool_call',
        tool: 'panel_adder_generate',
        args: { goal: input.goal, round },
        displayText: `Generating panels for "${input.goal}"${round > 0 ? ' (revision)' : ''}`,
      })

      rawPanels = await this.generate(input, feedback)

      sendEvent({
        type: 'tool_result',
        tool: 'panel_adder_generate',
        summary: `Generated ${rawPanels.length} panel(s)`,
        success: rawPanels.length > 0,
      })

      // -- Quick Critic
      sendEvent({
        type: 'tool_call',
        tool: 'panel_adder_critic',
        args: { panelCount: rawPanels.length },
        displayText: `Reviewing ${rawPanels.length} panel(s)...`,
      })

      feedback = await this.critique(rawPanels, input)

      sendEvent({
        type: 'tool_result',
        tool: 'panel_adder_critic',
        summary: `Score: ${feedback.overallScore}/10, ${feedback.issues.length} issue(s)`,
        success: feedback.approved,
      })

      if (feedback.approved)
        break

      sendEvent({
        type: 'thinking',
        content: `Critic found ${feedback.issues.length} issue(s) - revising...`,
      })
    }

    const panels = this.toPanelConfigs(rawPanels, input.gridNextRow)
    const variables = this.detectNewVariables(panels, input)
    return { panels, variables: variables.length > 0 ? variables : undefined }
  }

  // -- Generate
  private async generate(
    input: PanelAdderInput,
    criticFeedback?: CriticFeedback,
  ): Promise<RawPanelSpec[]> {
    const existingContext = input.existingPanels.length
      ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
      : ''

    // Build datasource context — support multiple datasources
    let datasourceSection = ''
    const dsContexts = input.datasources ?? []
    if (dsContexts.length > 0) {
      const parts = dsContexts.map((ds) => {
        let section = `### Datasource: ${ds.name} (${ds.type})\n`
        if (ds.metrics.length > 0) {
          section += `Available metrics (ONLY use these — do NOT invent names):\n${ds.metrics.slice(0, 80).join('\n')}\n`
        }
        if (Object.keys(ds.labelsByMetric).length > 0) {
          section += `Label dimensions & sample values (use these EXACT values):\n`
          section += Object.entries(ds.labelsByMetric).slice(0, 20)
            .map(([k, v]) => `- ${k}: ${v.join(', ')}`)
            .join('\n')
          section += '\n'
        }
        return section
      })
      datasourceSection = `\n## Connected Datasources\n${parts.join('\n')}\nDo NOT guess metric names or label values. Use ONLY what is listed above.\n`
    } else {
      // Fallback to legacy fields
      const metricsSection = input.availableMetrics.length
        ? `\n## Available Metrics\nONLY use metrics from this list:\n${input.availableMetrics.slice(0, 80).join('\n')}\n`
        : ''
      const labelsSection = Object.keys(input.labelsByMetric).length
        ? `\n## Label Dimensions\n${Object.entries(input.labelsByMetric).slice(0, 20).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}\n`
        : ''
      datasourceSection = metricsSection + labelsSection
    }

    const feedbackSection = criticFeedback
      ? `\n## CRITIC FEEDBACK - FIX THESE ISSUES\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} / Fix ${i.suggestedFix}`).join('\n')}\n`
      : ''

    const systemPrompt = `You are an observability expert adding panels to a dashboard.
${GENERATION_PRINCIPLES}

## Task
The user wants to add panels to their dashboard. Generate the appropriate panel specifications based on their request.
Decide the right number of panels based on the request - a simple metric might need 1 panel, a broader topic might need 2-3.
Only add panels that directly answer the user's request. Do not broaden the topic.
${existingContext}${datasourceSection}${feedbackSection}

## PromQL Rules
- rate() on counters (*_total, *_count) with [5m]
- histogram_quantile() for percentiles on *_bucket, NEVER avg()
- Error ratios divide error rate by total rate
- sum by() / avg by() for aggregation
- For stat/gauge panels add "instant": true to the query
- Multi-series comparison: separate queries with refId A/B/C
- stat/gauge panels are for SINGLE values only. Do NOT use stat/gauge for grouped queries that return multiple region/tenant/service/pod series.
- If a query uses by(...), topk(...), or otherwise compares multiple entities, prefer bar, table, pie, or time_series instead of stat.
- Use percentunit ONLY for ratios in the 0..1 range that should be displayed as percentages.
- Metrics named *_score, *_health_score, or similar are usually scores, not 0..1 ratios. Do NOT assume percentunit for them.

## Layout
Grid starts at row ${input.gridNextRow}, 12-column grid.
- stat: width=3, height=2
- time_series full: width=12, height=3
- time_series paired: width=6, height=3
- bar/table: width=6, height=3

## Output
Return a JSON array of panel specs:
[
  {
    "title": "",
    "description": "",
    "visualization": "time_series",
    "queries": [{ "refId": "A", "expr": "", "legendFormat": "", "instant": false }],
    "row": 0, "col": 0, "width": 12, "height": 3,
    "unit": "reqps", "stackMode": "none", "fillOpacity": 10, "thresholds": []
  }
]

Valid units: bytes, bytes/s, seconds, ms, percentunit, percent, reqps, short, none
Valid visualizations: time_series, stat, table, gauge, bar, heatmap, pie, histogram, status_timeline
ONLY return the JSON array.`

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Add panels for: ${input.goal}` },
      ], {
        model: this.deps.model,
        maxTokens: 8192,
        temperature: 0.2,
        responseFormat: 'json',
      })

      const parsed = parseLlmJson(resp.content) as unknown
      return Array.isArray(parsed) ? parsed as RawPanelSpec[] : []
    }
    catch (err) {
      log.warn({ err }, 'generate failed')
      return []
    }
  }

  // -- Quick Critic
  private async critique(
    panels: RawPanelSpec[],
    input: PanelAdderInput,
  ): Promise<CriticFeedback> {
    const systemPrompt = `You are a senior SRE doing a quick review of new panels being added to a dashboard.

Review Context
User request: ${input.goal}
Existing panels: ${input.existingPanels.map((p) => p.title).join(', ') || '(none)'}

## Review Criteria (in priority order)
1. Scope Obedience - Does every panel directly serve "${input.goal}"? Any panel for unrequested metrics or topics is an error.
2. PromQL Correctness - Counters need rate(), histograms need histogram_quantile() on bucket, aggregations need by() clauses.
3. Panel Count - Only as many panels as needed to answer the request. Fewer is better.
4. Duplication - Do any new panels duplicate existing ones?
5. Visualization - Is each chart type appropriate? stat/gauge need instant=true and should only be used for single-value queries.

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "...",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | panel_count | redundant",
      "description": "What's wrong",
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
        maxTokens: 1024,
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

  // -- Convert raw specs to PanelConfig
  private toPanelConfigs(rawPanels: RawPanelSpec[], startRow: number): PanelConfig[] {
    return rawPanels.map((raw) => {
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
        title: raw.title ?? 'Panel',
        description: raw.description ?? '',
        queries,
        visualization,
        row: Math.max(0, (raw.row ?? 0) + startRow),
        col: Math.min(11, Math.max(0, raw.col ?? 0)),
        width: Math.min(12, Math.max(1, raw.width ?? 6)),
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

  // -- Variable Detection
  private detectNewVariables(
    panels: PanelConfig[],
    input: PanelAdderInput,
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
      for (const [metric, labels] of Object.entries(input.labelsByMetric)) {
        if (labels.includes(varName)) {
          sourceMetric = metric
          break
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
}
