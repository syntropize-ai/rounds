import { randomUUID } from 'node:crypto'
import type { CompletionMessage, LLMGateway } from '@agentic-obs/llm-gateway'
import type { PanelConfig, PanelVisualization } from '@agentic-obs/common'
import { getSetupConfig } from '../setup.js'
import { createLlmGateway } from '../llm-factory.js'
import type { IGatewayDashboardStore } from '../../repositories/types.js'
import type { DashboardGenerator } from './router.js'

/** LiveDashboardGenerator - LLM-powered dashboard config generator.
// 1) Phase 1: Research (web search) -> 2) Discovery (Prometheus) -> 3) Generation (LLM)
 */
export class LiveDashboardGenerator implements DashboardGenerator {
  constructor(private readonly store: IGatewayDashboardStore) {}

  generate(dashboardId: string, prompt: string, userId: string): void {
    void this.execute(dashboardId, prompt, userId)
  }

  private async execute(dashboardId: string, prompt: string, _userId: string): Promise<void> {
    try {
      const config = getSetupConfig()
      if (!config.llm) {
        throw new Error('LLM not configured - please complete the Setup Wizard first.')
      }

      const gateway = this.createGateway(config.llm)
      const model = config.llm.model || 'claude-sonnet-4-5'
      const promDatasource = config.datasources.find((d) => d.type === 'prometheus' || d.type === 'victoria-metrics')

      // -- Phase 1: Research (web search)
      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 1: Research`)
      const researchContext = await this.research(gateway, model, prompt)

      // -- Phase 2: Discovery (probe Prometheus)
      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 2: Discovery`)
      const availableMetrics = await this.discoverMetrics(gateway, model, prompt, researchContext, promDatasource?.url)

      // -- Phase 3: Generation
      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 3: Generation`)
      const { title, description, panels } = await this.generateDashboard(
        gateway,
        model,
        prompt,
        researchContext,
        availableMetrics,
      )

      // Validate PromQL queries best-effort (non-blocking)
      const validatedPanels = await this.validatePanels(panels, promDatasource?.url)

      await this.store.update(dashboardId, { title, description })
      await this.store.updatePanels(dashboardId, validatedPanels)
      await this.store.updateStatus(dashboardId, 'ready')

      console.log(`[LiveDashboardGenerator] ${dashboardId} done - ${validatedPanels.length} panels`)
    }
    catch (err) {
      console.error(`[LiveDashboardGenerator] ${dashboardId} failed:`, err)
      await this.store.updateStatus(dashboardId, 'failed', `${err}`)
    }
  }

  // -- Phase 1: Research
  private async research(gateway: LLMGateway, model: string, prompt: string): Promise<string> {
    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content: `You are an observability expert. The user wants to create a monitoring dashboard.
Analyze their request and determine if you need to search the web for information about specific technology metrics.
Reply with JSON: { "needsSearch": true/false, "searchQuery": "what to search for", "reason": "why" }`,
      },
      { role: 'user', content: prompt },
    ]

    let needsSearch = false
    let searchQuery = ''

    try {
      const resp = await gateway.complete(messages, { model, maxTokens: 256, temperature: 0 })
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { needsSearch?: boolean, searchQuery?: string, reason?: string }
      needsSearch = !!parsed.needsSearch
      searchQuery = parsed.searchQuery ?? ''
      console.log('[LiveDashboardGenerator] Research decision:', needsSearch, searchQuery, parsed.reason)
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Research decision failed, skipping web search:', err instanceof Error ? err.message : err)
      return ''
    }

    if (!needsSearch || !searchQuery)
      return ''

    try {
      const encodedQuery = encodeURIComponent(searchQuery)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; observability-assistant/1.0)' },
        signal: AbortSignal.timeout(8_000),
      })

      if (!res.ok)
        return ''

      const html = await res.text()

      // Extract text snippets from DuckDuckGo result snippets
      const snippets: string[] = []
      const snippetPattern = /<a class="result__snippet" [^>]*>([\s\S]*?)<\/a>/g
      let match: RegExpExecArray | null
      while ((match = snippetPattern.exec(html)) !== null && snippets.length < 8) {
        const text = (match[1] ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#x27;/g, '\'')
          .trim()

        if (text.length > 20)
          snippets.push(text)
      }

      if (snippets.length === 0)
        return ''

      console.log('[LiveDashboardGenerator] Web search returned', snippets.length, 'snippets')
      return `Web search results for "${searchQuery}":\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Web search failed, proceeding without it:', err instanceof Error ? err.message : err)
      return ''
    }
  }

  // -- Phase 2: Discovery
  private async discoverMetrics(
    gateway: LLMGateway,
    model: string,
    prompt: string,
    researchContext: string,
    prometheusUrl: string | undefined,
  ): Promise<string[]> {
    if (!prometheusUrl) {
      console.warn('[LiveDashboardGenerator] No Prometheus datasource configured - skipping discovery')
      return []
    }

    // Ask LLM what metric patterns to look for
    const contextSection = researchContext ? `\nWeb research context:\n${researchContext}` : ''
    const planMessages: CompletionMessage[] = [
      {
        role: 'system',
        content: `You are an SRE. The user wants a monitoring dashboard. ${contextSection}
List up to 5 PromQL metric name prefix patterns to search for in Prometheus.
Reply with a JSON array of strings, e.g. ["http_request_", "container_cpu_", "node_memory"].
Only return the JSON array.`,
      },
      { role: 'user', content: prompt },
    ]

    let patterns: string[] = []
    try {
      const resp = await gateway.complete(planMessages, { model, maxTokens: 256, temperature: 0 })
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
      patterns = JSON.parse(cleaned) as string[]
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Metric pattern planning failed:', err instanceof Error ? err.message : err)
    }

    const allMetrics: string[] = []
    try {
      const labelUrl = `${prometheusUrl}/api/v1/label/__name__/values`
      const res = await fetch(labelUrl, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const body = await res.json() as { status?: string, data?: string[] }
        if (body.status === 'success' && Array.isArray(body.data)) {
          const metricNames: string[] = body.data
          // If patterns given, filter by them, otherwise return first 200
          if (patterns.length > 0) {
            for (const pattern of patterns) {
              const lower = pattern.toLowerCase()
              for (const name of metricNames) {
                if (name.toLowerCase().includes(lower) && !allMetrics.includes(name)) {
                  allMetrics.push(name)
                }
              }
            }
            // Also include some general metrics if we didn't find many
            if (allMetrics.length < 10) {
              allMetrics.push(...metricNames.slice(0, 50).filter((m) => !allMetrics.includes(m)))
            }
          }
          else {
            allMetrics.push(...metricNames.slice(0, 200))
          }
        }
      }
      console.log(`[LiveDashboardGenerator] Discovered ${allMetrics.length} metrics`)
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Prometheus discovery failed, proceeding with LLM best guess:', err instanceof Error ? err.message : err)
    }

    return allMetrics
  }

  // -- Phase 3: Generate
  private async generateDashboard(
    gateway: LLMGateway,
    model: string,
    prompt: string,
    researchContext: string,
    availableMetrics: string[],
  ): Promise<{ title: string, description: string, panels: Omit<PanelConfig, 'id'>[] }> {
    const researchSection = researchContext ? `\n## Web Research Results\n${researchContext}\n` : ''
    const metricsSection = availableMetrics.length > 0
      ? `\n## Available Prometheus Metrics\n${availableMetrics.join(', ')}\nIMPORTANT: Only use metrics that are in the "Available Prometheus Metrics" list above. If a metric doesn't exist, don't create a panel for it.\n`
      : '\n## Available Prometheus Metrics\nNo live Prometheus instance connected - use your best knowledge of common metric names.\n'

    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content: `You are a senior SRE designing a Prometheus monitoring dashboard.
${researchSection}${metricsSection}

Generate a dashboard config. For each panel, choose the best visualization:
- time_series for trends over time (latency, throughput, etc.)
- stat for single important numbers (current error rate, uptime)
- gauge for percentages (CPU usage, memory usage, SLO budget)
- table for multi-dimensional breakdowns (by pod, by instance)
- bar for comparing categories (top 5 endpoints by latency)

Layout: Use a 12-column grid. Common patterns:
- Row of 4 stat panels: each width=3, height=1
- Full-width time series: width=12, height=2
- Half-width charts: width=6, height=2

Reply with JSON:
{
  "title": "Dashboard Title",
  "description": "What this dashboard monitors",
  "panels": [
    {
      "title": "Panel Title",
      "description": "What this shows",
      "query": "valid PromQL expression",
      "visualization": "time_series",
      "row": 0, "col": 0, "width": 12, "height": 2,
      "unit": "seconds",
      "refreshIntervalSec": 30
    }
  ]
}

Only return the JSON object.`,
      },
      { role: 'user', content: prompt },
    ]

    const resp = await gateway.complete(messages, { model, maxTokens: 4096, temperature: 0.2 })
    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as {
      title: string
      description: string
      panels: Array<{
        title: string
        description: string
        query: string
        visualization: string
        row: number
        col: number
        width: number
        height: number
        unit?: string
        refreshIntervalSec?: number
      }>
    }

    const validVisualizations = new Set<PanelVisualization>(['time_series', 'stat', 'gauge', 'table', 'bar', 'heatmap', 'pie', 'histogram', 'status_timeline'])
    const panels: Omit<PanelConfig, 'id'>[] = (parsed.panels ?? []).map((p) => ({
      title: p.title ?? '',
      description: p.description ?? '',
      query: p.query ?? '',
      queries: p.query ? [{ refId: 'A', expr: p.query }] : [],
      visualization: (validVisualizations.has(p.visualization as PanelVisualization) ? p.visualization : 'time_series') as PanelVisualization,
      row: p.row ?? 0,
      col: p.col ?? 0,
      width: Math.min(12, Math.max(1, p.width ?? 6)),
      height: Math.max(1, p.height ?? 2),
      refreshIntervalSec: p.refreshIntervalSec ?? 30,
      unit: p.unit,
    } as Omit<PanelConfig, 'id'>))

    return {
      title: parsed.title ?? 'Dashboard',
      description: parsed.description ?? '',
      panels,
    }
  }

  // -- Validate PromQL queries
  private async validatePanels(
    panels: Omit<PanelConfig, 'id'>[],
    prometheusUrl: string | undefined,
  ): Promise<PanelConfig[]> {
    if (!prometheusUrl)
      return panels.map((p) => ({ ...p, id: randomUUID() }))

    return Promise.all(
      panels.map(async (p) => {
        const id = randomUUID()
        if (!p.query)
          return { ...p, id }

        try {
          const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(p.query)}&time=${Math.floor(Date.now() / 1000)}`
          const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
          if (res.ok) {
            const body = await res.json() as { status?: string, error?: string }
            if (body.status === 'error') {
              return {
                ...p,
                id,
                description: `${p.description} (Query validation warning: ${body.error ?? 'unknown error'})`,
              }
            }
          }
        }
        catch {
          // best-effort - don't block on validation failure
        }

        return { ...p, id }
      }),
    )
  }

  // -- Helpers
  private createGateway(llmConfig: Parameters<typeof createLlmGateway>[0]): ReturnType<typeof createLlmGateway> {
    return createLlmGateway(llmConfig)
  }
}

