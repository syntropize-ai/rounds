export * from './intent/Index.js';
export * from './context/Index.js';
export * from './investigation/Index.js';
export * from './evidence/Index.js';
export * from './orchestrator/Index.js';
export * from './explanation/Index.js';
export * from './execution/Index.js';
export * from './proactive/index.js';
export * from './quality/index.js';
export * from './case-library/Index.js';
export * from './postmortem/index.js';
export * from './scheduled/Index.js';
export * from './alerting/index.js';
export type { Investigation, InvestigationPlan, InvestigationStatus } from '@agentic-obs/common';
export interface AgentContext {
    investigationId: string;
    tenantId: string;
    userId: string;
}
export interface AgentResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}
export interface Agent<TInput, TOutput> {
    name: string;
    run(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}
//# sourceMappingURL=index.d.ts.map
