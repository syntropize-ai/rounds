import { QUERY_GUARD_DEFAULTS } from './types.js';
/**
 * Estimate the number of distinct label-value combinations produced by the
 * array-valued filters in a query. Scalar filters select a single value and
 * do not multiply cardinality.
 */
function estimateCardinality(filters) {
    let estimate = 1;
    for (const value of Object.values(filters)) {
        if (Array.isArray(value) && value.length > 1) {
            estimate *= value.length;
        }
    }
    return estimate;
}
export class QueryValidator {
    maxTimeWindowMs;
    maxCardinalityEstimate;
    constructor(config = {}) {
        this.maxTimeWindowMs = config.maxTimeWindowMs ?? QUERY_GUARD_DEFAULTS.maxTimeWindowMs;
        this.maxCardinalityEstimate =
            config.maxCardinalityEstimate ?? QUERY_GUARD_DEFAULTS.maxCardinalityEstimate;
    }
    validate(query) {
        const warnings = [];
        // Reject full-table scans (no entity specified)
        if (!query.entity || query.entity.trim() === '') {
            return {
                allowed: false,
                reason: 'Query must specify an entity; full table scans are not allowed',
                warnings,
            };
        }
        // Reject oversized time windows
        const windowMs = query.timeRange.end.getTime() - query.timeRange.start.getTime();
        if (windowMs > this.maxTimeWindowMs) {
            const maxDays = this.maxTimeWindowMs / (24 * 60 * 60 * 1000);
            return {
                allowed: false,
                reason: `Time window (${Math.round(windowMs / (24 * 60 * 60 * 1000))}d) exceeds the ${maxDays}d maximum`,
                warnings,
            };
        }
        // Warn on time windows larger than 1 day
        if (windowMs > 24 * 60 * 60 * 1000) {
            warnings.push(`Large time window: ${Math.round(windowMs / (60 * 60 * 1000))}h`);
        }
        // Reject cardinality explosion
        if (query.filters) {
            const cardinality = estimateCardinality(query.filters);
            if (cardinality > this.maxCardinalityEstimate) {
                return {
                    allowed: false,
                    reason: `Estimated filter cardinality (${cardinality}) exceeds maximum (${this.maxCardinalityEstimate})`,
                    warnings,
                };
            }
            if (cardinality > this.maxCardinalityEstimate * 0.5) {
                warnings.push(`High cardinality estimate: ${cardinality}`);
            }
        }
        return { allowed: true, warnings };
    }
}
//# sourceMappingURL=validator.js.map