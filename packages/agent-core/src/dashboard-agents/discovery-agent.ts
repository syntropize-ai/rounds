// Discovery Sub-Agent - probes Prometheus to find metrics, labels, and sample data

import type { DashboardSseEvent } from '@agentic-obs/common'
import type { IMetricsAdapter, MetricMetadata } from '../adapters/index.js'

export interface DiscoveryResult {
  metrics: string[]
  labelsByMetric: Record<string, string[]>
  sampleValues: Record<string, { count: number, sampleLabels: Record<string, string>[] }>
  metadataByMetric: Record<string, MetricMetadata>
  totalMetrics: number
  /** When relevant metrics is empty, these are the closest pattern-matched candidates from Prometheus */
  candidateMetrics?: string[]
}

export class DiscoveryAgent {
  constructor(
    private metrics: IMetricsAdapter,
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

    // Step 1: Discover metrics using server-side filtering when possible
    this.sendEvent({
      type: 'tool_call',
      tool: 'discover_metrics',
      args: { patterns },
      displayText: `Discovering metrics matching: ${patterns.join(', ')}`,
    })

    // Try server-side series match first (scales to large Prometheus instances)
    let filtered: string[] = []
    let totalMetrics = 0
    try {
      const seriesMetrics = await this.fetchMetricsBySeriesMatch(patterns)
      if (seriesMetrics.length > 0) {
        filtered = seriesMetrics
        totalMetrics = seriesMetrics.length // approximate
      }
    } catch {
      // Fallback: fetch all names and filter client-side
    }

    if (filtered.length === 0) {
      const allNames = await this.fetchMetricNames()
      totalMetrics = allNames.length
      filtered = this.filterByPatterns(allNames, patterns)
    }

    this.sendEvent({
      type: 'tool_result',
      tool: 'discover_metrics',
      summary: `Found ${filtered.length} matching metrics`,
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

    // Step 4: Fetch metric metadata (type + help text) for discovered metrics
    let metadataByMetric: Record<string, MetricMetadata> = {}
    try {
      this.sendEvent({
        type: 'tool_call',
        tool: 'fetch_metadata',
        args: { metrics: topMetrics.length },
        displayText: `Fetching metric metadata (type, help) for ${topMetrics.length} metrics`,
      })

      metadataByMetric = await this.metrics.fetchMetadata(topMetrics)

      this.sendEvent({
        type: 'tool_result',
        tool: 'fetch_metadata',
        summary: `Got metadata for ${Object.keys(metadataByMetric).length} metrics`,
        success: true,
      })
    } catch {
      // Metadata is best-effort; continue without it
    }

    return {
      metrics: filtered,
      labelsByMetric,
      sampleValues,
      metadataByMetric,
      totalMetrics,
    }
  }

  /** Server-side metric discovery via series match — scales to large instances */
  private async fetchMetricsBySeriesMatch(patterns: string[]): Promise<string[]> {
    // Convert patterns to PromQL matchers: "http" → {__name__=~".*http.*"}
    const matchers = patterns
      .filter((p) => p.trim().length > 0)
      .map((p) => {
        const safe = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return `{__name__=~".*${safe}.*"}`
      })

    if (matchers.length === 0) return []

    return this.metrics.findSeries(matchers)
  }

  private async fetchMetricNames(): Promise<string[]> {
    return this.metrics.listMetricNames()
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
    return this.metrics.listLabels(metric)
  }

  private async sampleMetric(metric: string): Promise<{ count: number, sampleLabels: Record<string, string>[] }> {
    try {
      const samples = await this.metrics.instantQuery(metric)
      const count = samples.length
      // Return up to 3 sample label sets (strip __name__ from labels)
      const sampleLabels = samples.slice(0, 3).map((s) => {
        const { __name__: _name, ...rest } = s.labels
        return rest
      })
      return { count, sampleLabels }
    } catch {
      return { count: 0, sampleLabels: [] }
    }
  }
}
