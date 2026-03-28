// Evidence Agent - types for evidence binding and evidence chains

import type { Evidence, Hypothesis } from '@agentic-obs/common';
import type { StepFinding } from '../investigation/types.js';

export interface ReplayableQuery {
  query: string;
  queryLanguage: string;
  adapterName: string;
  params: {
    entity: string;
    metric?: string;
    startTime: string;
    endTime: string;
    filters?: Record<string, string>;
  };
}

export interface EvidenceChain {
  hypothesisId: string;
  supportingEvidence: Evidence[];
  counterEvidence: Evidence[];
  confidenceDelta: number;
  isConclusive: boolean;
}

export interface EvidenceInput {
  hypotheses: Hypothesis[];
  findings: StepFinding[];
  entity: string;
  timeRange: { start: string; end: string };
}

export interface EvidenceOutput {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  chains: EvidenceChain[];
}
