export class LLMUnavailableError extends Error {
    constructor(message = 'LLM is unavailable after all retries') {
        super(message);
        this.name = 'LLMUnavailableError';
    }
}
//# sourceMappingURL=llm-unavailable.js.map