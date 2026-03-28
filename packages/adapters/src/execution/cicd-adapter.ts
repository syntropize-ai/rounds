// CICDAdapter - ExecutionAdapter for CI/CD pipeline operations

import { randomUUID } from 'crypto';
import type {
  ExecutionAdapter,
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
} from '@agentic-obs/agent-core';

// -- Client interface --

export interface WorkflowRunResult {
  success: boolean;
  runId: string;
  statusCode?: number;
  error?: string;
}

export interface WorkflowStatusResult {
  success: boolean;
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled';
  statusCode?: number;
  error?: string;
}

export interface CICDClient {
  triggerWorkflow(repo: string, workflow: string, ref: string): Promise<WorkflowRunResult>;
  getStatus(runId: string): Promise<WorkflowStatusResult>;
}

export class StubCICDClient implements CICDClient {
  readonly triggerCalls: Array<{ repo: string; workflow: string; ref: string }> = [];
  readonly statusCalls: Array<{ runId: string }> = [];

  async triggerWorkflow(repo: string, workflow: string, ref: string): Promise<WorkflowRunResult> {
    this.triggerCalls.push({ repo, workflow, ref });
    return { success: true, runId: `stub-run-${randomUUID()}`, statusCode: 201 };
  }

  async getStatus(runId: string): Promise<WorkflowStatusResult> {
    this.statusCalls.push({ runId });
    return { success: true, status: 'success', statusCode: 200 };
  }
}

// -- Param types --

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

const VALID_OPERATIONS: CICDOperation[] = ['trigger_pipeline', 'rollback_deploy'];

// -- Adapter --

export class CICDAdapter implements ExecutionAdapter {
  private readonly client: CICDClient;

  constructor(client: CICDClient = new StubCICDClient()) {
    this.client = client;
  }

  capabilities(): AdapterCapability[] {
    return [...VALID_OPERATIONS];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    if (!VALID_OPERATIONS.includes(action.type as CICDOperation)) {
      return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
    }

    const p = action.params as Record<string, unknown>;

    if (!p['repo'] || typeof p['repo'] !== 'string' || (p['repo'] as string).trim() === '') {
      return { valid: false, reason: '`repo` is required and must be a non-empty string' };
    }
    if (!p['workflow'] || typeof p['workflow'] !== 'string' || (p['workflow'] as string).trim() === '') {
      return { valid: false, reason: '`workflow` is required and must be a non-empty string' };
    }
    if (!p['ref'] || typeof p['ref'] !== 'string' || (p['ref'] as string).trim() === '') {
      return { valid: false, reason: '`ref` is required and must be a non-empty string' };
    }

    return { valid: true };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const op = action.type as CICDOperation;
    const p = action.params as Record<string, unknown>;

    const impactMap: Record<CICDOperation, string> = {
      trigger_pipeline: `Trigger workflow "${p['workflow']}" on repo "${p['repo']}" at ref "${p['ref']}"`,
      rollback_deploy: `Rollback deploy via workflow "${p['workflow']}" on repo "${p['repo']}" to ref "${p['ref']}"`,
    };

    const warnings: string[] =
      op === 'rollback_deploy'
        ? ['This will deploy a previous version and may cause a brief service interruption']
        : [];

    return {
      estimatedImpact: impactMap[op],
      warnings,
      willAffect: [String(p['repo'] ?? action.targetService)],
    };
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const op = action.type as CICDOperation;
    const p = action.params as TriggerPipelineParams | RollbackDeployParams;
    const executionId = randomUUID();

    try {
      const result = await this.client.triggerWorkflow(p.repo, p.workflow, p.ref);
      return {
        success: result.success,
        output: { runId: result.runId, statusCode: result.statusCode },
        rollbackable: false,
        executionId,
        error: result.error,
      };
    } catch (err) {
      return { success: false, output: null, rollbackable: false, executionId, error: String(err) };
    }
  }
}