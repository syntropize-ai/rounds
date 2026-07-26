export interface Evidence {
  id: string;
  hypothesisId: string;
  type: 'metric' | 'log' | 'trace' | 'event' | 'change' | 'log_cluster' | 'trace_waterfall';
  query: string;
  queryLanguage: string;
  result: unknown;
  summary: string;
  timestamp: string;
  reproducible: boolean;
}

/**
 * Citation reference id used inline in AI-generated markdown
 * (e.g. `[m1]`, `[l1]`, `[k1]`, `[c1]`). The leading letter encodes the
 * evidence kind so the UI can colour-code the chip without a dictionary
 * lookup; the trailing index disambiguates within a single report.
 */
export type CitationKind = 'metric' | 'log' | 'k8s' | 'change';

export interface Citation {
  /** `m1`, `l1`, `k1`, `c1`, … — the bracketed token in the markdown. */
  ref: string;
  kind: CitationKind;
  summary: string;
  /** Optional pointer back into the report's evidence sections (by index). */
  sectionIndex?: number;
}

/**
 * Provenance metadata for any AI-generated artifact (investigation report,
 * remediation plan, generated dashboard/alert). Read by the
 * `<ProvenanceHeader />` UI; every field is optional so the header degrades
 * gracefully when the producer didn't (or couldn't) populate it.
 */
export interface Provenance {
  /** LLM model identifier, e.g. `claude-opus-4-7`. */
  model?: string;
  /** Stable per-run id — currently the investigation/plan id. */
  runId?: string;
  /** Number of tool calls the agent made while producing the artifact. */
  toolCalls?: number;
  /** Number of evidence items / citations captured. */
  evidenceCount?: number;
  /** Aggregate cost in USD (from `llm_audit`). */
  costUsd?: number;
  /** End-to-end latency in milliseconds. */
  latencyMs?: number;
  /** Inline citations referenced from the artifact's markdown. */
  citations?: Citation[];
  /**
   * Product-agnostic evidence gate result for investigation root-cause claims.
   * A remediation plan may only be proposed when this gate passed on the
   * latest saved investigation report.
   */
  rootCauseGate?: {
    status: 'passed' | 'unresolved';
    reasons: string[];
    rootCause?: {
      status: 'confirmed' | 'likely' | 'unresolved';
      object?: string;
      field?: string;
      cause?: string;
      nextCheck?: string;
    };
    confidence: number;
    evidenceRefs: string[];
    ruledOut: string[];
    validationMethod?: string;
    evaluatedAt: string;
  };
}


/**
 * The confidence a root-cause claim must carry before the gate will call it
 * verified. Lives here rather than in the gate because the reason text below
 * embeds it, and the UI renders that text.
 */
export const MIN_ROOT_CAUSE_CONFIDENCE = 0.8;

/**
 * Translate gate reasons into something a reader who has never seen this
 * codebase can act on. The raw reasons name fields and thresholds because the
 * model consumes them as instructions; rendered verbatim in a report they read
 * as an internal rule dump ("referenced evidence must include at least two
 * independent signal types") next to a summary that confidently names a cause,
 * which looks like the report contradicting itself.
 *
 * Unmapped reasons pass through unchanged — a slightly technical sentence beats
 * dropping the explanation entirely.
 */
export function explainGateReasons(reasons: readonly string[]): string[] {
  return reasons.map((reason) => GATE_REASON_PLAIN[reason] ?? reason);
}

const GATE_REASON_PLAIN: Readonly<Record<string, string>> = {
  'referenced evidence must include at least two independent signal types from metrics, logs, Kubernetes state or change events':
    'every supporting check drew on the same kind of data — a second source, such as logs or Kubernetes state, would confirm it',
  'at least two recorded checks must be referenced':
    'only one check backs this conclusion, which is not enough to be sure',
  'at least one referenced supported check must directly support the root-cause object and cause':
    'no single check directly demonstrates the cause I suspect',
  'ruledOut must include plausible competing explanations':
    'I did not rule out other explanations for what you are seeing',
  'at least one competing explanation must be recorded as ruled_out':
    'I did not rule out other explanations for what you are seeing',
  'at least one referenced check must record scope.timeWindow or scope.affected':
    'the evidence does not pin down when this started or which parts are affected',
  'validationMethod must state how to validate the fix or next finding':
    'I could not state how you would confirm a fix actually worked',
  'rootCause.object must name the specific repair target':
    'I could not name the specific thing that needs changing',
  'rootCause.cause must describe the causal mechanism':
    'I could not explain the mechanism behind the failure',
  'evidenceRefs must point to recorded investigation checks':
    'the conclusion is not tied to any recorded check',
  'all evidenceRefs must match recorded check ids':
    'the conclusion cites checks that were not recorded',
  [`root-cause confidence must be at least ${MIN_ROOT_CAUSE_CONFIDENCE}`]:
    'I am not confident enough in this conclusion to call it the root cause',
};
