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
}
