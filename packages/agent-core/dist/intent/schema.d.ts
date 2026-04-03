import type { StructuredIntent } from '@agentic-obs/common';
export declare class IntentValidationError extends Error {
    constructor(message: string);
}
/**
 * Parse and validate raw LLM output into a StructuredIntent.
 * Throws IntentValidationError on failure.
 */
export declare function parseAndValidate(raw: string): StructuredIntent;
//# sourceMappingURL=schema.d.ts.map