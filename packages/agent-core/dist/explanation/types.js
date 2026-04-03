// Explanation Agent types - structured conclusions for SRE investigations
// -- Validation error -----------------------------------------------------
export class ExplanationParseError extends Error {
    rawContent;
    constructor(message, rawContent) {
        super(message);
        this.rawContent = rawContent;
        this.name = 'ExplanationParseError';
    }
}
//# sourceMappingURL=types.js.map