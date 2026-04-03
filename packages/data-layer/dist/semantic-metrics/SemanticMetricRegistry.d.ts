import type { SemanticMetric, ResolvedQuery, ResolveQueryParams } from './types.js';
export declare class SemanticMetricRegistry {
    private metrics;
    constructor();
    create(params: Omit<SemanticMetric, 'id' | 'createdAt' | 'updatedAt'>): SemanticMetric;
    get(id: string): SemanticMetric | undefined;
    getByName(name: string): SemanticMetric | undefined;
    list(): SemanticMetric[];
    update(id: string, patch: Partial<Omit<SemanticMetric, 'id' | 'createdAt'>>): SemanticMetric;
    delete(id: string): boolean;
    resolveQuery(params: ResolveQueryParams): ResolvedQuery;
    private matchesPattern;
    private loadDefaults;
}
//# sourceMappingURL=SemanticMetricRegistry.d.ts.map