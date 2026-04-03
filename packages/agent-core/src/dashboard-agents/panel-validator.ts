import { randomUUID } from 'node:crypto'
import type { LLMGateway, CompletionMessage } from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common'
import type {
  PanelConfig,
  PanelQuery,
  PanelVisualization,
  DashboardSseEvent,
} from '@agentic-obs/common'

const log = createLogger('panel-validator')

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

const VALID_VISUALIZATIONS = new Set<string>([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
])

const MAX_RETRIES = 3

// PromQL keywords to skip when looking for metric name candidates
const PROMQL_KEYWORDS = new Set([
  'rate', 'sum', 'avg', 'max', 'min', 'count', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'histogram_quantile', 'label_replace', 'label_join',
  'increase', 'irate', 'delta', 'idelta', 'offset', 'bool', 'and', 'or', 'unless',
  'topk', 'bottomk', 'quantile', 'stddev', 'stdvar', 'count_values', 'absent',
  'present_over_time', 'last_over_time', 'sort', 'sort_desc', 'scalar', 'vector',
])

export class PanelValidator {
  constructor(
    private gateway: LLMGateway,
    private model: string,
    private prometheusUrl: string | undefined,
    private headers: Record<string, string>,
    private sendEvent: (event: DashboardSseEvent) => void,
  ) {}

  // Validate & Self-Correct
  async validateAndCorrect(
    rawPanels: RawPanelSpec[],
    availableMetrics: string[],
  ): Promise<PanelConfig[]> {
    const BATCH_SIZE = 5
    const result: PanelConfig[] = []

    for (let i = 0; i < rawPanels.length; i += BATCH_SIZE) {
      const batch = rawPanels.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map((raw) => this.validateSinglePanel(raw, availableMetrics)),
      )
      result.push(...batchResults.filter((p): p is PanelConfig => p !== null))
    }

    return result
  }

  private async validateSinglePanel(
    raw: RawPanelSpec,
    availableMetrics: string[],
  ): Promise<PanelConfig | null> {
    const validatedQueries: PanelQuery[] = []

    for (const rawQuery of raw.queries) {
      const finalExpr = await this.validateAndFixQuery(
        rawQuery.expr,
        raw.title,
        availableMetrics,
      )

      if (finalExpr === null) {
        log.warn({ panel: raw.title }, 'dropping panel - query could not be fixed')
        this.sendEvent({
          type: 'tool_result',
          tool: 'validate_query',
          summary: `Dropped panel "${raw.title}" after ${MAX_RETRIES} failed fix attempts.`,
          success: false,
        })
        return null
      }

      validatedQueries.push({
        refId: rawQuery.refId,
        expr: finalExpr,
        legendFormat: rawQuery.legendFormat,
        instant: rawQuery.instant,
      })
    }

    const visualization: PanelVisualization = VALID_VISUALIZATIONS.has(raw.visualization)
      ? raw.visualization as PanelVisualization
      : 'time_series'

    const panel: PanelConfig = {
      id: randomUUID(),
      title: raw.title ?? 'Panel',
      description: raw.description ?? '',
      queries: validatedQueries,
      visualization,
      row: Math.max(0, raw.row ?? 0),
      col: Math.min(11, Math.max(0, raw.col ?? 0)),
      width: Math.min(12, Math.max(1, raw.width ?? 6)),
      height: Math.max(2, raw.height ?? 2),
      refreshIntervalSec: 30,
      unit: raw.unit,
      stackMode: raw.stackMode,
      fillOpacity: raw.fillOpacity,
      decimals: raw.decimals,
      thresholds: raw.thresholds,
    }

    return panel
  }

  /**
   * Validate a PromQL expression. On failure, attempt self-correction via LLM.
   * Returns the final (possibly corrected) expression, or null if max retries exceeded.
   */
  private async validateAndFixQuery(
    expr: string,
    panelTitle: string,
    availableMetrics: string[],
  ): Promise<string | null> {
    let current = expr

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const validation = await this.queryPrometheus(current)

      if (validation.success) {
        if ((validation.seriesCount ?? 0) > 100) {
          // High cardinality - ask LLM to add aggregation
          this.sendEvent({
            type: 'tool_call',
            tool: 'fix_query',
            args: { panelTitle, issue: 'high_cardinality', seriesCount: validation.seriesCount },
            displayText: `Fixing "${panelTitle}" query returns ${validation.seriesCount} series - reducing cardinality.`,
          })

          const fixed = await this.fixQueryWithLLM(
            current,
            `Query returns ${validation.seriesCount} series (>100). Add sum by() or avg by() to reduce cardinality to a reasonable level.`,
            availableMetrics,
          )

          if (fixed) {
            current = fixed
            continue // re-validate the fixed query
          }
        }

        // Query is valid (0 series is OK - metric may be quiet)
        return current
      }

      // Query failed - diagnose and attempt fix
      const error = validation.error ?? 'unknown error'
      this.sendEvent({
        type: 'tool_call',
        tool: 'fix_query',
        args: { panelTitle, expr: current, error, attempt: attempt + 1 },
        displayText: `Fixing "${panelTitle}" query (attempt ${attempt + 1}): ${error}`,
      })

      let fixPrompt: string
      const errorLower = error.toLowerCase()

      if (
        errorLower.includes('unknown metric')
        || errorLower.includes('not found')
        || errorLower.includes('could not be found')
      ) {
        const similar = this.findSimilarMetrics(current, availableMetrics)
        fixPrompt
          = `Query failed: ${error}.`
            + (similar.length
              ? `\nSimilar available metrics: ${similar.join(', ')}. Rewrite the query using one of these.`
              : '\nNo similar metrics found. Rewrite using only available metrics.')
      }
      else if (errorLower.includes('parse error') || errorLower.includes('syntax')) {
        fixPrompt = `Query has a PromQL syntax error: ${error}. Fix the syntax.`
      }
      else {
        fixPrompt = `Query failed: ${error}. Rewrite to fix the issue.`
      }

      const fixed = await this.fixQueryWithLLM(current, fixPrompt, availableMetrics)
      if (!fixed)
        break

      current = fixed
    }

    // Exhausted retries
    return null
  }

  /** Execute a PromQL instant query against Prometheus to validate it */
  private async queryPrometheus(expr: string): Promise<{
    success: boolean
    error?: string
    seriesCount?: number
  }> {
    if (!this.prometheusUrl) {
      return { success: true }
    }

    try {
      const url = `${this.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}&time=${Math.floor(Date.now() / 1000)}`
      const res = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(5_000),
      })

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` }
      }

      const body = (await res.json()) as {
        status?: string
        data?: { result?: unknown[] }
        error?: string
      }

      if (body.status === 'error') {
        return { success: false, error: body.error }
      }

      const seriesCount = Array.isArray(body.data?.result) ? body.data.result.length : 0
      return { success: true, seriesCount }
    }
    catch (err) {
      // Network / timeout treat as success to avoid blocking dashboard generation
      log.warn({ err }, 'Prometheus validation timed out')
      return { success: true }
    }
  }

  /** Ask LLM to rewrite a failing PromQL expression */
  private async fixQueryWithLLM(
    expr: string,
    issue: string,
    availableMetrics: string[],
  ): Promise<string | null> {
    const contextMetrics = availableMetrics.length
      ? availableMetrics.slice(0, 100).join('\n')
      : '(no available metrics list)'

    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content: `You are a PromQL expert. Fix the given PromQL expression.
Rules:
- rate() on counters (*_total, *_count)
- histogram_quantile() for *_bucket metrics, NEVER avg()
- Only use metrics from the available list
Return ONLY the corrected PromQL expression - no quotes, no markdown, no explanation.`,
      },
      {
        role: 'user',
        content: `Original query: ${expr}\nIssue: ${issue}\nAvailable metrics:\n${contextMetrics}\n\nFixed query:`,
      },
    ]

    try {
      const resp = await this.gateway.complete(messages, {
        model: this.model,
        maxTokens: 256,
        temperature: 0,
      })
      const fixed = resp.content.replace(/```promql?\n?/g, '').replace(/```/g, '').trim()
      return fixed.length > 0 ? fixed : null
    }
    catch {
      return null
    }
  }

  /**
   * Extract potential metric name tokens from a PromQL expression
   * and find similar names in the available metrics list.
   */
  private findSimilarMetrics(expr: string, availableMetrics: string[]): string[] {
    const tokens = (expr.match(/[a-zA-Z_][a-zA-Z0-9_:]*/g) ?? []).filter(
      (t) => !PROMQL_KEYWORDS.has(t) && t.length > 4,
    )

    const similar: string[] = []
    for (const token of tokens) {
      const lower = token.toLowerCase()
      for (const metric of availableMetrics) {
        if (metric.toLowerCase().includes(lower) && !similar.includes(metric)) {
          similar.push(metric)
          if (similar.length >= 20)
            return similar
        }
      }
    }

    return similar
  }
}
