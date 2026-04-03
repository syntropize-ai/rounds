// EvidenceAgent - binds investigation step findings to hypotheses as evidence chains

import { createLogger } from '@agentic-obs/common';
import type { Evidence, Hypothesis } from '@agentic-obs/common';

const log = createLogger('evidence-agent');
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { EvidenceInput, EvidenceOutput, EvidenceChain } from './types.js';
import { bindFindingsToHypothesis, clampConfidence, deriveStatus } from './binder.js';
import { EvidenceStore } from './store.js';
import { evidenceOutputSchema } from './schema.js';

export class EvidenceAgent implements Agent<EvidenceInput, EvidenceOutput> {
  readonly name = 'evidence';
  private readonly store: EvidenceStore;

  constructor(store?: EvidenceStore) {
    this.store = store ?? new EvidenceStore();
  }

  async run(input: EvidenceInput, _context: AgentContext): Promise<AgentResult<EvidenceOutput>> {
    try {
      const output = this.bind(input);
      this.store.addAll(output.evidence);
      const validation = evidenceOutputSchema.safeParse(output);
      if (!validation.success) {
        log.warn({ validationError: validation.error.format() }, 'output schema validation failed');
      }
      return { success: true, data: output };
    } catch (err) {
      return {
        success: false,
        error: `EvidenceAgent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  bind(input: EvidenceInput): EvidenceOutput {
    const timestamp = new Date().toISOString();
    const allEvidence: Evidence[] = [];
    const chains: EvidenceChain[] = [];
    const updatedHypotheses: Hypothesis[] = [];

    for (const hypothesis of input.hypotheses) {
      const bound = bindFindingsToHypothesis(hypothesis, input.findings, timestamp);

      const supportingEvidence: Evidence[] = [];
      const counterEvidence: Evidence[] = [];
      let cumulativeDelta = 0;

      for (const b of bound) {
        allEvidence.push(b.evidence);
        cumulativeDelta += b.confidenceDelta;
        if (b.isSupporting) supportingEvidence.push(b.evidence);
        else counterEvidence.push(b.evidence);
      }

      const newConfidence = clampConfidence(hypothesis.confidence + cumulativeDelta);
      const newStatus = deriveStatus(newConfidence, supportingEvidence.length, counterEvidence.length);

      const updatedHypothesis: Hypothesis = {
        ...hypothesis,
        confidence: newConfidence,
        status: newStatus,
        evidenceIds: [
          ...hypothesis.evidenceIds,
          ...supportingEvidence.map((e) => e.id),
        ],
        counterEvidenceIds: [
          ...hypothesis.counterEvidenceIds,
          ...counterEvidence.map((e) => e.id),
        ],
        confidenceBasis: this.buildConfidenceBasis(hypothesis, supportingEvidence, counterEvidence),
      };

      updatedHypotheses.push(updatedHypothesis);

      const chain: EvidenceChain = {
        hypothesisId: hypothesis.id,
        supportingEvidence,
        counterEvidence,
        confidenceDelta: cumulativeDelta,
        isConclusive: newStatus === 'supported' || newStatus === 'refuted',
      };
      chains.push(chain);
    }

    return {
      hypotheses: updatedHypotheses,
      evidence: allEvidence,
      chains,
    };
  }

  getEvidenceForHypothesis(hypothesisId: string): Evidence[] {
    return this.store.getByHypothesis(hypothesisId);
  }

  getEvidenceByIds(ids: string[]): Evidence[] {
    return this.store.getByIds(ids);
  }

  private buildConfidenceBasis(hypothesis: Hypothesis, supporting: Evidence[], counter: Evidence[]): string {
    if (supporting.length === 0 && counter.length === 0) {
      return hypothesis.confidenceBasis || 'No evidence collected yet';
    }

    const parts: string[] = [];
    if (supporting.length > 0) {
      parts.push(`${supporting.length} supporting signal(s): ${supporting.map((e) => e.summary).slice(0, 2).join('; ')}`);
    }
    if (counter.length > 0) {
      parts.push(`${counter.length} counter signal(s): ${counter.map((e) => e.summary).slice(0, 1).join('; ')}`);
    }

    return parts.join(' | ');
  }
}
