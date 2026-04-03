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
        this.sendEvent({ type: 'thinking', content: `Designing panels for ${input.goal}` });
        // Step 1: LLM generates panel configs using methodology-driven analysis
        const rawPanels = await this.generatePanels(input);
        this.sendEvent({
            type: 'tool_result',
            tool: 'generate_panels',
            summary: `Designed ${rawPanels.length} panels`,
            success: true,
        });
        // Step 2: Validate every query against Prometheus and self-correct on failure
        const validatedPanels = await this.validateAndCorrect(rawPanels, input.availableMetrics);
        // Step 3: Detect if template variables are needed from label dimensions
        const variables = this.detectVariables(validatedPanels, input);
        return {
            panels: validatedPanels,
            variables: variables.length > 0 ? variables : undefined,
        };
    }
    // -- Step 1: LLM Panel Generation
    async generatePanels(input) {
        const scopeGuidance = {
            single: 'Create ONLY 1-2 panels directly addressing the goal. No overview row or multi-section structure.',
            group: 'Create 3-6 related panels. Add overview row if acceptable.',
            comprehensive: 'Create 15-25 panels with full methodology coverage: overview KPI stats - core trends - topic-grouped sections - detail tables.',
        };
        const researchSection = input.researchContext
            ? `\n## Research Context / Best Practices\n${input.researchContext}\n`
            : '';
        const hasDiscoveredMetrics = input.availableMetrics.length > 0;
        const hasResearchMetrics = (input.keyMetrics?.length ?? 0) > 0;
        let metricsSection;
        if (hasDiscoveredMetrics) {
            metricsSection = `\n## Available Prometheus Metrics (discovered from cluster)\n${input.availableMetrics.join('\n')}\n`;
        }
        else if (hasResearchMetrics) {
            metricsSection = `\n## Technology-Specific Metric Names (from research)\nThese are the standard Prometheus metric names for this technology:\n${input.keyMetrics?.join('\n') ?? ''}\n${input.metricPrefixes?.length ? `\nMetric prefixes: ${input.metricPrefixes.join(', ')}` : ''}\nIMPORTANT: You MUST use these exact metric names (or variations with these prefixes) in your PromQL queries. Do NOT use metrics from unrelated technologies. These are the correct metrics for the user's requested technology.\n`;
        }
        else {
            metricsSection = '\n## Available Metrics\nNo metrics were discovered and no research metrics available - use your best knowledge of standard Prometheus metric naming conventions for this technology.\n';
        }
        const labelsSection = Object.keys(input.labelsByMetric).length
            ? `\n## Label Dimensions (can be used as template variables)\n${Object.entries(input.labelsByMetric).slice(0, 20).map(([metric, labels]) => `- ${metric}: ${labels.join(', ')}`).join('\n')}\n`
            : '';
        const existingSection = input.existingPanels.length
            ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
            : '';
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
    // -- Step 2: Validate & Self-Correct
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
        for (const rawQuery of raw.queries) {
            const finalExpr = await this.validateAndFixQuery(rawQuery.expr, raw.title, availableMetrics);
            if (finalExpr === null) {
                console.warn(`[PanelBuilderAgent] Dropping panel "${raw.title}" - query could not be fixed`);
                this.sendEvent({
                    type: 'tool_result',
                    tool: 'validate_query',
                    summary: `Dropped panel "${raw.title}" after ${MAX_RETRIES} failed fix attempts.`,
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
        const panel = {
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
        };
        return panel;
    }
    /**
     * Validate a PromQL expression. On failure, attempt self-correction via LLM.
     * Returns the final (possibly corrected) expression, or null if max retries exceeded.
     */
    async validateAndFixQuery(expr, panelTitle, availableMetrics) {
        let current = expr;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const validation = await this.queryPrometheus(current);
            if (validation.success) {
                if ((validation.seriesCount ?? 0) > 100) {
                    // High cardinality - ask LLM to add aggregation
                    this.sendEvent({
                        type: 'tool_call',
                        tool: 'fix_query',
                        args: { panelTitle, issue: 'high_cardinality', seriesCount: validation.seriesCount },
                        displayText: `Fixing "${panelTitle}" query returns ${validation.seriesCount} series - reducing cardinality.`,
                    });
                    const fixed = await this.fixQueryWithLLM(current, `Query returns ${validation.seriesCount} series (>100). Add sum by() or avg by() to reduce cardinality to a reasonable level.`, availableMetrics);
                    if (fixed) {
                        current = fixed;
                        continue; // re-validate the fixed query
                    }
                }
                // Query is valid (0 series is OK - metric may be quiet)
                return current;
            }
            // Query failed - diagnose and attempt fix
            const error = validation.error ?? 'unknown error';
            this.sendEvent({
                type: 'tool_call',
                tool: 'fix_query',
                args: { panelTitle, expr: current, error, attempt: attempt + 1 },
                displayText: `Fixing "${panelTitle}" query (attempt ${attempt + 1}): ${error}`,
            });
            let fixPrompt;
            const errorLower = error.toLowerCase();
            if (errorLower.includes('unknown metric')
                || errorLower.includes('not found')
                || errorLower.includes('could not be found')) {
                const similar = this.findSimilarMetrics(current, availableMetrics);
                fixPrompt
                    = `Query failed: ${error}.`
                        + (similar.length
                            ? `\nSimilar available metrics: ${similar.join(', ')}. Rewrite the query using one of these.`
                            : '\nNo similar metrics found. Rewrite using only available metrics.');
            }
            else if (errorLower.includes('parse error') || errorLower.includes('syntax')) {
                fixPrompt = `Query has a PromQL syntax error: ${error}. Fix the syntax.`;
            }
            else {
                fixPrompt = `Query failed: ${error}. Rewrite to fix the issue.`;
            }
            const fixed = await this.fixQueryWithLLM(current, fixPrompt, availableMetrics);
            if (!fixed)
                break;
            current = fixed;
        }
        // Exhausted retries
        return null;
    }
    /** Execute a PromQL instant query against Prometheus to validate it */
    async queryPrometheus(expr) {
        if (!this.prometheusUrl) {
            return { success: true };
        }
        try {
            const url = `${this.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}&time=${Math.floor(Date.now() / 1000)}`;
            const res = await fetch(url, {
                headers: this.headers,
                signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
                return { success: false, error: `HTTP ${res.status}` };
            }
            const body = (await res.json());
            if (body.status === 'error') {
                return { success: false, error: body.error };
            }
            const seriesCount = Array.isArray(body.data?.result) ? body.data.result.length : 0;
            return { success: true, seriesCount };
        }
        catch (err) {
            // Network / timeout treat as success to avoid blocking dashboard generation
            console.warn('[PanelBuilderAgent] Prometheus validation timed out:', err instanceof Error ? err.message : err);
            return { success: true };
        }
    }
    /** Ask LLM to rewrite a failing PromQL expression */
    async fixQueryWithLLM(expr, issue, availableMetrics) {
        const contextMetrics = availableMetrics.length
            ? availableMetrics.slice(0, 100).join('\n')
            : '(no available metrics list)';
        const messages = [
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
        ];
        try {
            const resp = await this.gateway.complete(messages, {
                model: this.model,
                maxTokens: 256,
                temperature: 0,
            });
            const fixed = resp.content.replace(/```promql?\n?/g, '').replace(/```/g, '').trim();
            return fixed.length > 0 ? fixed : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Extract potential metric name tokens from a PromQL expression
     * and find similar names in the available metrics list.
     */
    findSimilarMetrics(expr, availableMetrics) {
        const tokens = (expr.match(/[a-zA-Z_][a-zA-Z0-9_:]*/g) ?? []).filter((t) => !PROMQL_KEYWORDS.has(t) && t.length > 4);
        const similar = [];
        for (const token of tokens) {
            const lower = token.toLowerCase();
            for (const metric of availableMetrics) {
                if (metric.toLowerCase().includes(lower) && !similar.includes(metric)) {
                    similar.push(metric);
                    if (similar.length >= 20)
                        return similar;
                }
            }
        }
        return similar;
    }
    // -- Step 3: Variable Detection
    detectVariables(panels, input) {
        const existingNames = new Set(input.existingVariables.map((v) => v.name));
        const variables = [];
        // Collect all variable references used in panel queries
        const referencedVars = new Set();
        for (const panel of panels) {
            for (const query of panel.queries ?? []) {
                const matches = query.expr.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
                for (const m of matches) {
                    referencedVars.add(m.slice(1)); // strip leading '$'
                }
            }
        }
        // Create a DashboardVariable for each referenced $var not already present
        for (const varName of referencedVars) {
            if (existingNames.has(varName))
                continue;
            // Find a source metric that carries this label for the label_values() query
            let sourceMetric;
            for (const [metric, labels] of Object.entries(input.labelsByMetric)) {
                if (labels.includes(varName)) {
                    sourceMetric = metric;
                    break;
                }
            }
            const variable = {
                name: varName,
                label: varName.charAt(0).toUpperCase() + varName.slice(1),
                type: 'query',
                query: sourceMetric
                    ? `label_values(${sourceMetric}, ${varName})`
                    : `label_values(${varName})`,
                current: '',
                multi: true,
                includeAll: true,
            };
            variables.push(variable);
            existingNames.add(varName);
        }
        return variables;
    }
}
//# sourceMappingURL=panel-builder-agent.js.map