import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { CaseRecord, CaseRetriever, ICaseStore } from './types.js';
import type { InvestigationOutput } from '../investigation/types.js';
import type { StructuredConclusion } from '../explanation/types.js';
export interface InvestigationFeedback {
    adopted: boolean;
    comment?: string;
    rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
}
export interface CaseWriterConfig {
    llm: LLMGateway;
    caseStore: ICaseStore;
    retriever: CaseRetriever;
    model?: string;
    temperature?: number;
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
    extractCase(investigation: InvestigationOutput, conclusion: StructuredConclusion, feedback: InvestigationFeedback): Promise<CaseRecord | null>;
    private extractViaLLM;
    private buildExtractionPrompt;
    private parseExtraction;
}
//# sourceMappingURL=case-writer.d.ts.map