// EvidenceAgent - binds investigation step findings to hypotheses as evidence chains
import { bindFindingsToHypothesis, clampConfidence, deriveStatus } from './binder.js';
import { EvidenceStore } from './store.js';
import { evidenceOutputSchema } from './schema.js';
export class EvidenceAgent {
    name = 'evidence';
    store;
    constructor(store) {
        this.store = store ?? new EvidenceStore();
    }
    async run(input, _context) {
        try {
            const output = this.bind(input);
            this.store.addAll(output.evidence);
            const validation = evidenceOutputSchema.safeParse(output);
            if (!validation.success) {
                console.warn('[EvidenceAgent] Output schema validation failed:', validation.error.format());
            }
            return { success: true, data: output };
        }
        catch (err) {
            return {
                success: false,
                error: `EvidenceAgent failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    bind(input) {
        const timestamp = new Date().toISOString();
        const allEvidence = [];
        const chains = [];
        const updatedHypotheses = [];
        for (const hypothesis of input.hypotheses) {
            const bound = bindFindingsToHypothesis(hypothesis, input.findings, timestamp);
            const supportingEvidence = [];
            const counterEvidence = [];
            let cumulativeDelta = 0;
            for (const b of bound) {
                allEvidence.push(b.evidence);
                cumulativeDelta += b.confidenceDelta;
                if (b.isSupporting)
                    supportingEvidence.push(b.evidence);
                else
                    counterEvidence.push(b.evidence);
            }
            const newConfidence = clampConfidence(hypothesis.confidence + cumulativeDelta);
            const newStatus = deriveStatus(newConfidence, supportingEvidence.length, counterEvidence.length);
            const updatedHypothesis = {
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
            const chain = {
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
    getEvidenceForHypothesis(hypothesisId) {
        return this.store.getByHypothesis(hypothesisId);
    }
    getEvidenceByIds(ids) {
        return this.store.getByIds(ids);
    }
    buildConfidenceBasis(hypothesis, supporting, counter) {
        if (supporting.length === 0 && counter.length === 0) {
            return hypothesis.confidenceBasis || 'No evidence collected yet';
        }
        const parts = [];
        if (supporting.length > 0) {
            parts.push(`${supporting.length} supporting signal(s): ${supporting.map((e) => e.summary).slice(0, 2).join('; ')}`);
        }
        if (counter.length > 0) {
            parts.push(`${counter.length} counter signal(s): ${counter.map((e) => e.summary).slice(0, 1).join('; ')}`);
        }
        return parts.join(' | ');
    }
}
//# sourceMappingURL=agent.js.map