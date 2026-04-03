export * from './intent/index.js';
export * from './context/index.js';
export * from './investigation/index.js';
export * from './evidence/index.js';
export * from './orchestrator/index.js';
export * from './explanation/index.js';
export * from './execution/index.js';
export * from './proactive/index.js';
export * from './case-library/index.js';
export * from './postmortem/index.js';
export * from './scheduled/index.js';
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