import { createLogger } from '@agentic-obs/common'
import type { Dashboard, PanelConfig } from '@agentic-obs/common'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type { IMetricsAdapter, RangeResult } from '../adapters/index.js'
import { agentRegistry } from '../runtime/agent-registry.js'

const log = createLogger('panel-explainer')

export interface PanelExplainDeps {
  gateway: LLMGateway
  model: string
  metrics: IMetricsAdapter
}

export interface PanelExplainInput {
  userRequest: string
  dashboard: Dashboard
  panel: PanelConfig
  timeRange?: { start: string; end: string; timezone?: string }
}

interface QuerySnapshot {
  refId: string
  expr: string
  instant: boolean
  summary: string
}

interface DisplayTimeRange {
  start: string
  end: string
  timezone: string
}

export class PanelExplainAgent {
  static readonly definition = agentRegistry.get('panel-explainer')!

  constructor(private deps: PanelExplainDeps) {}

  async explain(input: PanelExplainInput): Promise<string> {
    const querySnapshots = await Promise.all(
      (input.panel.queries ?? []).map((query) => this.describeQuery(
        query.refId,
        query.expr,
        !!query.instant,
        input.panel.visualization,
        input.timeRange,
      )),
    )

    const systemPrompt = `You explain observability dashboard panels using REAL metric results.

Rules:
- Base your explanation on the provided live query summaries, not generic dashboard advice.
- Treat the provided display time range as the exact analysis window. Do not replace it with "recently", "latest 5 minutes", or any other made-up window.
- Use the provided display time range exactly as written. Do not convert it to UTC or restate it in another timezone.
- Quote concrete current values, ranges, and trends when they are available.
- If the data looks normal or flat, say that plainly.
- Do not suggest an investigation unless the data actually indicates a problem.
- Keep it concise: 1 short paragraph or 3 short bullets max.
- Answer in the same language as the user's request when possible.`

    const userPrompt = JSON.stringify({
      userRequest: input.userRequest,
      dashboardTitle: input.dashboard.title,
      panel: {
        id: input.panel.id,
        title: input.panel.title,
        description: input.panel.description,
        visualization: input.panel.visualization,
        unit: input.panel.unit,
      },
      displayTimeRange: this.formatDisplayTimeRange(input.timeRange),
      liveData: querySnapshots,
    }, null, 2)

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        model: this.deps.model,
        maxTokens: 220,
        temperature: 0.2,
      })

      const text = resp.content.trim()
      if (text) return text
    }
    catch (error) {
      log.warn({ error }, 'panel explanation generation failed')
    }

    return querySnapshots.map((item) => item.summary).join('\n')
  }

  private async describeQuery(
    refId: string,
    expr: string,
    instant: boolean,
    visualization: PanelConfig['visualization'],
    timeRange?: { start: string; end: string },
  ): Promise<QuerySnapshot> {
    const windowLabel = this.describeWindow(timeRange)
    try {
      if (instant || visualization === 'stat' || visualization === 'gauge') {
        const samples = await this.deps.metrics.instantQuery(expr, timeRange?.end ? new Date(timeRange.end) : undefined)
        if (samples.length === 0) {
          return { refId, expr, instant: true, summary: `${refId}: no samples returned at the end of ${windowLabel}.` }
        }

        const values = samples.map((sample) => sample.value)
        const latest = values[0]
        const min = Math.min(...values)
        const max = Math.max(...values)
        const avg = values.reduce((sum, value) => sum + value, 0) / values.length
        return {
          refId,
          expr,
          instant: true,
          summary: `${refId}: current=${latest?.toPrecision(4)}, min=${min.toPrecision(4)}, max=${max.toPrecision(4)}, avg=${avg.toPrecision(4)}, series=${samples.length}, evaluated_at=${windowLabel}.`,
        }
      }

      const end = timeRange?.end ? new Date(timeRange.end) : new Date()
      const start = timeRange?.start ? new Date(timeRange.start) : new Date(end.getTime() - 60 * 60 * 1000)
      const ranges = await this.deps.metrics.rangeQuery(expr, start, end, '60')
      return {
        refId,
        expr,
        instant: false,
        summary: this.summarizeRange(ranges, refId, windowLabel),
      }
    }
    catch (error) {
      log.warn({ error, expr }, 'panel query explanation fetch failed')
      return { refId, expr, instant, summary: `${refId}: query failed for live explanation in ${windowLabel}.` }
    }
  }

  private summarizeRange(ranges: RangeResult[], refId: string, windowLabel: string): string {
    if (ranges.length === 0) return `${refId}: no time-series data returned in ${windowLabel}.`

    const series = ranges[0]
    if (!series || series.values.length === 0) return `${refId}: no time-series points returned in ${windowLabel}.`

    const nums = series.values.map(([, value]) => Number.parseFloat(value)).filter((value) => Number.isFinite(value))
    if (nums.length === 0) return `${refId}: no numeric points returned in ${windowLabel}.`

    const first = nums[0]!
    const latest = nums[nums.length - 1]!
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    const avg = nums.reduce((sum, value) => sum + value, 0) / nums.length
    const trend = latest > first * 1.1 ? 'rising' : latest < first * 0.9 ? 'falling' : 'stable'
    return `${refId}: latest=${latest.toPrecision(4)}, avg=${avg.toPrecision(4)}, min=${min.toPrecision(4)}, max=${max.toPrecision(4)}, trend=${trend}, points=${nums.length}, series=${ranges.length}, window=${windowLabel}.`
  }

  private formatDisplayTimeRange(timeRange?: { start: string; end: string; timezone?: string }): DisplayTimeRange | null {
    if (!timeRange?.start || !timeRange?.end) return null

    const timezone = timeRange.timezone || 'UTC'
    const start = new Date(timeRange.start)
    const end = new Date(timeRange.end)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null

    return {
      start: this.formatInTimezone(start, timezone),
      end: this.formatInTimezone(end, timezone),
      timezone,
    }
  }

  private describeWindow(timeRange?: { start: string; end: string; timezone?: string }): string {
    const display = this.formatDisplayTimeRange(timeRange)
    if (!display) return 'the requested time window'
    return `${display.start} to ${display.end} (${display.timezone})`
  }

  private formatInTimezone(date: Date, timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date).replace(',', '')
    }
    catch {
      return date.toISOString()
    }
  }
}
