import type { SemanticQuery } from '@agentic-obs/adapters';
import type { QueryGuardConfig, QueryValidationResult } from './types.js';
export declare class QueryValidator {
    private readonly maxTimeWindowMs;
    private readonly maxCardinalityEstimate;
    constructor(config?: QueryGuardConfig);
    validate(query: SemanticQuery): QueryValidationResult;
}
//# sourceMappingURL=validator.d.ts.map