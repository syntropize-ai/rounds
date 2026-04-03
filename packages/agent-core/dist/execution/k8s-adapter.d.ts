/**
 * K8s Execution Adapter
 *
 * Implements ExecutionAdapter for Kubernetes operations:
 *   - k8s:scale
 *   - k8s:restart
 *   - k8s:rollback
 */
import type { ExecutionAdapter, AdapterAction, ValidationResult, ExecutionResult, DryRunResult } from './types.js';
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
export declare class K8sExecutionAdapter implements ExecutionAdapter {
    private readonly client;
    /** In-memory store of pre-execution snapshots keyed by executionId */
    private readonly snapshots;
    constructor(client: KubeClient);
    private pruneSnapshots;
    capabilities(): K8sCapability[];
    validate(action: AdapterAction): Promise<ValidationResult>;
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    execute(action: AdapterAction): Promise<ExecutionResult>;
    rollback(action: AdapterAction, executionId: string): Promise<ExecutionResult>;
}
//# sourceMappingURL=k8s-adapter.d.ts.map