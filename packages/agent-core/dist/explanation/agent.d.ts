import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { ExplanationInput, StructuredConclusion } from './types.js';
export interface ExplanationAgentOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}
export declare class ExplanationAgent implements Agent<ExplanationInput, StructuredConclusion> {
    readonly name = "explanation";
    private readonly gateway;
    private readonly options;
    constructor(gateway: LLMGateway, options?: ExplanationAgentOptions);
    /**
     * Generate a StructuredConclusion from hypotheses and their evidence chains.
     * Does not modify any evidence content - only rephrases and ranks.
     */
    explain(input: ExplanationInput): Promise<StructuredConclusion>;
    /**
     * Like explain(), but returns null on LLM/parse errors rather than throwing.
     * Callers should surface "AI unavailable - please retry" to the user.
     */
    safeExplain(input: ExplanationInput): Promise<StructuredConclusion | null>;
    /** Agent interface - wraps explain() with AgentResult envelope. */
    run(input: ExplanationInput, _context: AgentContext): Promise<AgentResult<StructuredConclusion>>;
    private parseResponse;
}
//# sourceMappingURL=agent.d.ts.map
