import { randomUUID } from 'node:crypto';
import { DiscoveryAgent } from './discovery-agent.js';
import { ResearchAgent } from './research-agent.js';
const MAX_CRITIC_ROUNDS = 2;
const VALID_VISUALIZATIONS = new Set([
    'time_series', 'stat', 'table', 'gauge', 'bar',
    'heatmap', 'pie', 'histogram', 'status_timeline',
]);
export class DashboardGeneratorAgent {
    deps;
    researchAgent;
    constructor(deps) {
        this.deps = deps;
        this.researchAgent = new ResearchAgent(deps.gateway, deps.model, deps.sendEvent);
    }
    async generate(input, onGroupComplete) {
        const { sendEvent } = this.deps;
        // Step 0/1: Research + Discovery in parallel
        const shortGoal = input.goal.length > 60 ? input.goal.slice(0, 60) : input.goal;
        sendEvent?.({
            type: 'tool_call',
            tool: 'research',
            args: { topic: input.goal },
            displayText: `Researching monitoring patterns for: ${shortGoal}`,
        });
        if (this.deps.prometheusUrl) {
            sendEvent?.({
                type: 'tool_call',
                tool: 'discover',
                args: { goal: input.goal },
                displayText: 'Discovering available metrics from cluster',
            });
        }
        // Run research and discovery concurrently
        const researchPromise = this.researchAgent.research(input.goal)
            .then((result) => {
            sendEvent?.({
                type: 'tool_result',
                tool: 'research',
                summary: result.keyMetrics.length
                    ? `Found ${result.keyMetrics.length} key metrics`
                    : 'Using LLM knowledge (no web results)',
                success: true,
            });
            return result;
        })
            .catch(() => {
            sendEvent?.({
                type: 'tool_result',
                tool: 'research',
                summary: 'Web search failed - using LLM knowledge',
                success: false,
            });
            return undefined;
        });
        const discoveryPromise = this.deps.prometheusUrl
            ? (async () => {
                try {
                    const discoveryAgent = new DiscoveryAgent(this.deps.prometheusUrl, this.deps.prometheusHeaders ?? {}, sendEvent);
                    const allMetrics = await discoveryAgent.fetchAllMetricNames();
                    const relevant = await this.selectRelevantMetrics(input.goal, allMetrics);
                    const result = {
                        metrics: relevant,
                        labelsByMetric: {},
                        sampleValues: {},
                        totalMetrics: allMetrics.length,
                    };
                    sendEvent?.({
                        type: 'tool_result',
                        tool: 'discover',
                        summary: relevant.length
                            ? `Found ${relevant.length} relevant metrics (from ${allMetrics.length} total)`
                            : `Scanned ${allMetrics.length} metrics - using best practices`,
                        success: true,
                    });
                    return result;
                }
                catch (err) {
                    sendEvent?.({
                        type: 'tool_result',
                        tool: 'discover',
                        summary: `Discovery failed: ${err instanceof Error ? err.message : 'unknown error'}`,
                        success: false,
                    });
                    return undefined;
                }
            })()
            : Promise.resolve(undefined);
        const [researchResult, discoveryResult] = await Promise.all([researchPromise, discoveryPromise]);
        // Step 2: Planner
        sendEvent?.({
            type: 'tool_call',
            tool: 'planner',
            args: { goal: input.goal },
            displayText: 'Planning dashboard structure',
        });
        const plan = await this.plan(input, researchResult, discoveryResult);
        sendEvent?.({
            type: 'tool_result',
            tool: 'planner',
            summary: `Planned ${plan.groups.length} sections, ~${plan.groups.reduce((n, g) => n + g.panelSpecs.length, 0)} panels`,
            success: true,
        });
        // Step 3: Generate + Critic per group (parallel)
        // Pre-calculate start rows so groups can run in parallel
        const groupStartRows = [];
        let estimatedRow = 0;
        for (const group of plan.groups) {
            groupStartRows.push(estimatedRow);
            // Estimate each panel spec ~3 rows high on average
            const estimatedHeight = group.panelSpecs.reduce((h, s) => {
                // stat panels 2 rows, others 3 rows; pack stats 4-wide
                if (s.visualization === 'stat')
                    return Math.max(h, 2);
                return h + (s.height ?? 3);
            }, 0);
            estimatedRow += Math.max(2, estimatedHeight);
        }
        sendEvent?.({ type: 'thinking', content: `Generating ${plan.groups.length} sections in parallel...` });
        let completedGroups = 0;
        const totalGroups = plan.groups.length;
        const groupResults = await Promise.all(plan.groups.map((group, i) => this.generateAndCriticLoop(group, input, researchResult, discoveryResult, groupStartRows[i] ?? 0).then(async (panels) => {
            const tagged = panels.map((p) => ({ ...p, sectionId: group.id, sectionLabel: group.label }));
            completedGroups++;
            sendEvent?.({
                type: 'tool_result',
                tool: 'build_progress',
                summary: `${completedGroups}/${totalGroups} sections - "${group.label}" (${tagged.length} panels)`,
                success: true,
            });
            // Progressive rendering: emit panels immediately
            if (onGroupComplete && tagged.length > 0) {
                await onGroupComplete(tagged);
            }
            return tagged;
        })));
        const allPanels = groupResults.flat();
        // Step 4: Validate queries against Prometheus (if available)
        const validated = this.deps.prometheusUrl
            ? await this.validateQueries(allPanels)
            : allPanels;
        // Step 5: Detect variables
        const variables = this.detectVariables(validated, input, discoveryResult);
        return {
            title: plan.title,
            description: plan.description,
            panels: validated,
            variables,
        };
    }
    // LLM-based metric selection (no rule-based filtering)
    async selectRelevantMetrics(goal, allMetrics) {
        if (allMetrics.length === 0)
            return [];
        try {
            // Pass all metric names to LLM and let it pick relevant ones
            const metricList = allMetrics.join('\n');
            const resp = await this.deps.gateway.complete([
                {
                    role: 'system',
                    content: `You are a Prometheus expert. Given a monitoring goal and a list of all available metric names, select the ones that are relevant for building dashboard.
Return a JSON array of the relevant metric names (exact strings from the list).
Select metrics that would be useful for monitoring the given topic.
If none are relevant, return an empty array [].
ONLY return the JSON array, nothing else.`,
                },
                {
                    role: 'user',
                    content: `Goal: ${goal}\n\nAvailable metrics:\n${metricList}`,
                },
            ], {
                model: this.deps.model,
                maxTokens: 4096,
                temperature: 0,
                responseFormat: 'json',
            });
            const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed))
                return [];
            // Only keep metrics that actually exist in the list
            const metricSet = new Set(allMetrics);
            return parsed.filter((x) => typeof x === 'string' && metricSet.has(x));
        }
        catch (err) {
            console.error('[DashboardGenerator] selectRelevantMetrics failed:', err instanceof Error ? err.message : err);
            return [];
        }
    }
    // Planner
    async plan(input, research, discovery) {
        const researchContext = research
            ? `\n## Research Context (from web search)\nMonitoring approach: ${research.monitoringApproach}\nKey metrics: ${research.keyMetrics.join(', ')}\nBest practices: ${research.bestPractices.join(', ')}\nPanel suggestions: ${research.panelSuggestions.join(', ')}\n`
            : '';
        const metricsContext = discovery?.metrics.length
            ? `\n## Available Metrics (from user's Prometheus - supplementary)\n${discovery.metrics.slice(0, 80).join('\n')}\nThese metrics exist in the cluster. Prefer them when relevant, but also include important standard metrics that may not be in this list. List metrics use your knowledge of standard Prometheus metric naming for this technology.\n`
            : '';
        const existingContext = input.existingPanels.length
            ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
            : '';
        const systemPrompt = `You are a senior SRE planning a monitoring dashboard.

## Task
Decompose the monitoring goal into logical panel GROUPS. Each group is a section of the dashboard.
${researchContext}${metricsContext}${existingContext}

## Planning Rules
1. Use your expertise to determine the right monitoring methodology (RED, USE, 4 Golden Signals, or custom) based on the technology.
2. Structure: overview stats first -> core trends -> breakdowns -> detail tables
3. STRICT LIMIT: 12-28 panels total, 3-6 sections max. Quality over quantity.
4. Each panel spec needs a queryIntent (natural language description of the query).
5. Use diverse visualization types - don't default everything to time_series. Pick the type that communicates the data best.

## Output Format (JSON)
{
  "title": "Dashboard Title",
  "description": "What this dashboard monitors",
  "groups": [
    {
      "id": "overview",
      "label": "Overview",
      "purpose": "Key health indicators at a glance",
      "panelSpecs": []
    }
  ],
  "variables": [
    { "name": "namespace", "label": "Namespace", "purpose": "Filter by namespace" }
  ]
}`;
        // Retry up to 2 times on JSON parse failure
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const resp = await this.deps.gateway.complete([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Goal: ${input.goal}\nScope: ${input.scope}` },
                ], {
                    model: this.deps.model,
                    maxTokens: 8192,
                    temperature: 0.1,
                    responseFormat: 'json',
                });
                const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const parsed = JSON.parse(cleaned);
                return {
                    title: parsed.title ?? input.goal,
                    description: parsed.description ?? '',
                    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
                    variables: Array.isArray(parsed.variables) ? parsed.variables : [],
                };
            }
            catch (err) {
                console.warn(`[DashboardGenerator] Planner attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
                if (attempt === 1)
                    throw err;
                this.deps.sendEvent?.({ type: 'thinking', content: 'Planner returned invalid JSON - retrying...' });
            }
        }
        // Unreachable, but satisfies TypeScript
        throw new Error('Planner failed after retries');
    }
    async generateAndCriticLoop(group, input, research, discovery, startRow) {
        let rawPanels = [];
        let feedback;
        for (let round = 0; round <= MAX_CRITIC_ROUNDS; round++) {
            this.deps.sendEvent?.({
                type: 'tool_call',
                tool: 'generate_group',
                args: { group: group.label, round },
                displayText: `Generating "${group.label}"${round > 0 ? ` (revision ${round})` : ''}`,
            });
            rawPanels = await this.generateGroup(group, input, research, discovery, startRow, feedback);
            this.deps.sendEvent?.({
                type: 'tool_call',
                tool: 'critic',
                args: { group: group.label, panelCount: rawPanels.length },
                displayText: `Reviewing "${group.label}" (${rawPanels.length} panels)`,
            });
            feedback = await this.critique(rawPanels, group, input);
            this.deps.sendEvent?.({
                type: 'tool_result',
                tool: 'critic',
                summary: `Score: ${feedback.overallScore}/10, ${feedback.issues.length} issue(s)`,
                success: feedback.approved,
            });
            if (feedback.approved)
                break;
            this.deps.sendEvent?.({
                type: 'thinking',
                content: `Critic found ${feedback.issues.length} issues in "${group.label}" - revising...`,
            });
        }
        return this.toPanelConfigs(rawPanels, startRow);
    }
    // Generator
    async generateGroup(group, input, research, discovery, startRow, criticFeedback) {
        const researchContext = research && research.keyMetrics.length > 0
            ? `\n## Research Context\nKey metrics from web search: ${research.keyMetrics.join(', ')}\nThese are reference alongside your own knowledge.\n`
            : '';
        const metricsSection = discovery && discovery.metrics.length > 0
            ? `\n## Available Metrics (from Prometheus - supplementary)\n${discovery.metrics.slice(0, 15).join('\n')}\nThese metrics exist in the cluster. Prefer them when relevant, but also include important standard metrics that may not be in this list. List metrics use your knowledge of standard metric naming for this technology.\n`
            : '';
        const labelsSection = discovery && Object.keys(discovery.labelsByMetric).length > 0
            ? `\n## Labels\n${Object.entries(discovery.labelsByMetric).slice(0, 15).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}\n`
            : '';
        const feedbackSection = criticFeedback
            ? `\n## Critic Feedback - FIX THESE ISSUES\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} / Fix: ${i.suggestedFix}`).join('\n')}\n`
            : '';
        const panelSpecsText = group.panelSpecs.map((s) => `- ${s.title} (${s.queryIntent}) (${s.visualization}) ${s.width}x${s.height}`).join('\n');
        const systemPrompt = `You are a PromQL expert generating dashboard panels for the "${group.label}" section.

## Section Purpose
${group.purpose}

## Panel Specifications
${panelSpecsText}
${researchContext}${metricsSection}${labelsSection}${feedbackSection}

## IMPORTANT
Each panel spec above specifies its visualization type in parentheses. You MUST use exactly that visualization type.
Do not change pie to time_series, do not change histogram to bar, etc.

## PromQL Rules
- rate() on counters (*_total, *_count) with [5m]
- histogram_quantile for percentiles from *_bucket, NEVER avg()
- Error ratios: divide error rate by total rate
- sum by() / avg by() for aggregation
- For stat/gauge/pie/histogram/bar panels add "instant": true to the query
- Multi-series comparison: separate queries with refId A/B/C

## Layout
Grid starts at row ${startRow}, 12-column grid.
- stat: width=3, height=2
- time_series full: width=12, height=3
- time_series paired: width=6, height=3
- bar/table/histogram: width=6, height=3
- gauge/pie: width=4, height=3
- heatmap: width=12, height=3
- status_timeline: width=12, height=2

## Visualization selection
- pie: use for proportional breakdowns (e.g. traffic share by service). Query should return multiple instant values.
- histogram: use for latency/size distributions from bucket metrics. Query the raw bucket metric with instant=true.
- heatmap: use for latency heatmaps over time. Query a bucket metric as range over time without transform.
- status_timeline: use for up/down or health status over time. Query should return 0/1 values per target as range queries.

## Output
Return a JSON array of panel specs. Use diverse visualization types - NOT just time_series.
[
  { "title": "Request Rate", "visualization": "stat", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 0, "col": 0, "width": 3, "height": 2 },
  { "title": "Latency Trend", "visualization": "time_series", "queries": [{ "refId": "A", "expr": "", "legendFormat": "{{pod}}" }], "row": 2, "col": 0, "width": 6, "height": 3 },
  { "title": "Traffic by Service", "visualization": "pie", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 2, "col": 6, "width": 4, "height": 3 },
  { "title": "Latency Distribution", "visualization": "histogram", "queries": [{ "refId": "A", "expr": "", "instant": true }], "row": 5, "col": 0, "width": 6, "height": 3 },
  { "title": "Service Health", "visualization": "status_timeline", "queries": [{ "refId": "A", "expr": "" }], "row": 8, "col": 0, "width": 12, "height": 2 }
]

Full panel spec keys: title, description, visualization, queries: [{refId, expr, legendFormat, instant}], row, col, width, height, unit, stackMode, fillOpacity, thresholds, decimals.
Valid units: bytes, bytes/s, seconds, ms, percentunit, percent, reqps, short, none
ONLY return the JSON array without markdown.`;
        try {
            const resp = await this.deps.gateway.complete([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Section: ${group.label}\nGoal: ${input.goal}` },
            ], {
                model: this.deps.model,
                maxTokens: 8192,
                temperature: 0.2,
                responseFormat: 'json',
            });
            const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch (err) {
            console.warn('[DashboardGenerator] generateGroup failed:', err instanceof Error ? err.message : err);
            return [];
        }
    }
    // Critic (pure LLM reasoning)
    async critique(panels, group, input) {
        const systemPrompt = `You are a senior SRE reviewing dashboard panels for quality and correctness.

## Review Context
Dashboard goal: ${input.goal}
Section: ${group.label} -> ${group.purpose}
Expected scope: ${input.scope}

## Review Criteria
1. Technology Relevance
2. PromQL Correctness
3. Visualization Appropriateness
4. Panel Count Appropriateness
5. Completeness
6. Redundancy

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "Error",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | panel_count | missing_coverage | redundant",
      "description": "what is wrong",
      "suggestedFix": "How to fix it"
    }
  ]
}

approved = true if overallScore >= 8 AND no severity=error issues.`;
        try {
            const resp = await this.deps.gateway.complete([
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Panels to review:\n${JSON.stringify(panels, null, 2)}` },
            ], {
                model: this.deps.model,
                maxTokens: 2048,
                temperature: 0,
                responseFormat: 'json',
            });
            const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            return {
                approved: !!parsed.approved,
                overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 5,
                issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            };
        }
        catch {
            // If critic fails, approve by default (don't block generation)
            return { approved: true, overallScore: 7, issues: [] };
        }
    }
    // Convert raw specs to PanelConfig
    toPanelConfigs(rawPanels, startRow) {
        return rawPanels.map((raw) => {
            const visualization = VALID_VISUALIZATIONS.has(raw.visualization)
                ? raw.visualization
                : 'time_series';
            const queries = (raw.queries ?? []).map((q) => ({
                refId: q.refId,
                expr: q.expr,
                legendFormat: q.legendFormat,
                instant: q.instant,
            }));
            return {
                id: randomUUID(),
                title: raw.title ?? 'Panel',
                description: raw.description ?? '',
                queries,
                visualization,
                row: Math.max(0, raw.row ?? startRow),
                col: Math.min(11, Math.max(0, raw.col ?? 0)),
                width: Math.max(2, Math.min(12, raw.width ?? 6)),
                height: Math.max(2, raw.height ?? 3),
                refreshIntervalSec: 30,
                unit: raw.unit,
                stackMode: raw.stackMode,
                fillOpacity: raw.fillOpacity,
                decimals: raw.decimals,
                thresholds: raw.thresholds,
            };
        });
    }
    // Validate queries against Prometheus
    async validateQueries(panels) {
        if (!this.deps.prometheusUrl)
            return panels;
        const validated = [];
        for (const panel of panels) {
            let allValid = true;
            for (const query of panel.queries ?? []) {
                const ok = await this.queryPrometheus(query.expr);
                if (!ok) {
                    allValid = false;
                    break;
                }
            }
            if (allValid) {
                validated.push(panel);
            }
            else {
                this.deps.sendEvent?.({
                    type: 'tool_result',
                    tool: 'validate_query',
                    summary: `Dropped "${panel.title}" - query validation failed`,
                    success: false,
                });
            }
        }
        return validated;
    }
    async queryPrometheus(expr) {
        try {
            if (!this.deps.prometheusUrl)
                return true;
            const url = `${this.deps.prometheusUrl}/api/v1/query?query=${encodeURIComponent(expr)}&time=${Math.floor(Date.now() / 1000)}`;
            const res = await fetch(url, { headers: this.deps.prometheusHeaders });
            if (!res.ok)
                return false;
            const body = await res.json();
            return body.status === 'success';
        }
        catch {
            return true; // Network error shouldn't block
        }
    }
    // Variable Detection
    detectVariables(panels, input, discovery) {
        const existingNames = new Set(input.existingVariables.map((v) => v.name));
        const variables = [];
        const referencedVars = new Set();
        for (const panel of panels) {
            for (const query of panel.queries ?? []) {
                const matches = query.expr.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
                for (const m of matches)
                    referencedVars.add(m.slice(1));
            }
        }
        for (const varName of referencedVars) {
            if (existingNames.has(varName))
                continue;
            let sourceMetric;
            if (discovery) {
                for (const [metric, labels] of Object.entries(discovery.labelsByMetric)) {
                    if (labels.includes(varName)) {
                        sourceMetric = metric;
                        break;
                    }
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
            existingNames.add(varName);
        }
        return variables;
    }
}
//# sourceMappingURL=dashboard-generator-agent.js.map