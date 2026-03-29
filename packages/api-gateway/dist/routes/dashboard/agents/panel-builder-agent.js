import { randomUUID } from 'node:crypto';

const VALID_VISUALIZATIONS = new Set([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
]);
const MAX_RETRIES = 3;
// PromQL keywords to skip when looking for metric name candidates
const PROMQL_KEYWORDS = new Set([
  'rate', 'sum', 'avg', 'max', 'min', 'count', 'by', 'without', 'on', 'ignoring',
  'group_left', 'group_right', 'histogram_quantile', 'label_replace', 'label_join',
  'increase', 'irate', 'delta', 'idelta', 'offset', 'bool', 'and', 'or', 'unless',
  'topk', 'bottomk', 'quantile', 'stddev', 'stdvar', 'count_values', 'absent',
  'present_over_time', 'last_over_time', 'sort', 'sort_desc', 'scalar', 'vector',
]);

export class PanelBuilderAgent {
  gateway;
  model;
  prometheusUrl;
  headers;
  sendEvent;

  constructor(gateway, model, prometheusUrl, headers, sendEvent) {
    this.gateway = gateway;
    this.model = model;
    this.prometheusUrl = prometheusUrl;
    this.headers = headers;
    this.sendEvent = sendEvent;
  }

  async build(input) {
    this.sendEvent?.({ type: 'thinking', content: `Designing panels for: ${input.goal}` });
    // Step 1: LLM generates panel configs using methodology-driven analysis
    const rawPanels = await this.generatePanels(input);
    this.sendEvent?.({
      type: 'tool_result',
      tool: 'generate_panels',
      summary: `Designed ${rawPanels.length} panels`,
      success: true,
    });
    // Step 2: Validate every query against Prometheus and self-correct on failure
    const validatedPanels = await this.validateAndCorrect(rawPanels, input.availableMetrics);
    const variables = this.detectVariables(validatedPanels, input);
    return {
      panels: validatedPanels,
      variables: variables.length > 0 ? variables : undefined,
    };
  }

  // Step 1: LLM Panel Generation
  async generatePanels(input) {
    const scopeGuidance = {
      single: 'Create ONLY 1-2 panels directly addressing the goal. No overview rows or multi-section structure.',
      group: 'Create 3-6 related panels. Do not start overview row. Be actionable but useful.',
      comprehensive: 'Create 15-25 panels with full methodology coverage: overview KPI stats - core trends - top/bottom sections - detail tables.',
    };
    const researchSection = input.researchContext
      ? `\n## Research Context\n${input.researchContext}\n`
      : '';
    const hasDiscoveredMetrics = input.availableMetrics.length > 0;
    const hasResearchMetrics = input.keyMetrics?.length ?? 0 > 0;
    let metricsSection = '';
    if (hasDiscoveredMetrics) {
      metricsSection = `\n## Available Prometheus Metrics (discovered from cluster)\n${input.availableMetrics.slice(0, 80).join('\n')}\n`;
    }
    else if (hasResearchMetrics) {
      metricsSection = `\n## Technology-specific metric names (from research)\n${input.keyMetrics.join('\n')}\n${(input.metricPrefixes ?? []).length ? `Metric prefixes: ${input.metricPrefixes.join(', ')}` : ''}\nIMPORTANT: you MUST use the exact metric names or variants with these prefixes in your PromQL.\nDo NOT use metrics from unrelated technologies.`;
    }
    else {
      metricsSection = '\n## Available Metrics\nNo metrics discovered and no research metrics available - use your knowledge of standard naming conventions for this technology.\n';
    }
    const labelsSection = input.labelsByMetric && Object.keys(input.labelsByMetric).length > 0
      ? `\n## Label Dimensions\n${Object.entries(input.labelsByMetric).slice(0, 25).map(([metric, labels]) => `- ${metric}: ${labels.join(', ')}`).join('\n')}\n`
      : '';
    const existingSection = input.existingPanels.length > 0
      ? `\n## Existing Panels for de-duplication\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
      : '';
    const systemPrompt = `You are a senior SRE building production-grade Prometheus dashboard panels.

## SCOPE
${scopeGuidance[input.scope] ?? scopeGuidance.group}
Grid starts at row: ${input.gridNextRow}
${researchSection}${metricsSection}${labelsSection}${existingSection}

## METHODOLOGY - Detect and Apply Based on Available Metrics
- *_total, *_count -> Counter (MUST use rate())
- *_bucket -> Histogram (MUST use histogram_quantile())
- *_gauge, *_current, *_size, plain gauge names -> Gauge
- *_info -> Info metric (label extraction, use for table/status panels)

## INFER MONITORING METHODOLOGY from metric characteristics
- Service request/response/rpc metrics -> apply RED
- Node/container/kubernetes metrics -> apply USE
- General or mixed domain -> apply 4 Golden Signals
- Custom metrics -> reason from metric names and labels

## STRUCTURE the dashboard logically
- First row (rows): KPI stats
- Following rows: Core trend panels
- Bottom rows: Detail breakdowns

## VISUALIZATION RULES
- Current state KPI value -> stat (with instant=true)
- Percentage with meaningful thresholds -> gauge (with instant=true)
- Trend over time -> time_series
- Comparing related metrics -> time_series with MULTIPLE QUERIES
- Top-N ranking comparison -> bar
- Multi-dimensional detail -> table
- Distribution / latency buckets over time -> heatmap
- Multi-dimensional detail (per-pod, per-endpoint) -> table

## QUERY QUALITY - Production-grade PromQL
- ALWAYS use rate() on counters with [5m]
- CORRECT: sum(rate(http_requests_total[5m])) by (service)
- ALWAYS use histogram_quantile() for percentiles, NEVER avg()
- For error ratios: divide error rate by total rate
- Use variable references when template variables exist: {namespace="$namespace"}
- For multi-select variables use regex: {namespace=~"$namespace"}
- Multi-query panels: SEPARATE queries for each series (2xx/4xx/5xx as refId A/B/C)

## LAYOUT RULES (12-column grid)
- stat panels: ALWAYS width=3, height=2 (4 per row, cols 0/3/6/9)
- gauge panels: width=3, height=2
- time_series full: width=12, height=2
- time_series paired: width=6, height=2
- bar panels: width=6, height=2
- table panels: width=6 or 12, height=2-3
- new logical sections start on a new row
- col values fill left-to-right; track current col position per row

## MULTI-QUERY PATTERNS
- HTTP status: queries A(2xx), B(4xx), C(5xx) with legendFormat per class
- Latency percentiles: queries A(P50), B(P95), C(P99)
- CPU modes: queries A(user), B(system), C(iowait) with stackMode='normal'
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
    "row": ${input.gridNextRow},
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
ONLY return the JSON array - no markdown fences, no explanation text.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Goal: ${input.goal}\nScope: ${input.scope}` },
    ];
    try {
      const resp = await this.gateway.complete(messages, {
        model: this.model,
        maxTokens: 8192,
        temperature: 0.2,
        responseFormat: 'json',
      });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
      console.warn('[PanelBuilderAgent] generatePanels failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // Step 2: Validate + Self-Correct
  async validateAndCorrect(rawPanels, availableMetrics) {
    const BATCH_SIZE = 5;
    const result = [];
    for (let i = 0; i < rawPanels.length; i += BATCH_SIZE) {
      const batch = rawPanels.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((raw) => this.validateSinglePanel(raw, availableMetrics)));
      result.push(...batchResults.filter((p) => p !== null));
    }
    return result;
  }

  async validateSinglePanel(raw, availableMetrics) {
    const validatedQueries = [];
    for (const rawQuery of raw.queries ?? []) {
      const finalExpr = await this.validateAndFixQuery(rawQuery.expr, raw.title, availableMetrics);
      if (!finalExpr) {
        console.warn(`[PanelBuilderAgent] Dropping panel "${raw.title}" - query could not be fixed`);
        this.sendEvent?.({
          type: 'tool_result',
          tool: 'validate_query',
          summary: `Dropped panel "${raw.title}" after ${MAX_RETRIES} failed fix attempts`,
          success: false,
        });
        return null;
      }
      validatedQueries.push({
        refId: rawQuery.refId,
        expr: finalExpr,
        legendFormat: rawQuery.legendFormat,
        instant: rawQuery.instant,
      });
    }
    const visualization = VALID_VISUALIZATIONS.has(raw.visualization)
      ? raw.visualization
      : 'time_series';
    return {
      id: randomUUID(),
      title: raw.title ?? 'Panel',
      description: raw.description ?? '',
      queries: validatedQueries,
      visualization,
      row: Math.max(0, raw.row ?? 0),
      col: Math.min(11, Math.max(0, raw.col ?? 0)),
      width: Math.max(1, Math.min(12, raw.width ?? 6)),
      height: Math.max(2, raw.height ?? 3),
      unit: raw.unit,
      stackMode: raw.stackMode,
      fillOpacity: raw.fillOpacity,
      thresholds: raw.thresholds,
      decimals: raw.decimals,
      refreshIntervalSec: 30,
    };
  }

  /**
   * Validate a PromQL expression. On failure, attempt self-correction via LLM.
   * Returns the final (possibly corrected) expression, or null if max retries exceeded.
   */
  async validateAndFixQuery(expr, title, availableMetrics) {
    let finalExpr = expr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this.queryPrometheus(finalExpr);
      if (result.success)
        return finalExpr;
      const similarMetrics = this.findSimilarMetrics(finalExpr, availableMetrics);
      const fixed = await this.fixQueryWithLLM(finalExpr, result.error ?? 'Prometheus validation failed', title, similarMetrics);
      if (!fixed || fixed === finalExpr)
        break;
      finalExpr = fixed;
    }
    return null;
  }

  /** Execute a PromQL instant query against Prometheus to validate it */
  async queryPrometheus(expr) {
    if (!this.prometheusUrl) {
      return { success: true };
    }
    try {
      const url = `${this.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}`;
      const resp = await fetch(url, { headers: this.headers });
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, error: `HTTP ${resp.status}: ${text}` };
      }
      const json = await resp.json();
      if (json.status !== 'success') {
        return { success: false, error: json.error ?? 'query failed' };
      }
      return { success: true };
    }
    catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ask LLM to rewrite a failing PromQL expression */
  async fixQueryWithLLM(expr, error, title, availableMetrics) {
    const systemPrompt = `You are a Prometheus expert fixing a broken PromQL query.
Return ONLY the corrected PromQL query string, no markdown, no explanation.
The query must be valid PromQL and preserve the panel intent.
Panel title: ${title}
Validation error: ${error}
Available/similar metrics:
${availableMetrics.join('\n')}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: expr },
    ];
    try {
      const resp = await this.gateway.complete(messages, {
        model: this.model,
        maxTokens: 256,
        temperature: 0,
      });
      return resp.content.trim().replace(/^```[\w-]*\n?/g, '').replace(/```$/g, '').trim();
    }
    catch {
      return null;
    }
  }

  /**
   * Extract potential metric name tokens from a PromQL expression
   * and find similar names in the available metric list.
   */
  findSimilarMetrics(expr, availableMetrics) {
    const tokens = Array.from(expr.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)).map((m) => m[0]);
    const metricTokens = tokens.filter((t) => !PROMQL_KEYWORDS.has(t) && !t.startsWith('$'));
    const similar = new Set();
    for (const token of metricTokens) {
      for (const metric of availableMetrics) {
        if (metric.includes(token) || token.includes(metric)) {
          similar.add(metric);
        }
      }
    }
    return [...similar].slice(0, 50);
  }

  detectVariables(panels, input) {
    const existingNames = new Set(input.existingVariables.map((v) => v.name));
    const variables = [];
    const referencedVars = new Set();
    for (const panel of panels) {
      for (const query of panel.queries ?? []) {
        const matches = query.expr.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
        for (const m of matches) {
          referencedVars.add(m.slice(1));
        }
      }
    }
    for (const varName of referencedVars) {
      if (existingNames.has(varName))
        continue;
      let sourceMetric;
      for (const [metric, labels] of Object.entries(input.labelsByMetric)) {
        if (labels.includes(varName)) {
          sourceMetric = metric;
          break;
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
      });
    }
    return variables;
  }
}
//# sourceMappingURL=panel-builder-agent.js.map
