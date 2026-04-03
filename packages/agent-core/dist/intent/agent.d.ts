import type { StructuredIntent } from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { IntentInput } from './types.js';
export interface IntentAgentOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}
export declare class IntentAgent {
    readonly name = "intent";
    private readonly gateway;
    private readonly options;
    constructor(gateway: LLMGateway, options?: IntentAgentOptions);
    /**
     * Parse a natural-language message into a StructuredIntent.
     * Throws on LLM failure or invalid response schema.
     */
    parse(input: IntentInput): Promise<StructuredIntent>;
    /**
     * Like parse(), but returns a fallback intent instead of throwing on error.
     * Useful when a degraded response is preferable to a hard failure.
     */
    safeParse(input: IntentInput): Promise<StructuredIntent | null>;
}
//# sourceMappingURL=agent.d.ts.map