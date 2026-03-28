import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { CaseRecord, CaseRetriever, ICaseStore } from './types.js';
import type { InvestigationOutput } from '../investigation/types.js';
import type { StructuredConclusion } from '../explanation/types.js';

export interface InvestigationFeedback {
  /** Whether the operator adopted the recommended resolution */
  adopted: boolean;

  /** Optional free-text note from the operator */
  comment?: string;

  /** Explicit verdict on the root cause */
  rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
}

export interface CaseWriterConfig {
  llm: LLMGateway;
  caseStore: ICaseStore;
  retriever: CaseRetriever;
  model?: string;
  temperature?: number;
  /** Similarity score above which the case is considered a duplicate (default: 0.8) */
  dedupThreshold?: number;
}

export declare class CaseWriter {
  private readonly llm;
  private readonly caseStore;
  private readonly retriever;
  private readonly model;
  private readonly temperature;
  private readonly dedupThreshold;

  constructor(config: CaseWriterConfig);

  /**
   * Extracts a CaseRecord from a resolved investigation.
   *
   * Returns null when:
   * - feedback.adopted is false
   * - LLM fails to produce usable case data
   * - A near-duplicate case already exists (score > dedupThreshold)
   */
  extractCase(
    investigation: InvestigationOutput,
    conclusion: StructuredConclusion,
    feedback: InvestigationFeedback
  ): Promise<CaseRecord | null>;

  private extractViaLLM;
  private buildExtractionPrompt;
  private parseExtraction;
}