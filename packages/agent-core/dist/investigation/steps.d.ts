/**
 * Step executors for the Investigation Agent.
 *
 * Each executor runs one investigation step and returns a StepFinding.
 * Steps try to query the DataAdapter if available; otherwise they derive
 * findings from the SystemContext alone (topology, changes, SLO status).
 */
import type { StructuredIntent } from '@agentic-obs/common';
import type { DataAdapter } from '@agentic-obs/adapters';
import type { SystemContext } from '../context/types.js';
import type { StepFinding, StepType } from './types.js';
export interface QueryBudget {
    count: number;
    max: number;
}
export interface StepExecutorContext {
    intent: StructuredIntent;
    context: SystemContext;
    adapter?: DataAdapter;
    queryBudget: QueryBudget;
}
export declare function getStepsForTaskType(taskType: StructuredIntent['taskType']): StepType[];
export declare function executeStep(stepType: StepType, ctx: StepExecutorContext): Promise<StepFinding>;
//# sourceMappingURL=steps.d.ts.map