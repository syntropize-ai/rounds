import { randomUUID } from 'node:crypto';

// --- Constants
const MAX_CRITIC_RETRIES = 1;
const VALID_VISUALIZATIONS = new Set([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
]);

// --- PanelAdderAgent
export class PanelAdderAgent {
  deps;

  constructor(deps) {
    this.deps = deps;
  }

  async addPanels(input) {
    const { sendEvent } = this.deps;
    let rawPanels = [];
    let feedback;
    for (let round = 0; round <= MAX_CRITIC_RETRIES; round++) {
      // Generate
      sendEvent?.({
        type: 'tool_call',
        tool: 'panel_adder_generate',
        args: { goal: input.goal },
        displayText: `Generating panels for: ${input.goal}${round > 0 ? ' (revision)' : ''}`,
      });
      rawPanels = await this.generate(input, feedback);
      sendEvent?.({
        type: 'tool_result',
        tool: 'panel_adder_generate',
        summary: `Generated ${rawPanels.length} panel(s)`,
        success: rawPanels.length > 0,
      });
      // Quick Critic
      sendEvent?.({
        type: 'tool_call',
        tool: 'panel_adder_critic',
        args: { panelCount: rawPanels.length },
        displayText: `Reviewing ${rawPanels.length} panel(s)...`,
      });
      feedback = await this.critique(rawPanels, input);
      sendEvent?.({
        type: 'tool_result',
        tool: 'panel_adder_critic',
        summary: `Score: ${feedback.overallScore}/10, ${feedback.issues.length} issue(s)`,
        success: feedback.approved,
      });
      if (feedback.approved)
        break;
      sendEvent?.({
        type: 'thinking',
        content: `Critic found ${feedback.issues.length} issue(s) - revising...`,
      });
    }
    const panels = this.toPanelConfigs(rawPanels, input.gridNextRow);
    const variables = this.detectNewVariables(panels, input);
    return { panels, variables: variables.length > 0 ? variables : undefined };
  }

  // --- Generate
  async generate(input, criticFeedback) {
    const existingSection = input.existingPanels.length > 0
      ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
      : '';
    const metricsSection = input.availableMetrics.length > 0
      ? `\n## Available Metrics\n${input.availableMetrics.slice(0, 80).join('\n')}\nPrefer metrics from this list when they fit the request.\n`
      : '';
    const labelsSection = Object.keys(input.labelsByMetric).length > 0
      ? `\n## Label Dimensions\n${Object.entries(input.labelsByMetric).slice(0, 15).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}\n`
      : '';
    const feedbackSection = criticFeedback?.issues?.length
      ? `\n## Critic Feedback - fix these issues\n${criticFeedback.issues.map((i) => `- [${i.severity}] ${i.panelTitle}: ${i.description} -> ${i.suggestedFix}`).join('\n')}\n`
      : '';
    const systemPrompt = `You are a PromQL expert adding panels to an existing dashboard.

## Task
The user wants to add panels to their dashboard. Generate the appropriate panel specifications based on their request.
Decide the right number of panels based on the request: a simple metric might need 1 panel, a broader topic might need 2-3.
${existingSection}${metricsSection}${labelsSection}${feedbackSection}

## PromQL Rules
- rate() on counters (*_total, *_count) with [5m]
- histogram_quantile() for percentiles on *_bucket, NEVER avg()
- Error ratios divide error rate by total rate
- sum by() / avg by() for aggregation
- For stat/gauge panels use "instant": true on the query
- Multi-series comparison: separate queries with refId A/B/C

## Layout
Start at row ${input.gridNextRow}, 12-column grid.
- stat width=3, height=2
- time_series full width=12, height=3
- time_series paired width=6, height=3
- bar/table width=6, height=3

## Output
Return a JSON array of panel specs:
[
  {
    "title": "...",
    "description": "...",
    "visualization": "time_series",
    "queries": [{ "refId": "A", "expr": "", "legendFormat": "", "instant": false }],
    "row": 0, "col": 0, "width": 12, "height": 3,
    "unit": "reqps", "stackMode": "none", "fillOpacity": 10, "thresholds": []
  }
]

Valid units: bytes, bytes/s, seconds, ms, percentunit, percent, reqps, short, none
Valid visualizations: time_series, stat, table, gauge, bar, heatmap, pie, histogram, status_timeline
ONLY return the JSON array.`;

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input.goal },
      ], { model: this.deps.model, maxTokens: 2048, temperature: 0.2, responseFormat: 'json' });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed) ? parsed : [];
    }
    catch (err) {
      console.warn('[PanelAdder] generate failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // --- Quick Critic
  async critique(panels, input) {
    const systemPrompt = `You are a senior SRE doing a quick review of new panels being added to a dashboard.

## Review Context
User request: ${input.goal}
Existing panels: ${input.existingPanels.map((p) => p.title).join(', ') || '(none)'}

## Review Criteria
1. Technology Relevance
2. PromQL Correctness
3. Visualization Appropriateness
4. Panel Count
5. Deduplication

## Output (JSON)
{
  "approved": true/false,
  "overallScore": 8,
  "issues": [
    {
      "panelTitle": "...",
      "severity": "error",
      "category": "technology_relevance | promql_error | visualization_mismatch | panel_count | redundant",
      "description": "what is wrong",
      "suggestedFix": "How to fix it"
    }
  ]
}

approved = true if overallScore >= 8 AND no severity=error issues.`;

    try {
      const resp = await this.deps.gateway.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(panels, null, 2) },
      ], { model: this.deps.model, maxTokens: 1024, temperature: 0, responseFormat: 'json' });
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
      const queries = (raw.queries ?? []).map((q) => ({
        refId: q.refId,
        expr: q.expr,
        legendFormat: q.legendFormat,
        instant: q.instant,
      }));
      const visualization = VALID_VISUALIZATIONS.has(raw.visualization)
        ? raw.visualization
        : 'time_series';
      return {
        id: randomUUID(),
        title: raw.title ?? 'Panel',
        description: raw.description ?? '',
        queries,
        visualization,
        row: Math.max(0, (raw.row ?? 0) + startRow),
        col: Math.min(11, Math.max(0, raw.col ?? 0)),
        width: Math.min(12, Math.max(1, raw.width ?? 6)),
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

  // --- Variable Detection
  detectNewVariables(panels, input) {
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
      existingNames.add(varName);
    }
    return variables;
  }
}
//# sourceMappingURL=panel-adder-agent.js.map
