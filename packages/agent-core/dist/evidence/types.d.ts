import type { Evidence, Hypothesis } from '@agentic-obs/common';
import type { StepFinding } from '../investigation/types.js';

/**
 * A query that can be re-executed to reproduce a piece of evidence.
 * All parameters needed to reconstruct the result are stored here.
 */
export interface ReplayableQuery {
    /** The raw query string (PromQL, LogQL, etc.) */
    query: string;
    queryLanguage: string;
    /** Name of the adapter that ran this query */
    adapterName: string;
    /** Parameters used when the query was executed */
    params: {
        entity: string;
        metric?: string;
        startTime: string;
        endTime: string;
        filters?: Record<string, string>;
    };
}

/**
 * A chain of evidence items bound to a single hypothesis.
 * Supporting evidence increases confidence; counter evidence decreases it.
 */
export interface EvidenceChain {
    hypothesisId: string;
    supportingEvidence: Evidence[];
    counterEvidence: Evidence[];
    /** Aggregate confidence adjustment based on the chain (-1 to +1) */
    confidenceDelta: number;
    /** Whether the chain has sufficient evidence to draw a conclusion */
    isConclusive: boolean;
}

export interface EvidenceInput {
    hypotheses: Hypothesis[];
    findings: StepFinding[];
    /** Investigation entity (e.g. service name) */
    entity: string;
    timeRange: {
        start: string;
        end: string;
    };
}

export interface EvidenceOutput {
    /** Updated hypotheses with evidenceIds/counterEvidenceIds and revised status */
    hypotheses: Hypothesis[];
    /** All created evidence items */
    evidence: Evidence[];
    /** Evidence chain per hypothesis */
    chains: EvidenceChain[];
}
//# sourceMappingURL=types.d.ts.map