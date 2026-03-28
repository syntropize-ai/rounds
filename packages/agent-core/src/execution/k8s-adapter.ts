/**
 * K8s Execution Adapter
 *
 * Implements ExecutionAdapter for Kubernetes operations:
 *   - k8s:scale
 *   - k8s:restart
 *   - k8s:rollback
 */

import { randomUUID } from 'crypto';
import type {
  ExecutionAdapter,
  AdapterAction,
  ValidationResult,
  ExecutionResult,
  DryRunResult,
} from './types.js';

export interface KubeClient {
  getDeployment(namespace: string, name: string): Promise<DeploymentInfo>;
  scaleDeployment(namespace: string, name: string, replicas: number): Promise<void>;
  restartDeployment(namespace: string, name: string): Promise<void>;
  rollbackDeployment(namespace: string, name: string, toRevision?: number): Promise<void>;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  revision: number;
  image?: string;
}

export type K8sCapability = 'k8s:scale' | 'k8s:restart' | 'k8s:rollback';

interface ScaleParams {
  namespace: string;
  deployment: string;
  replicas: number;
}

interface RestartParams {
  namespace: string;
  deployment: string;
}

interface RollbackParams {
  namespace: string;
  deployment: string;
  toRevision?: number;
}

interface ExecutionSnapshot {
  action: AdapterAction;
  preState: DeploymentInfo;
}

type StoredSnapshot = ExecutionSnapshot & { storedAt: number };

const SNAPSHOT_MAX_SIZE = 1000;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

export class K8sExecutionAdapter implements ExecutionAdapter {
  /** In-memory store of pre-execution snapshots keyed by executionId */
  private readonly snapshots = new Map<string, StoredSnapshot>();

  constructor(private readonly client: KubeClient) {}

  private pruneSnapshots(): void {
    const now = Date.now();
    for (const [id, entry] of this.snapshots) {
      if (now - entry.storedAt > SNAPSHOT_TTL_MS) {
        this.snapshots.delete(id);
      }
    }

    if (this.snapshots.size >= SNAPSHOT_MAX_SIZE) {
      const sorted = [...this.snapshots.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
      const excess = this.snapshots.size - SNAPSHOT_MAX_SIZE + 1;
      for (let i = 0; i < excess; i++) {
        this.snapshots.delete(sorted[i]![0]);
      }
    }
  }

  capabilities(): K8sCapability[] {
    return ['k8s:scale', 'k8s:restart', 'k8s:rollback'];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    const p = action.params as Record<string, unknown>;

    if (!p['namespace'] || typeof p['namespace'] !== 'string') {
      return { valid: false, reason: 'params.namespace must be a non-empty string' };
    }
    if (!p['deployment'] || typeof p['deployment'] !== 'string') {
      return { valid: false, reason: 'params.deployment must be a non-empty string' };
    }
    if (action.type === 'k8s:scale') {
      if (typeof p['replicas'] !== 'number' || p['replicas'] < 0 || !Number.isInteger(p['replicas'])) {
        return { valid: false, reason: 'params.replicas must be a non-negative integer' };
      }
    }
    if (action.type === 'k8s:rollback' && p['toRevision'] !== undefined) {
      if (typeof p['toRevision'] !== 'number' || p['toRevision'] < 0 || !Number.isInteger(p['toRevision'])) {
        return { valid: false, reason: 'params.toRevision must be a non-negative integer when provided' };
      }
    }

    const supported: string[] = this.capabilities();
    if (!supported.includes(action.type)) {
      return { valid: false, reason: `unsupported action type "${action.type}"` };
    }

    return { valid: true };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const p = action.params as Record<string, unknown>;
    const namespace = p['namespace'] as string;
    const deployment = p['deployment'] as string;
    const current = await this.client.getDeployment(namespace, deployment);

    switch (action.type) {
      case 'k8s:scale': {
        const targetReplicas = p['replicas'] as number;
        const delta = targetReplicas - current.replicas;
        return {
          estimatedImpact: `Scale ${deployment} from ${current.replicas} to ${targetReplicas} replicas (${delta >= 0 ? '+' : ''}${delta})`,
          warnings: targetReplicas === 0 ? ['Scaling to 0 will take the deployment offline'] : [],
          willAffect: [`${namespace}/${deployment}`],
        };
      }
      case 'k8s:restart':
        return {
          estimatedImpact: `Rolling restart of ${deployment} (${current.readyReplicas} pods will be cycled)`,
          warnings: current.readyReplicas < current.replicas
            ? [`${deployment} is already partially degraded (${current.readyReplicas}/${current.replicas} ready)`]
            : [],
          willAffect: [`${namespace}/${deployment}`],
        };
      case 'k8s:rollback': {
        const toRevision = p['toRevision'] as number | undefined;
        const target = toRevision !== undefined ? `revision ${toRevision}` : 'previous revision';
        return {
          estimatedImpact: `Rollback ${deployment} from revision ${current.revision} to ${target}`,
          warnings: ['All pods will be restarted during rollback'],
          willAffect: [`${namespace}/${deployment}`],
        };
      }
      default:
        return {
          estimatedImpact: `Unknown action type ${action.type}`,
          warnings: [`action type '${action.type}' is not handled by K8sExecutionAdapter`],
          willAffect: [],
        };
    }
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const p = action.params as Record<string, unknown>;
    const namespace = p['namespace'] as string;
    const deployment = p['deployment'] as string;
    const executionId = randomUUID();

    this.pruneSnapshots();
    const preState = await this.client.getDeployment(namespace, deployment);
    this.snapshots.set(executionId, { action, preState, storedAt: Date.now() });

    try {
      switch (action.type) {
        case 'k8s:scale': {
          const replicas = p['replicas'] as number;
          await this.client.scaleDeployment(namespace, deployment, replicas);
          return {
            success: true,
            output: { namespace, deployment, scaledTo: replicas, previousReplicas: preState.replicas },
            rollbackable: true,
            executionId,
          };
        }
        case 'k8s:restart':
          await this.client.restartDeployment(namespace, deployment);
          return {
            success: true,
            output: { namespace, deployment, previousRevision: preState.revision },
            rollbackable: false,
            executionId,
          };
        case 'k8s:rollback': {
          const toRevision = p['toRevision'] as number | undefined;
          await this.client.rollbackDeployment(namespace, deployment, toRevision);
          return {
            success: true,
            output: { namespace, deployment, rolledBackFrom: preState.revision, toRevision },
            rollbackable: true,
            executionId,
          };
        }
        default:
          return {
            success: false,
            output: null,
            rollbackable: false,
            executionId,
            error: `unsupported action type "${action.type}"`,
          };
      }
    } catch (err) {
      this.snapshots.delete(executionId);
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rollback(action: AdapterAction, executionId: string): Promise<ExecutionResult> {
    const snapshot = this.snapshots.get(executionId);
    const p = action.params as Record<string, unknown>;
    const namespace = p['namespace'] as string;
    const deployment = p['deployment'] as string;
    const preState = snapshot?.preState;
    const rbId = `rb-${executionId}`;

    try {
      switch (action.type) {
        case 'k8s:scale': {
          const previousReplicas = preState?.replicas ?? 1;
          await this.client.scaleDeployment(namespace, deployment, previousReplicas);
          this.snapshots.delete(executionId);
          return {
            success: true,
            output: { namespace, deployment, restoredReplicas: previousReplicas },
            rollbackable: false,
            executionId: rbId,
          };
        }
        case 'k8s:rollback': {
          const previousRevision = preState?.revision;
          await this.client.rollbackDeployment(namespace, deployment, previousRevision);
          this.snapshots.delete(executionId);
          return {
            success: true,
            output: { namespace, deployment, restoredToRevision: previousRevision },
            rollbackable: false,
            executionId: rbId,
          };
        }
        default:
          return {
            success: false,
            output: null,
            rollbackable: false,
            executionId: rbId,
            error: `rollback not supported for action type "${action.type}"`,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId: rbId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
