import { randomUUID } from 'node:crypto';
import {
  type Hypothesis,
  LLMUnavailableError,
  type LLMGateway,
} from '@agentic-obs/common';
import type { ScoredCase } from '../case-library/types.js';
import type { StepFinding } from './types.js';

/**
 * Hypothesis generation from investigation findings.
 *
 * Templates are used ONLY as hint sources for the LLM prompt.
 * They do NOT generate hypotheses directly - the LLM does that.
 */

interface HypothesisTemplate {
  matches: (findings: StepFinding[]) => boolean;
  hint: (findings: StepFinding[]) => string;
}

const HYPOTHESIS_TEMPLATES: HypothesisTemplate[] = [
  {
    matches: (f) =>
      f.some((x) => x.stepType === 'correlate_deployments' && x.isAnomaly) &&
      f.some((x) => x.stepType === 'compare_latency_vs_baseline' && x.isAnomaly),
    hint: (f) => {
      const latency = f.find((x) => x.stepType === 'compare_latency_vs_baseline' && x.isAnomaly);
      return `A recent deployment may have caused a latency regression (deviation: ${((latency?.deviationRatio ?? 0) * 100).toFixed(0)}%)`;
    },
  },
  {
    matches: (f) => f.some((x) => x.stepType === 'inspect_downstream' && x.isAnomaly),
    hint: () => 'A downstream dependency may be degraded, causing elevated latency',
  },
  {
    matches: (f) =>
      f.some((x) => x.stepType === 'check_error_rate' && x.isAnomaly) &&
      !f.some((x) => x.stepType === 'correlate_deployments' && x.isAnomaly),
    hint: () =>
      'Error rate is elevated without a recent deployment - possible external dependency failure or transient issue.',
  },
  {
    matches: (f) =>
      f.some((x) => x.stepType === 'compare_latency_vs_baseline' && x.isAnomaly) &&
      !f.some((x) => x.stepType === 'correlate_deployments' && x.isAnomaly) &&
      !f.some((x) => x.stepType === 'inspect_downstream' && x.isAnomaly),
    hint: () =>
      'Latency spike with no correlated deployment or downstream issue - possible resource saturation or unexpected traffic surge',
  },
  {
    matches: (f) => f.some((x) => x.stepType === 'check_saturation' && x.isAnomaly),
    hint: (f) => {
      const hasLatency = f.some(
        (x) => x.stepType === 'compare_latency_vs_baseline' && x.isAnomaly,
      );
      return hasLatency
        ? 'Resource saturation (CPU/memory) is likely causing the observed latency increase'
        : 'Resource saturation detected - may be approaching degradation thresholds';
    },
  },
  {
    matches: (f) => f.some((x) => x.stepType === 'check_traffic_pattern' && x.isAnomaly),
    hint: (f) => {
      const traffic = f.find((x) => x.stepType === 'check_traffic_pattern');
      const ratio = traffic?.deviationRatio ?? 0;
      return ratio > 0
        ? `Traffic surge (${((1 + ratio) * 100).toFixed(0)}% of baseline) may be overwhelming service capacity`
        : `Traffic drop (${Math.abs(ratio * 100).toFixed(0)}% off baseline) possible upstream failure or routing change`;
    },
  },
  {
    matches: (f) => f.some((x) => x.stepType === 'check_slo_burn_rate' && x.isAnomaly),
    hint: () =>
      'SLO error budget is burning at an unsustainable rate - root cause needs urgent identification',
  },
  {
    matches: (f) =>
      f.some((x) => x.stepType === 'check_error_distribution' && x.isAnomaly) &&
      f.some((x) => x.stepType === 'check_error_rate' && x.isAnomaly),
    hint: (f) => {
      const dist = f.find((x) => x.stepType === 'check_error_distribution');
      const isDownstream = dist?.summary.includes('downstream');
      return isDownstream
        ? 'Errors appear to originate from a downstream dependency and propagate upstream'
        : 'Errors appear to originate locally in the service itself, not from dependencies';
    },
  },
  {
    matches: (f) =>
      f.some((x) => x.stepType === 'correlate_deployments' && x.isAnomaly) &&
      f.some((x) => x.stepType === 'check_error_rate' && x.isAnomaly) &&
      !f.some((x) => x.stepType === 'compare_latency_vs_baseline' && x.isAnomaly),
    hint: () =>
      'A recent deployment introduced elevated errors without latency impact - possible logic bug or breaking API change',
  },
];

/**
 * Returns prompt hint strings from all matching templates.
 * Used to guide the LLM without constraining its reasoning.
 */
export function getMatchingHints(findings: StepFinding[]): string[] {
  return HYPOTHESIS_TEMPLATES.filter((t) => t.matches(findings)).map((t) => t.hint(findings));
}

interface LlmHypothesisEntry {
  description: string;
  confidence: number;
  confidenceBasis: string;
  category?: string;
}

function formatHistoricalCasesSection(cases: ScoredCase[]): string {
  if (!cases.length) return '';

  const lines: string[] = [
    'HISTORICAL CASES (similar past incidents for reference):',
    'These are similar past incidents for reference. Use your own reasoning - do not simply copy conclusions from past cases.',
    '',
  ];

  cases.forEach((sc, i) => {
    const r = sc.record;
    lines.push(`Case ${i + 1}: [${r.title}]`);
    if (r.symptoms.length > 0) lines.push(`- Symptoms: ${r.symptoms.join(', ')}`);
    lines.push(`- Root cause: ${r.rootCause}`);
    if (r.resolution) lines.push(`- Resolution: ${r.resolution}`);
    if (i < cases.length - 1) lines.push('');
  });

  return lines.join('\n');
}

/**
 * Calls the LLM with findings + hints, returns parsed Hypothesis[].
 * Throws on failure - caller should handle accordingly.
 */
export async function synthesizeHypotheses(
  llm: LLMGateway,
  investigationId: string,
  findings: StepFinding[],
  hints: string[],
  historicalCases: ScoredCase[] = [],
): Promise<Hypothesis[]> {
  const findingsText = findings
    .map(
      (f) =>
        `- [${f.stepType}] ${f.summary}${f.isAnomaly ? ' | anomaly' : ''}${f.value !== undefined ? ` | value=${f.value}` : ''}${f.deviationRatio !== undefined ? ` | deviation=${(f.deviationRatio * 100).toFixed(0)}%` : ''}`,
    )
    .join('\n');

  const hintsText =
    hints.length > 0
      ? hints.map((h, i) => `- Hint ${i + 1}: ${h}`).join('\n')
      : 'No rule-based directions matched - use your own analysis.';

  const casesSection = formatHistoricalCasesSection(historicalCases);

  const userMessage = `You are an expert SRE analyzing observability data to identify root causes.

OBSERVABILITY FINDINGS:
${findingsText}

INVESTIGATION DIRECTIONS (these are hints only - use your own reasoning and feel free to generate additional hypotheses):
${hintsText}

${casesSection ? `${casesSection}\n\n` : ''}Generate a JSON array of root cause hypotheses. For each hypothesis provide:
- "description": clear, specific hypothesis about the root cause
- "confidence": number from 0.0 to 1.0 reflecting the likelihood given the evidence
- "confidenceBasis": 1-2 sentences explaining your confidence assessment
- "category": one of "deployment", "resource", "dependency", "traffic", "config", "unknown"

Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.`;

  const response = await llm.complete(
    [
      { role: 'system', content: userMessage },
      { role: 'user', content: userMessage },
    ],
    { model: 'claude-sonnet-4-5', temperature: 0.2, maxTokens: 1024, responseFormat: 'json' },
  );

  const parsed = JSON.parse(
    response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim(),
  ) as LlmHypothesisEntry[];

  if (!Array.isArray(parsed)) {
    throw new Error('LLM response is not a JSON array');
  }

  return parsed.map((entry) => ({
    id: randomUUID(),
    investigationId,
    description: String(entry.description ?? ''),
    confidence: Math.max(0, Math.min(1, Number(entry.confidence ?? 0.5))),
    confidenceBasis: String(entry.confidenceBasis ?? ''),
    evidenceIds: [],
    counterEvidenceIds: [],
    status: 'proposed' as const,
  }));
}

/**
 * Generates hypotheses from investigation findings.
 *
 * Requires an LLMGateway - without it, returns an empty array so callers
 * that use this for early-stop checks degrade safely without crashing.
 *
 * When no anomalies are found, skips the LLM call and returns empty array.
 *
 * On LLM failure or unparseable response, throws LLMUnavailableError.
 *
 * @param historicalCases - pre-fetched similar cases to inject as LLM context (optional)
 */
export async function generateHypotheses(
  investigationId: string,
  findings: StepFinding[],
  llm?: LLMGateway,
  historicalCases: ScoredCase[] = [],
): Promise<Hypothesis[]> {
  if (!llm) {
    return [];
  }

  const anomalous = findings.filter((f) => f.isAnomaly);
  if (anomalous.length === 0) {
    return [];
  }

  const hints = getMatchingHints(findings);
  try {
    const hypotheses = await synthesizeHypotheses(
      llm,
      investigationId,
      findings,
      hints,
      historicalCases,
    );
    hypotheses.sort((a, b) => b.confidence - a.confidence);
    return hypotheses;
  } catch (err) {
    throw new LLMUnavailableError(
      err instanceof Error ? err.message : 'LLM hypothesis synthesis failed',
    );
  }
}
