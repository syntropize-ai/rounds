import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { PostMortemReport, PostMortemInput } from './post-mortem-types.js';

export declare class PostMortemGenerator {
    private readonly llm;
    constructor(config: {
        llm: LLMGateway;
    });
    /**
     * Generate a post-mortem report by prompting the LLM with all available
     * incident, investigation, execution, and verification data.
     *
     * Throws LLMUnavailableError if the LLM call fails or returns unparseable output.
     * Callers should surface AI unavailable - please retry to the user.
     */
    generate(input: PostMortemInput): Promise<PostMortemReport>;
    private buildPrompt;
    private parseResponse;
}
//# sourceMappingURL=post-mortem-generator.d.ts.map
