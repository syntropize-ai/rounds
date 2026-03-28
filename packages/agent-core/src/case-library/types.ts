// Case Library - domain types
//
// LLM-first principle: cases are reference context injected into prompts,
// never a direct case-conclusion mapping. The LLM always reasons independently.

export interface CaseRecord {
  id: string;
  title: string;
  /** Short symptom descriptions (e.g. "p95 latency spiked", "error rate 5%") */
  symptoms: string[];
  rootCause: string;
  resolution: string;
  /** Service identifiers this case is associated with */
  services: string[];
  tags: string[];
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** "manual" = engineer-curated; "auto" = derived from resolved investigation */
  source: 'manual' | 'auto';
  /** IDs of evidence items (metrics, logs, traces) that supported this case */
  evidenceRefs?: string[];
  /** Remediation actions taken during resolution */
  actions?: string[];
  /** Outcome of the resolution attempt */
  outcome?: {
    result: 'success' | 'partial' | 'failed';
    verification?: string;
  };
}

export interface CaseQuery {
  /** Symptoms descriptions from the current investigation */
  symptoms?: string[];
  /** Service identifiers under investigation */
  services?: string[];
  /** Optional tag filter hints */
  tags?: string[];
  /** Free-form keyword hints (merged with symptom tokens when present) */
  keywords?: string[];
  /** Maximum results to return (default: 3) */
  topK?: number;
}

export interface ScoredCase {
  record: CaseRecord;
  /** Combined weighted similarity score in [0, 1] */
  score: number;
}

export interface CaseRetriever {
  search(query: CaseQuery): ScoredCase[];
}

export interface ICaseStore {
  add(record: Omit<CaseRecord, 'id' | 'createdAt'>): CaseRecord;
  get(id: string): CaseRecord | undefined;
  list(): CaseRecord[];
  update(id: string, patch: Partial<Omit<CaseRecord, 'id' | 'createdAt'>>): CaseRecord | undefined;
  remove(id: string): boolean;
  clear(): void;
  readonly size: number;
}
