import { type Hypothesis } from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ScoredCase } from '../case-library/types.js';
import type { StepFinding } from './types.js';
/**
 * Returns prompt hint strings from all matching templates.
 * Used to guide the LLM without constraining its reasoning.
 */
export declare function getMatchingHints(findings: StepFinding[]): string[];
/**
 * Calls the LLM with findings + hints, returns parsed Hypothesis[].
 * Throws on failure - caller should handle accordingly.
 */
export declare function synthesizeHypotheses(llm: LLMGateway, investigationId: string, findings: StepFinding[], hints: string[], historicalCases?: ScoredCase[]): Promise<Hypothesis[]>;
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
export declare function generateHypotheses(investigationId: string, findings: StepFinding[], llm?: LLMGateway, historicalCases?: ScoredCase[]): Promise<Hypothesis[]>;
//# sourceMappingURL=hypotheses.d.ts.map