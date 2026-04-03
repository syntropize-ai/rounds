export interface PolicyRule {
    id: string;
    match: {
        actionType?: string;
        targetService?: string;
        env?: string;
    };
    effect: 'allow' | 'deny' | 'require_approval';
    conditions?: {
        maxReplicas?: number;
        allowedNamespaces?: string[];
        timeWindow?: {
            start: string;
            end: string;
        };
    };
    description?: string;
}
export interface GuardDecision {
    effect: 'allow' | 'deny' | 'require_approval';
    matchedRule?: PolicyRule;
    reason: string;
}
//# sourceMappingURL=types.d.ts.map