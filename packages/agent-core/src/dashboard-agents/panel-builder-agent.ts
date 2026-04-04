import { parseLlmJson } from './llm-json.js'
import type { LLMGateway, CompletionMessage } from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common'
import type {
  PanelConfig,
  DashboardVariable,
  DashboardSseEvent,
} from '@agentic-obs/common'
import { PanelValidator } from './panel-validator.js'

const log = createLogger('panel-builder-agent')

export interface PanelBuilderInput {
  goal: string
  scope: 'single' | 'group' | 'comprehensive'
  availableMetrics: string[]
  labelsByMetric: Record<string, string[]>
  researchContext?: string
  /** Structured metric names from research (exact names the technology exposes) */
  keyMetrics?: string[]
  /** Metric name prefixes from research (for pattern matching) */
  metricPrefixes?: string[]
  existingPanels: PanelConfig[]
  existingVariables: DashboardVariable[]
  gridNextRow: number
}

export interface PanelBuilderOutput {
  panels: PanelConfig[]
  variables?: DashboardVariable[]
}

// Raw panel spec as returned by LLM, before validation and ID assignment
interface RawPanelSpec {
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

export class PanelBuilderAgent {
  private readonly validator: PanelValidator

  constructor(
    private gateway: LLMGateway,
    private model: string,
    private prometheusUrl: string | undefined,
    private headers: Record<string, string>,
    private sendEvent: (event: DashboardSseEvent) => void,
  ) {
    this.validator = new PanelValidator(gateway, model, prometheusUrl, headers, sendEvent)
  }

  async build(input: PanelBuilderInput): Promise<PanelBuilderOutput> {
    this.sendEvent({ type: 'thinking', content: `Designing panels for ${input.goal}` })

    // Step 1: LLM generates panel configs using methodology-driven analysis
    const rawPanels = await this.generatePanels(input)
    this.sendEvent({
      type: 'tool_result',
      tool: 'generate_panels',
      summary: `Designed ${rawPanels.length} panels`,
      success: true,
    })

    // Step 2: Validate every query against Prometheus and self-correct on failure
    const validatedPanels = await this.validator.validateAndCorrect(rawPanels, input.availableMetrics)

    // Step 3: Detect if template variables are needed from label dimensions
    const variables = this.detectVariables(validatedPanels, input)

    return {
      panels: validatedPanels,
      variables: variables.length > 0 ? variables : undefined,
    }
  }

  // -- Step 1: LLM Panel Generation
  private async generatePanels(input: PanelBuilderInput): Promise<RawPanelSpec[]> {
    const scopeGuidance: Record<PanelBuilderInput['scope'], string> = {
      single: 'Create ONLY 1-2 panels directly addressing the goal. No overview row or multi-section structure.',
      group: 'Create 3-6 related panels. Add overview row if acceptable.',
      comprehensive: 'Create 15-25 panels with full methodology coverage: overview KPI stats - core trends - topic-grouped sections - detail tables.',
    }

    const researchSection = input.researchContext
      ? `\n## Research Context / Best Practices\n${input.researchContext}\n`
      : ''

    const hasDiscoveredMetrics = input.availableMetrics.length > 0
    const hasResearchMetrics = (input.keyMetrics?.length ?? 0) > 0

    let metricsSection: string
    if (hasDiscoveredMetrics) {
      metricsSection = `\n## Available Prometheus Metrics (discovered from cluster)\n${input.availableMetrics.join('\n')}\n`
    }
    else if (hasResearchMetrics) {
      metricsSection = `\n## Technology-Specific Metric Names (from research)\nThese are the standard Prometheus metric names for this technology:\n${input.keyMetrics?.join('\n') ?? ''}\n${input.metricPrefixes?.length ? `\nMetric prefixes: ${input.metricPrefixes.join(', ')}` : ''}\nIMPORTANT: You MUST use these exact metric names (or variations with these prefixes) in your PromQL queries. Do NOT use metrics from unrelated technologies. These are the correct metrics for the user's requested technology.\n`
    }
    else {
      metricsSection = '\n## Available Metrics\nNo metrics were discovered and no research metrics available - use your best knowledge of standard Prometheus metric naming conventions for this technology.\n'
    }

    const labelsSection = Object.keys(input.labelsByMetric).length
      ? `\n## Label Dimensions (can be used as template variables)\n${Object.entries(input.labelsByMetric).slice(0, 20).map(([metric, labels]) => `- ${metric}: ${labels.join(', ')}`).join('\n')}\n`
      : ''

    const existingSection = input.existingPanels.length
      ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
      : ''

    const systemPrompt = `You are a senior SRE building production-grade Prometheus dashboard panels.

## SCOPE
${scopeGuidance[input.scope] ?? scopeGuidance.group}
Grid starts at row: ${input.gridNextRow}
${researchSection}${metricsSection}${labelsSection}${existingSection}

## METHODOLOGY - Detect and Apply Based on Available Metrics
1. DETECT METRIC TYPES from naming patterns:
- *_total, *_count -> Counter (MUST use rate())
- *_bucket -> Histogram (MUST use histogram_quantile())
- *_gauge, *_current, *_size, plain gauge names -> Gauge (direct value or ratio)
- *_info -> Info metric (label extraction, use for table/status panels)

2. INFER MONITORING METHODOLOGY from metric characteristics:
- See request/response/rpc metrics (*_requests_total, *_duration, *_rq) -> Apply RED method: Rate (req/s), Errors (error ratio), Duration (P50/P95/P99)
- Apply USE method: Utilization (% busy), Saturation (load), Errors (system errors)
- General or mixed domain -> Apply 4 Golden Signals: Latency, Traffic, Errors, Saturation
- Custom/unknown metrics -> inspect metric names and labels, apply general principles

3. Structure the dashboard logically:
- First row (rows): KPI overview (current state panels: up, req rate, width=3, height=2)
- Following rows: Core trend panels (time_series, width=12 or 6, height=3)
- Group panels by logical theme (traffic, errors, latency, resources, etc.)
- Bottom row: Detail breakdowns (table, bar)

## VISUALIZATION RULES
- Current state KPI value -> stat (with instant=true)
- Percentage with meaningful thresholds -> gauge (with instant=true)
- Trend over time -> time_series
- Comparing related metrics (2xx vs 4xx vs 5xx) -> time_series with MULTIPLE QUERIES
- Composition/breakdown (traffic by status code) -> time_series with stackMode "normal"
- Top-N ranking comparison -> bar
- Distribution (latency buckets over time) -> heatmap
- Multi-dimensional detail (per-pod, per-endpoint) -> table

## QUERY QUALITY - Production-grade PromQL
- ALWAYS use rate() on counters with [5m] interval
- CORRECT: sum(rate(http_requests_total[5m])) by (service)
- ALWAYS use histogram_quantile() for percentiles, NEVER avg()
- CORRECT: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))
- For error ratios: divide errors by total
- CORRECT: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))
- Aggregations should use by() or avg by() to control series cardinality
- Use variable references when template variables exist: {namespace="$namespace"}
- For multi-select variables use regex: {namespace=~"$namespace"}
- Multi-query panels: SEPARATE queries for each series (2xx/4xx/5xx as refId A/B/C)

## LAYOUT RULES (12-column grid)
- stat panels: ALWAYS width=3, height=2 (4 per row, cols 0/3/6/9)
- gauge panels: width=3, height=2
- time_series (full-width): width=12, height=2
- time_series (paired): width=6, height=2
- bar panels: width=6, height=2
- table panels: width=6 or 12, height=2-3
- New logical sections start on a new row
- row values fill left-to-right; track current col position per row

## MULTI-QUERY PATTERNS
Use multiple queries in a single panel to overlay related series:
- HTTP status: queries A(2xx), B(4xx), C(5xx) with legendFormat per class
- Latency percentiles: queries A(P50), B(P95), C(P99) overlaid
- CPU modes: queries A(user), B(system), C(iowait) with stackMode: "normal"
- Network I/O: queries A(rx), B(tx) with positive/negative mirroring

## OUTPUT FORMAT
Return a JSON array of panel specs. Every field is required:
[
  {
    "title": "Request Rate",
    "description": "Total HTTP requests per second by service",
    "visualization": "time_series",
    "queries": [
      { "refId": "A", "expr": "sum(rate(http_requests_total[5m])) by (service)", "legendFormat": "{{service}}" }
    ],
    "row": 0,
    "col": 0,
    "width": 12,
    "height": 2,
    "unit": "reqps",
    "stackMode": "none",
    "fillOpacity": 10,
    "thresholds": []
  }
]

Valid units: bytes, bytes/s, seconds, ms, percentunit, percent, reqps, short, none
Valid visualizations: time_series, stat, table, gauge, bar, heatmap, pie, histogram, status_timeline
ONLY return the JSON array - no markdown fences, no explanation text.`

    const messages: CompletionMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Goal: ${input.goal}\nScope: ${input.scope}` },
    ]

    try {
      const resp = await this.gateway.complete(messages, {
        model: this.model,
        maxTokens: 8192,
        temperature: 0.2,
        responseFormat: 'json',
      })

      const parsed = parseLlmJson(resp.content) as unknown
      return Array.isArray(parsed) ? parsed as RawPanelSpec[] : []
    }
    catch (err) {
      log.warn({ err }, 'generatePanels failed')
      return []
    }
  }

  // -- Step 3: Variable Detection
  private detectVariables(
    panels: PanelConfig[],
    input: PanelBuilderInput,
  ): DashboardVariable[] {
    const existingNames = new Set(input.existingVariables.map((v) => v.name))
    const variables: DashboardVariable[] = []

    // Collect all variable references used in panel queries
    const referencedVars = new Set<string>()
    for (const panel of panels) {
      for (const query of panel.queries ?? []) {
        const matches = query.expr.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? []
        for (const m of matches) {
          referencedVars.add(m.slice(1)) // strip leading '$'
        }
      }
    }

    // Create a DashboardVariable for each referenced $var not already present
    for (const varName of referencedVars) {
      if (existingNames.has(varName))
        continue

      // Find a source metric that carries this label for the label_values() query
      let sourceMetric: string | undefined
      for (const [metric, labels] of Object.entries(input.labelsByMetric)) {
        if (labels.includes(varName)) {
          sourceMetric = metric
          break
        }
      }

      const variable: DashboardVariable = {
        name: varName,
        label: varName.charAt(0).toUpperCase() + varName.slice(1),
        type: 'query',
        query: sourceMetric
          ? `label_values(${sourceMetric}, ${varName})`
          : `label_values(${varName})`,
        current: '',
        multi: true,
        includeAll: true,
      }

      variables.push(variable)
      existingNames.add(varName)
    }

    return variables
  }
}
