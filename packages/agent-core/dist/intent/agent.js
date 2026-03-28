import { INTENT_SYSTEM_PROMPT, buildPromptMessage } from './prompts.js';
import { parseAndValidate, IntentValidationError } from './schema.js';
const DEFAULT_OPTIONS = {
    model: 'gpt-4o-mini',
    temperature: 0,
    maxTokens: 512,
};
export class IntentAgent {
    name = 'intent';
    gateway;
    options;
    constructor(gateway, options = {}) {
        this.gateway = gateway;
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }
    /**
     * Parse a natural-language message into a StructuredIntent.
     * Throws on LLM failure or invalid response schema.
     */
    async parse(input) {
        const now = new Date().toISOString();
        const response = await this.gateway.complete([
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: buildPromptMessage(input.message, now) },
        ], {
            model: this.options.model,
            temperature: this.options.temperature,
            maxTokens: this.options.maxTokens,
            responseFormat: 'json',
        });
        return parseAndValidate(response.content);
    }
    /**
     * Like parse(), but returns a fallback intent instead of throwing on error.
     * Useful when a degraded response is preferable to a hard failure.
     */
    async safeParse(input) {
        try {
            return await this.parse(input);
        }
        catch (err) {
            if (err instanceof IntentValidationError) {
                return null;
            }
            throw err;
        }
    }
}
//# sourceMappingURL=agent.js.map
