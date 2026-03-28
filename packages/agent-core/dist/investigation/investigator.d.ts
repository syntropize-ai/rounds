import type { DataAdapter } from '@agentic-obs/adapters';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { CaseRetriever } from '../case-library/types.js';
import type { InvestigationInput, InvestigationOutput, InvestigationConfig } from './types.js';

export interface InvestigationAgentDeps {
    adapter?: DataAdapter;
    config?: InvestigationConfig;
    /** Optional LLM gateway for hypothesis synthesis. When omitted, falls back to rule-based. */
    llm?: LLMGateway;
    /** Optional case retriever - when provided, similar past cases are injected into the LLM hypothesis prompt. */
    caseRetriever?: CaseRetriever;
    /** Toggle case-library injection. Defaults to true. Set to false to skip case retrieval entirely. */
    useCaseLibrary?: boolean;
}

export declare class InvestigationAgent implements Agent<InvestigationInput, InvestigationOutput> {
    readonly name = "investigation";
    private readonly adapter?;
    private readonly config;
    private readonly llm?;
    private readonly caseRetriever?;
    private readonly useCaseLibrary;
    constructor(deps?: InvestigationAgentDeps);
    run(input: InvestigationInput, agentCtx: AgentContext): Promise<AgentResult<InvestigationOutput>>;
    private investigate;
}
//# sourceMappingURL=investigator.d.ts.map
