// Streamlined dashboard config generator.
// Research (web search) -> Discovery (Prometheus) -> Generation (LLM)
import { randomUUID } from 'node:crypto';
import { AnthropicProvider, LLMGateway } from '@agentic-obs/llm-gateways';
import { getSetupConfig } from './setup.js';

export class LiveDashboardGenerator {
  store;

  constructor(store) {
    this.store = store;
  }

  generate(dashboardId, prompt, userId) {
    void this.execute(dashboardId, prompt, userId);
  }

  async execute(dashboardId, prompt, _userId) {
    try {
      const config = await getSetupConfig();
      if (!config.llm) {
        throw new Error('LLM not configured - please complete the Setup Wizard first.');
      }

      const gateway = this.createGateway(config.llm);
      const model = config.llm.model || 'claude-sonnet-4-5';
      const prometheusDatasource = config.datasources.find((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');

      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 1: Research`);
      const researchContext = await this.research(gateway, model, prompt);
      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 2: Discovery`);
      const availableMetrics = await this.discoverMetrics(gateway, model, prompt, researchContext, prometheusDatasource?.url);
      console.log(`[LiveDashboardGenerator] ${dashboardId} Phase 3: Generation`);
      const { title, description, panels } = await this.generateDashboard(gateway, model, prompt, researchContext, availableMetrics);

      // Validate PromQL queries
      const validatedPanels = await this.validatePanels(panels, prometheusDatasource?.url);
      await this.store.update(dashboardId, { title, description, panels: validatedPanels });
      console.log(`[LiveDashboardGenerator] ${dashboardId} ready - ${validatedPanels.length} panels`);
    }
    catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[LiveDashboardGenerator] ${dashboardId} failed:`, errorMsg);
      await this.store.updateStatus(dashboardId, 'failed', errorMsg);
    }
  }

  // --- Phase 1: Research
  async research(gateway, model, prompt) {
    const messages = [
      {
        role: 'system',
        content: `You are an observability expert. The user wants to create a monitoring dashboard.
Analyze their request and determine if you need to search the web for information about specific technology metrics.
Reply with JSON: {"needsSearch": true/false, "searchQuery": "what to search for", "reason": "why"}`,
      },
      { role: 'user', content: prompt },
    ];

    let needsSearch = false;
    let searchQuery = '';
    try {
      const resp = await gateway.complete(messages, { model, maxTokens: 256, temperature: 0 });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      needsSearch = parsed.needsSearch;
      searchQuery = parsed.searchQuery;
      console.log(`[LiveDashboardGenerator] Research decision: needsSearch=${needsSearch}, reason=${parsed.reason}`);
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Research decision failed, skipping web search:', err instanceof Error ? err.message : err);
    }

    if (!needsSearch || !searchQuery) {
      return '';
    }

    try {
      const encodedQuery = encodeURIComponent(searchQuery);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      const searchResp = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; observability-assistant/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!searchResp.ok) {
        return '';
      }

      const html = await searchResp.text();
      const snippets = [];
      const snippetPattern = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/g;
      let match;
      while ((match = snippetPattern.exec(html)) !== null && snippets.length < 8) {
        const snippet = (match[1] ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&#x27;/g, '\'')
          .trim();
        if (snippet) {
          snippets.push(snippet);
        }
      }
      if (snippets.length > 0) {
        console.log(`[LiveDashboardGenerator] Web search returned ${snippets.length} snippet(s)`);
        return `Web search results for "${searchQuery}" (${snippets.length} snippet(s)):\n${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
      }
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Web search failed, proceeding without it:', err instanceof Error ? err.message : err);
    }

    return '';
  }

  // --- Phase 2: Discovery
  async discoverMetrics(gateway, model, prompt, researchContext, prometheusUrl) {
    if (!prometheusUrl) {
      console.warn('[LiveDashboardGenerator] No Prometheus datasource configured - skipping discovery');
      return [];
    }

    // Ask LLM what metric patterns to look for
    const contextSection = researchContext ? `\nWeb research context:\n${researchContext}\n` : '';
    const planMessages = [
      {
        role: 'system',
        content: `You are an SRE. The user wants a monitoring dashboard.${contextSection}
Reply with a JSON array of strings, e.g. ["http_requests", "container_cpu", "node_memory"]
Only return JSON array.`,
      },
      { role: 'user', content: prompt },
    ];

    let patterns = [];
    try {
      const resp = await gateway.complete(planMessages, { model, maxTokens: 256, temperature: 0 });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      patterns = JSON.parse(cleaned);
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Metric pattern planning failed:', err instanceof Error ? err.message : err);
    }

    const allMetrics = [];
    try {
      const labelUrl = `${prometheusUrl}/api/v1/label/__name__/values`;
      const res = await fetch(labelUrl, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const body = await res.json();
        const metricNames = Array.isArray(body.data) ? body.data : [];

        if (patterns.length > 0) {
          for (const pattern of patterns) {
            const lower = pattern.toLowerCase();
            for (const name of metricNames) {
              if (name.toLowerCase().includes(lower) && !allMetrics.includes(name)) {
                allMetrics.push(name);
              }
            }
          }

          // Also include some general ones if we didn't find many
          if (allMetrics.length < 10) {
            allMetrics.push(...metricNames.slice(0, 50).filter((n) => !allMetrics.includes(n)));
          }
        }
        else {
          allMetrics.push(...metricNames.slice(0, 200));
        }

        console.log(`[LiveDashboardGenerator] Discovered ${allMetrics.length} metrics`);
      }
    }
    catch (err) {
      console.warn('[LiveDashboardGenerator] Prometheus discovery failed, proceeding with LLM best guess:', err instanceof Error ? err.message : err);
    }

    return allMetrics;
  }

  // --- Phase 3: Generate
  async generateDashboard(gateway, model, prompt, researchContext, availableMetrics) {
    const researchSection = researchContext ? `\nWeb Research Results\n${researchContext}\n` : '';
    const metricsSection = availableMetrics.length > 0
      ? `\n## Available Prometheus Metrics\n${availableMetrics.join('\n')}\nIMPORTANT: Only use metrics that appear above if Prometheus metrics are available.`
      : '\n## Available Prometheus Metrics\nNo Prometheus instance connected - use your best knowledge of common metric names.\n';

    const messages = [
      {
        role: 'system',
        content: `You are a senior SRE designing a Prometheus monitoring dashboard.${researchSection}${metricsSection}

Generate a dashboard config. For each panel, choose the best visualization:
- time_series for trends over time (latency, throughput, etc.)
- stat for single important numbers (current error rate, uptime)
- gauge for percentages (CPU usage, memory usage, SLO budget)
- table for endpoint/service breakdown (top errors, top slow endpoints)
- bar for top/bottom categories (top 5 endpoints by latency)

Layout: use a 12-column grid.
Full-width time_series: width=12, height=2
Half-width charts: width=6, height=2

Reply with JSON:
{
  "title": "Dashboard Title",
  "description": "What this dashboard monitors",
  "panels": [
    {
      "title": "Panel Title",
      "description": "What this shows",
      "query": "valid promQL expression",
      "visualization": "time_series",
      "unit": "seconds",
      "row": 0, "col": 0, "width": 12, "height": 2,
      "refreshIntervalSec": 30
    }
  ]
}

Only return the JSON object.`,
      },
      { role: 'user', content: prompt },
    ];

    const resp = await gateway.complete(messages, { model, maxTokens: 4096, temperature: 0.2 });
    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const validVisualizations = new Set(['time_series', 'stat', 'gauge', 'table', 'bar', 'heatmap', 'pie', 'histogram', 'status_timeline']);
    const panels = (parsed.panels ?? []).map((p) => ({
      title: p.title ?? 'Panel',
      description: p.description ?? '',
      query: p.query ?? '',
      visualization: validVisualizations.has(p.visualization) ? p.visualization : 'time_series',
      unit: p.unit,
      row: p.row ?? 0,
      col: p.col ?? 0,
      width: p.width ?? 12,
      height: p.height ?? 2,
      refreshIntervalSec: p.refreshIntervalSec ?? 30,
    }));

    return {
      title: parsed.title ?? 'Dashboard',
      description: parsed.description ?? '',
      panels,
    };
  }

  // Validate PromQL queries
  async validatePanels(panels, prometheusUrl) {
    if (!prometheusUrl) {
      return panels.map((p) => ({ ...p, id: randomUUID() }));
    }

    return Promise.all(panels.map(async (p) => {
      const id = randomUUID();
      const query = p.query;
      if (!query) {
        return { ...p, id };
      }

      try {
        const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}&time=${Math.floor(Date.now() / 1000)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = await res.json();
          if (body.status === 'error') {
            return {
              ...p,
              id,
              description: `${p.description} (Query validation warning: ${body.error ?? 'unknown error'})`,
            };
          }
        }
      }
      catch {
        // best-effort - don't block on validation failures
      }

      return { ...p, id };
    }));
  }

  createGateway(llmConfig) {
    const provider = new AnthropicProvider({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      authType: llmConfig.authType ?? 'bearer',
      tokenHelperCommand: llmConfig.tokenHelperCommand,
    });
    return new LLMGateway({ primary: provider, maxRetries: 2 });
  }
}
//# sourceMappingURL=generator.js.map
