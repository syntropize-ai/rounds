import type { StructuredIntent, Hypothesis, Evidence, InvestigationStatus } from '@agentic-obs/common';
import type { SystemContext } from '../context/types.js';
import type { InvestigationOutput } from '../investigation/types.js';
import type { EvidenceOutput } from '../evidence/types.js';
/** The valid states an orchestrator run can be in. */
export type OrchestratorState = Extract<InvestigationStatus, 'planning' | 'investigating' | 'evidencing' | 'explaining' | 'acting' | 'verifying' | 'completed' | 'failed'>;
export interface StateTransitionEvent {
    type: 'state_transition';
    from: OrchestratorState;
    to: OrchestratorState;
    investigationId: string;
    timestampMs: number;
}
export interface StepCompleteEvent {
    type: 'step_complete';
    state: OrchestratorState;
    investigationId: string;
    durationMs: number;
    degraded: boolean;
}
export interface DegradedEvent {
    type: 'degraded';
    state: OrchestratorState;
    investigationId: string;
    reason: string;
    coveredBy: string[];
    uncovered: string[];
}
export interface ErrorEvent {
    type: 'error';
    state: OrchestratorState;
    investigationId: string;
    error: string;
    fatal: boolean;
}
export type OrchestratorEvent = StateTransitionEvent | StepCompleteEvent | DegradedEvent | ErrorEvent;
export interface OrchestratorInput {
    /** Natural-language message from the user. */
    message: string;
    sessionId?: string;
    tenantId: string;
    userId: string;
}
export interface OrchestratorOutput {
    investigationId: string;
    sessionId?: string;
    state: OrchestratorState;
    intent: StructuredIntent | null;
    context: SystemContext | null;
    hypotheses: Hypothesis[];
    evidence: Evidence[];
    explanation: ExplanationResult | null;
    /** Summary of what was covered / not covered due to degradation */
    coverage: CoverageReport;
    startedAt: string;
    completedAt: string;
    durationMs: number;
}
export interface ExplanationResult {
    summary: string;
    rootCause: string | null;
    confidence: number;
    recommendedActions: string[];
}
export interface CoverageReport {
    covered: string[];
    uncovered: string[];
    degradedSteps: string[];
}
export interface OrchestratorConfig {
    /** Max wall-clock time for a full orchestrator run (ms). Default: 120_000 */
    totalTimeoutMs: number;
    /** Per-step timeout (ms). Default: 30_000 */
    stepTimeoutMs: number;
    /** If true, continue on non-fatal errors instead of aborting. Default: true */
    degradeOnError: boolean;
}
export declare const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig;
export type { InvestigationOutput, EvidenceOutput };
//# sourceMappingURL=types.d.ts.map