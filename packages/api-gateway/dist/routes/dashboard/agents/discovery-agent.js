// Discovery Sub-agent - probes Prometheus to find metrics, labels, and sample data
export class DiscoveryAgent {
  prometheusUrl;
  headers;
  sendEvent;

  constructor(prometheusUrl, headers, sendEvent) {
    this.prometheusUrl = prometheusUrl;
    this.headers = headers;
    this.sendEvent = sendEvent;
  }

  /** Fetch all metric names from Prometheus (no filtering). */
  async fetchAllMetricNames() {
    return this.fetchMetricNames();
  }

  async discover(patterns) {
    this.sendEvent({
      type: 'thinking',
      content: `Exploring Prometheus for ${patterns.join(', ')} metrics...`,
    });
    // Step 1: Get all metric names and filter by patterns
    this.sendEvent({
      type: 'tool_call',
      tool: 'discover_metrics',
      args: { patterns },
      displayText: `Discovering metrics matching: ${patterns.join(', ')}`,
    });
    const allNames = await this.fetchMetricNames();
    const filtered = this.filterByPatterns(allNames, patterns);
    this.sendEvent({
      type: 'tool_result',
      tool: 'discover_metrics',
      summary: `Found ${filtered.length} matching metrics out of ${allNames.length} total`,
      success: true,
    });
    // Step 2: For top metrics, discover labels
    const topMetrics = filtered.slice(0, 20);
    const labelsByMetric = {};
    this.sendEvent({
      type: 'tool_call',
      tool: 'discover_labels',
      args: { metrics: topMetrics },
      displayText: `Discovering labels for ${topMetrics.length} metrics`,
    });
    await Promise.all(topMetrics.map(async (metric) => {
      labelsByMetric[metric] = await this.fetchLabels(metric);
    }));
    this.sendEvent({
      type: 'tool_result',
      tool: 'discover_labels',
      summary: `Discovered labels for ${topMetrics.length} metrics`,
      success: true,
    });
    // Step 3: Sample a few metrics to understand cardinality
    const sampleValues = {};
    const sampleTargets = topMetrics.slice(0, 5);
    this.sendEvent({
      type: 'tool_call',
      tool: 'sample_metrics',
      args: { metrics: sampleTargets },
      displayText: `Sampling ${sampleTargets.length} metrics for cardinality info`,
    });
    await Promise.all(sampleTargets.map(async (metric) => {
      sampleValues[metric] = await this.sampleMetric(metric);
    }));
    this.sendEvent({
      type: 'tool_result',
      tool: 'sample_metrics',
      summary: `Sampled ${sampleTargets.length} metrics`,
      success: true,
    });
    return {
      metrics: filtered,
      labelsByMetric,
      sampleValues,
      totalMetrics: allNames.length,
    };
  }

  async fetchMetricNames() {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/v1/label/__name__/values`;
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Prometheus returned HTTP ${res.status} fetching metric names`);
    }
    const body = await res.json();
    return Array.isArray(body.data) ? body.data : [];
  }

  filterByPatterns(names, patterns) {
    if (patterns.length === 0)
      return names;
    const lower = patterns.map((p) => p.toLowerCase().replace(/\s+$/, ''));
    return names.filter((name) => {
      const nameLower = name.toLowerCase();
      return lower.some((p) =>
        // If pattern ends with '_', treat as prefix match
        p.endsWith('_') ? nameLower.startsWith(p) : nameLower.includes(p));
    });
  }

  async fetchLabels(metric) {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    params.set('match[]', metric);
    const url = `${baseUrl}/api/v1/labels?${params}`;
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return [];
    }
    const body = await res.json();
    const labels = Array.isArray(body.data) ? body.data : [];
    // Exclude internal Prometheus label
    return labels.filter((l) => l !== '__name__');
  }

  async sampleMetric(metric) {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    params.set('query', metric);
    const url = `${baseUrl}/api/v1/query?${params}`;
    const res = await fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { count: 0, sampleLabels: [] };
    }
    const body = await res.json();
    const results = body.data?.result ?? [];
    const count = results.length;
    // Return up to 3 sample label sets (strip __name__ from labels)
    const sampleLabels = results.slice(0, 3).map((r) => {
      const { __name__: _name, ...rest } = r.metric;
      return rest;
    });
    return { count, sampleLabels };
  }
}
//# sourceMappingURL=discovery-agent.js.map
