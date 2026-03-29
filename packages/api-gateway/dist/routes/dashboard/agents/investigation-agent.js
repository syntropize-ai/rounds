import { randomUUID } from 'node:crypto';

const VALID_VISUALIZATIONS = new Set([
  'time_series', 'stat', 'table', 'gauge', 'bar',
  'heatmap', 'pie', 'histogram', 'status_timeline',
]);

// --- Investigation Sub-Agent
export class InvestigationAgent {
  gateway;
  model;
  prometheusUrl;
  headers;
  sendEvent;

  constructor(deps) {
    this.gateway = deps.gateway;
    this.model = deps.model;
    this.prometheusUrl = deps.prometheusUrl;
    this.headers = deps.prometheusHeaders;
    this.sendEvent = deps.sendEvent;
  }

  async investigate(input) {
    const plan = await this.planInvestigation(input);
    const evidence = await this.executeQueries(plan.queries ?? []);
    this.sendEvent?.({ type: 'tool_result', tool: 'investigate_queries', summary: `Executed ${evidence.length} queries`, success: true });
    // --- Build structured report with panels ---
    const reportSections = [];
    const panels = [];
    let currentRow = input.gridNextRow;
    let currentCol = 0;
    const analyzed = await this.analyzeEvidence(input, plan, evidence);
    for (const section of analyzed.sections ?? []) {
      reportSections.push(section);
      for (const rawPanel of section.panels ?? []) {
        const panel = this.toPanelConfig(rawPanel, currentRow, currentCol);
        panels.push(panel);
        currentCol += panel.width;
        if (currentCol >= 12) {
          currentCol = 0;
          currentRow += panel.height;
        }
      }
      currentCol = 0;
      currentRow += 1;
    }
    return {
      summary: analyzed.summary ?? 'Investigation complete',
      panels,
      report: {
        title: analyzed.title ?? 'Investigation Report',
        summary: analyzed.summary ?? 'Investigation complete',
        sections: reportSections,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async planInvestigation(input) {
    const metricsContext = input.availableMetrics && input.availableMetrics.length > 0
      ? `\n## Available Metrics in Prometheus\n${input.availableMetrics.join('\n')}\n`
      : '';
    const systemPrompt = `You are a senior SRE investigating a production issue.
Given the user's question, plan a short investigation deciding what Prometheus queries to run.
${metricsContext}
Return JSON with a list of PromQL queries and what each query is checking.`;
    const resp = await this.gateway.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.goal },
    ], { model: this.model, maxTokens: 2048, temperature: 0, responseFormat: 'json' });
    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }

  // --- Step 4: Execute queries against Prometheus ---
  async executeQueries(queries) {
    return Promise.all(queries.map(async (q) => {
      try {
        const endpoint = q.instant ? 'query' : 'query_range';
        const now = Math.floor(Date.now() / 1000);
        const params = q.instant
          ? `query=${encodeURIComponent(q.expr)}`
          : `query=${encodeURIComponent(q.expr)}&start=${now - 3600}&end=${now}&step=60`;
        const url = `${this.prometheusUrl}/api/v1/${endpoint}?${params}`;
        const resp = await fetch(url, { headers: this.headers });
        const data = await resp.json();
        return { ...q, success: resp.ok, data: data.data?.result ?? [], error: data.error };
      }
      catch (err) {
        return { ...q, success: false, data: [], error: err instanceof Error ? err.message : String(err) };
      }
    }));
  }

  async analyzeEvidence(input, plan, evidence) {
    const systemPrompt = `You are a senior SRE writing an investigation report. Analyze the Prometheus evidence and produce a structured report.

Start with a summary section (text only) giving the high-level conclusion.
Follow with evidence sections - each important finding gets its own section with explanation + panel.
End with recommendations section (text only).
Generate panel specs for evidence that supports findings (use the SAME working PromQL from evidence).
- stat/gauge panels need "instant": true in queries`;
    const resp = await this.gateway.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ input, plan, evidence }, null, 2) },
    ], { model: this.model, maxTokens: 4096, temperature: 0.1, responseFormat: 'json' });
    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  }

  toPanelConfig(raw, row, col) {
    const queries = (raw.queries ?? []).map((q) => ({
      refId: q.refId,
      expr: q.expr,
      legendFormat: q.legendFormat,
      instant: q.instant,
    }));
    return {
      id: randomUUID(),
      title: raw.title ?? 'Investigation Panel',
      description: raw.description ?? '',
      queries,
      visualization: VALID_VISUALIZATIONS.has(raw.visualization) ? raw.visualization : 'time_series',
      row,
      col,
      width: Math.min(12, Math.max(1, raw.width ?? 6)),
      height: Math.max(2, raw.height ?? 3),
      unit: raw.unit,
      stackMode: raw.stackMode,
      fillOpacity: raw.fillOpacity,
      thresholds: raw.thresholds,
      refreshIntervalSec: 30,
    };
  }
}
//# sourceMappingURL=investigation-agent.js.map
