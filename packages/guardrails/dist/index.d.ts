export interface GuardContext {
    tenantId: string;
    userId: string;
    environment: string;
    serviceId?: string;
}
export type GuardDecision = 'allow' | 'deny' | 'require_approval';
export interface GuardResult {
    decision: GuardDecision;
    reason?: string;
    riskLevel?: 'low' | 'medium' | 'high';
}
export interface Guard {
    name: string;
    check(input: unknown, context: GuardContext): Promise<GuardResult>;
}
export declare class GuardChain {
    private guards;
    add(guard: Guard): this;
    check(input: unknown, context: GuardContext): Promise<GuardResult>;
}
export * from './cost-guard/index.js';
export * from './query-guard/index.js';
export * from './confidence-guard/index.js';
export { ActionGuard } from './action-guard/index.js';
export type { PolicyRule, ActionInput } from './action-guard/index.js';
export type { GuardDecision as ActionGuardDecision } from './action-guard/index.js';
export * from './credential/index.js';
//# sourceMappingURL=index.d.ts.map