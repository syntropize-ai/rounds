// Discovery Sub-Agent - probes Prometheus to find metrics, labels, and sample data

import type { DashboardSseEvent } from '@agentic-obs/common'

export interface DiscoveryResult {
  metrics: string[]
  labelsByMetric: Record<string, string[]>
  sampleValues: Record<string, { count: number, sampleLabels: Record<string, string>[] }>
  totalMetrics: number
}

interface PrometheusVectorResult {
  metric: Record<string, string>
  value: [number, string]
}

interface PrometheusResponse<T> {
  status: string
  data: T
}

export class DiscoveryAgent {
  constructor(
    private prometheusUrl: string,
    private headers: Record<string, string>,
    private sendEvent: (event: DashboardSseEvent) => void,
  ) {}

  /** Fetch all metric names from Prometheus (no filtering). */
  async fetchAllMetricNames(): Promise<string[]> {
    return this.fetchMetricNames()
  }

  async discover(patterns: string[]): Promise<DiscoveryResult> {
    this.sendEvent({
      type: 'thinking',
      content: `Exploring Prometheus for ${patterns.join(', ')} metrics...`,
    })

    // Step 1: Get all metric names and filter by patterns
    this.sendEvent({
      type: 'tool_call',
      tool: 'discover_metrics',
      args: { patterns },
      displayText: `Discovering metrics matching: ${patterns.join(', ')}`,
    })

    const allNames = await this.fetchMetricNames()
    const filtered = this.filterByPatterns(allNames, patterns)

    this.sendEvent({
      type: 'tool_result',
      tool: 'discover_metrics',
      summary: `Found ${filtered.length} matching metrics out of ${allNames.length} total`,
      success: true,
    })

    // Step 2: For top metrics, discover labels
    const topMetrics = filtered.slice(0, 20)
    const labelsByMetric: Record<string, string[]> = {}

    this.sendEvent({
      type: 'tool_call',
      tool: 'discover_labels',
      args: { metrics: topMetrics },
      displayText: `Fetching labels for ${topMetrics.length} metrics`,
    })

    await Promise.all(topMetrics.map(async (metric) => {
      labelsByMetric[metric] = await this.fetchLabels(metric)
    }))

    this.sendEvent({
      type: 'tool_result',
      tool: 'discover_labels',
      summary: `Discovered labels for ${topMetrics.length} metrics`,
      success: true,
    })

    // Step 3: Sample a few metrics to understand cardinality
    const sampleValues: Record<string, { count: number, sampleLabels: Record<string, string>[] }> = {}
    const sampleTargets = topMetrics.slice(0, 5)

    this.sendEvent({
      type: 'tool_call',
      tool: 'sample_metrics',
      args: { metrics: sampleTargets },
      displayText: `Sampling ${sampleTargets.length} metrics for cardinality info`,
    })

    await Promise.all(sampleTargets.map(async (metric) => {
      sampleValues[metric] = await this.sampleMetric(metric)
    }))

    this.sendEvent({
      type: 'tool_result',
      tool: 'sample_metrics',
      summary: `Sampled ${sampleTargets.length} metrics`,
      success: true,
    })

    return {
      metrics: filtered,
      labelsByMetric,
      sampleValues,
      totalMetrics: allNames.length,
    }
  }

  private async fetchMetricNames(): Promise<string[]> {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '')
    const url = `${baseUrl}/api/v1/label/__name__/values`

    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      throw new Error(`Prometheus returned HTTP ${res.status} fetching metric names`)
    }

    const body = await res.json() as PrometheusResponse<string[]>
    return Array.isArray(body.data) ? body.data : []
  }

  private filterByPatterns(names: string[], patterns: string[]): string[] {
    if (!patterns.length)
      return names

    const lower = patterns.map((p) => p.toLowerCase().replace(/\s+$/, ''))
    return names.filter((name) => {
      const nameLower = name.toLowerCase()
      return lower.some((p) =>
        // If pattern ends with '_', treat as prefix match
        p.endsWith('_') ? nameLower.startsWith(p) : nameLower.includes(p))
    })
  }

  private async fetchLabels(metric: string): Promise<string[]> {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '')
    const params = new URLSearchParams()
    params.set('match[]', metric)
    const url = `${baseUrl}/api/v1/labels?${params}`

    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      return []
    }

    const body = await res.json() as PrometheusResponse<string[]>
    const labels = Array.isArray(body.data) ? body.data : []
    // Exclude internal Prometheus label
    return labels.filter((l) => l !== '__name__')
  }

  private async sampleMetric(metric: string): Promise<{ count: number, sampleLabels: Record<string, string>[] }> {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '')
    const params = new URLSearchParams()
    params.set('query', metric)
    const url = `${baseUrl}/api/v1/query?${params}`

    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      return { count: 0, sampleLabels: [] }
    }

    const body = await res.json() as PrometheusResponse<{ resultType: string, result: PrometheusVectorResult[] }>
    const results = body.data?.result ?? []
    const count = results.length
    // Return up to 3 sample label sets (strip __name__ from labels)
    const sampleLabels = results.slice(0, 3).map((r) => {
      const { __name__: _name, ...rest } = r.metric
      return rest
    })

    return { count, sampleLabels }
  }
}
