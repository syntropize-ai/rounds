import type { Evidence } from '@agentic-obs/common';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { EvidenceInput, EvidenceOutput } from './types.js';
import { EvidenceStore } from './store.js';

export declare class EvidenceAgent implements Agent<EvidenceInput, EvidenceOutput> {
    readonly name = "evidence";
    private readonly store;
    constructor(store?: EvidenceStore);
    run(input: EvidenceInput, _context: AgentContext): Promise<AgentResult<EvidenceOutput>>;
    bind(input: EvidenceInput): EvidenceOutput;
    /**
     * Retrieve all stored evidence for a given hypothesis ID.
     * This supports auditing and re-verification of past investigations.
     */
    getEvidenceForHypothesis(hypothesisId: string): Evidence[];
    /**
     * Retrieve specific evidence items by ID for replay/auditing.
     */
    getEvidenceByIds(ids: string[]): Evidence[];
    private buildConfidenceBasis;
}
//# sourceMappingURL=agent.d.ts.map