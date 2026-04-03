import type { PolicyRule, GuardDecision } from './types.js';
export interface ActionInput {
    type: string;
    targetService?: string;
    env?: string;
    params?: Record<string, unknown>;
}
export declare class ActionGuard {
    private readonly rules;
    constructor(rules: PolicyRule[]);
    evaluate(action: ActionInput): GuardDecision;
    private matchesRule;
    private checkConditions;
    private parseTime;
}
//# sourceMappingURL=action-guard.d.ts.map