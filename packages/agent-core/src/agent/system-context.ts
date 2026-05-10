/**
 * Shared generation principles injected into all agent prompts.
 * Single source of truth — changing this affects every agent.
 * NOT hardcoded rules — these are behavioral guidelines for the LLM.
 */
export const GENERATION_PRINCIPLES = `
## Generation Principles (apply to all tasks)

1. SCOPE: Only produce what was asked. Do not expand, supplement, or "complete" beyond the request.
2. GROUNDING: When metrics/data have been discovered from the connector, use ONLY those. Do not invent metrics that were not discovered. If a needed metric is missing, omit that part and state the gap.
3. KNOWLEDGE PRIORITY: Discovered data > existing context > research/best practices. Research tells you what to look for; discovery tells you what exists.
4. CONSERVATISM: When uncertain, prefer a narrower result grounded in real data over a comprehensive guessed result.
5. VISUALIZATION: Choose the simplest chart type that communicates the signal. Do not diversify for variety.
6. PANEL COUNT: Determined by what was asked + what data exists. No targets, no minimums.
`;

/**
 * Builds the grounding context from discovery results.
 * Tells the LLM exactly what exists and what to use.
 */
export function buildGroundingContext(opts: {
  discoveredMetrics?: string[];
  labelsByMetric?: Record<string, string[]>;
  sampleValues?: Record<string, { sampleLabels: Record<string, string>[] }>;
  metadataByMetric?: Record<string, { type: string; help: string; unit: string }>;
}): string {
  if (!opts.discoveredMetrics?.length) return '';

  const meta = opts.metadataByMetric ?? {};
  let ctx = '\n## Discovered Metrics (HARD CONSTRAINT — use ONLY these)\n';
  for (const name of opts.discoveredMetrics) {
    const m = meta[name];
    if (m && (m.type || m.help)) {
      ctx += `- ${name} (${m.type}${m.help ? `: ${m.help}` : ''})\n`;
    } else {
      ctx += `- ${name}\n`;
    }
  }
  ctx += '\nDo NOT use metrics not in this list. If you need a metric that is not here, omit that panel.\n';
  ctx += 'Use the metric TYPE to choose correct PromQL: rate() for counters, direct value for gauges, histogram_quantile() with by(le) for histograms.\n';

  if (opts.labelsByMetric && Object.keys(opts.labelsByMetric).length > 0) {
    ctx += '\n## Discovered Label Keys (available dimensions for grouping/filtering)\n';
    for (const [metric, labels] of Object.entries(opts.labelsByMetric).slice(0, 20)) {
      ctx += `- ${metric} has labels: ${labels.join(', ')}\n`;
    }
  }

  if (opts.sampleValues) {
    const samples = Object.entries(opts.sampleValues)
      .filter(([, v]) => v.sampleLabels.length > 0)
      .slice(0, 10);
    if (samples.length > 0) {
      ctx += '\n## Actual Label Values (use ONLY these values in label matchers)\n';
      for (const [metric, v] of samples) {
        for (const example of v.sampleLabels.slice(0, 2)) {
          ctx += `- ${metric}: ${Object.entries(example).map(([k, val]) => `${k}="${val}"`).join(', ')}\n`;
        }
      }
      ctx += '\nDo NOT guess label values. Use ONLY values shown above.\n';
    }
  }

  return ctx;
}
