import type { ExecutionAdapter, AdapterAction, AdapterCapability, ValidationResult, DryRunResult, ExecutionResult } from '@agentic-obs/agent-core';

export interface WorkflowRunResult {
    success: boolean;
    runId: string;
    statusCode: number;
    error?: string;
}

export interface WorkflowStatusResult {
    success: boolean;
    status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled';
    statusCode: number;
    error?: string;
}

export interface CICDClient {
    triggerWorkflow(repo: string, workflow: string, ref: string): Promise<WorkflowRunResult>;
    getStatus(runId: string): Promise<WorkflowStatusResult>;
}

export declare class StubCICDClient implements CICDClient {
    readonly triggerCalls: Array<{
        repo: string;
        workflow: string;
        ref: string;
    }>;
    readonly statusCalls: Array<{
        runId: string;
    }>;
    triggerWorkflow(repo: string, workflow: string, ref: string): Promise<WorkflowRunResult>;
    getStatus(runId: string): Promise<WorkflowStatusResult>;
}

export type CICDOperation = 'trigger_pipeline' | 'rollback_deploy';

export interface TriggerPipelineParams {
    /** Repository name, e.g. "org/repo" */
    repo: string;
    /** Workflow file name or ID, e.g. "deploy.yml" */
    workflow: string;
    /** Git ref to run against (branch, tag, commit SHA) */
    ref: string;
}

export interface RollbackDeployParams {
    /** Repository name */
    repo: string;
    /** Workflow to run for rollback */
    workflow: string;
    /** Git ref for the previous stable version */
    ref: string;
}

export declare class CICDAdapter implements ExecutionAdapter {
    private readonly client;
    constructor(client?: CICDClient);
    capabilities(): AdapterCapability[];
    validate(action: AdapterAction): Promise<ValidationResult>;
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    execute(action: AdapterAction): Promise<ExecutionResult>;
}