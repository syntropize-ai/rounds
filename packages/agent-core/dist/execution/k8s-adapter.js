/**
 * K8s Execution Adapter
 *
 * Implements ExecutionAdapter for Kubernetes operations:
 *   - k8s:scale   - adjust deployment replica count
 *   - k8s:restart - rolling restart of a deployment
 *   - k8s:rollback - rollback to a prior revision (or the previous one)
 *
 * The adapter accepts a `KubeClient` dependency so it can be tested with mocks
 * without requiring the @kubernetes/client-node SDK at test time.
 *
 * This class contains ZERO decision logic.
 * It executes exactly what the caller requests - no heuristics, no policies.
 */
import { randomUUID } from 'crypto';
// — Adapter implementation ————————————————————————————————
const SNAPSHOT_MAX_SIZE = 1000;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000; // 30 minutes
export class K8sExecutionAdapter {
    client;
    /** In-memory store of pre-execution snapshots keyed by executionId */
    snapshots = new Map();
    constructor(client) {
        this.client = client;
    }
    pruneSnapshots() {
        const now = Date.now();
        for (const [id, entry] of this.snapshots) {
            if (now - entry.storedAt > SNAPSHOT_TTL_MS) {
                this.snapshots.delete(id);
            }
        }
        if (this.snapshots.size >= SNAPSHOT_MAX_SIZE) {
            const sorted = [...this.snapshots.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
            const excess = this.snapshots.size - SNAPSHOT_MAX_SIZE + 1; // +1 to make room for the incoming entry
            for (let i = 0; i < excess; i++) {
                this.snapshots.delete(sorted[i][0]);
            }
        }
    }
    // — capabilities ————————————————————————————————
    capabilities() {
        return ['k8s:scale', 'k8s:restart', 'k8s:rollback'];
    }
    // — validate ————————————————————————————————
    async validate(action) {
        const p = action.params;
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
        if (action.type === 'k8s:rollback') {
            if (p['toRevision'] !== undefined) {
                if (typeof p['toRevision'] !== 'number' || p['toRevision'] < 0 || !Number.isInteger(p['toRevision'])) {
                    return { valid: false, reason: 'params.toRevision must be a non-negative integer when provided' };
                }
            }
        }
        const supported = this.capabilities();
        if (!supported.includes(action.type)) {
            return { valid: false, reason: `unsupported action type "${action.type}"` };
        }
        return { valid: true };
    }
    // — dryRun ————————————————————————————————
    async dryRun(action) {
        const p = action.params;
        const namespace = p['namespace'];
        const deployment = p['deployment'];
        const current = await this.client.getDeployment(namespace, deployment);
        switch (action.type) {
            case 'k8s:scale': {
                const targetReplicas = p['replicas'];
                const delta = targetReplicas - current.replicas;
                return {
                    estimatedImpact: `Scale ${deployment} from ${current.replicas} to ${targetReplicas} replicas (${delta >= 0 ? '+' : ''}${delta})`,
                    warnings: targetReplicas === 0 ? ['Scaling to 0 will take the deployment offline'] : [],
                    willAffect: [`${namespace}/${deployment}`],
                };
            }
            case 'k8s:restart': {
                return {
                    estimatedImpact: `Rolling restart of ${deployment} (${current.readyReplicas} pods will be cycled)`,
                    warnings: current.readyReplicas < current.replicas
                        ? [`${deployment} is already partially degraded (${current.readyReplicas}/${current.replicas} ready)`]
                        : [],
                    willAffect: [`${namespace}/${deployment}`],
                };
            }
            case 'k8s:rollback': {
                const toRevision = p['toRevision'];
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
    // — execute ————————————————————————————————
    async execute(action) {
        const p = action.params;
        const namespace = p['namespace'];
        const deployment = p['deployment'];
        const executionId = randomUUID();
        // Capture pre-execution state for potential rollback
        this.pruneSnapshots();
        const preState = await this.client.getDeployment(namespace, deployment);
        this.snapshots.set(executionId, { action, preState, storedAt: Date.now() });
        try {
            switch (action.type) {
                case 'k8s:scale': {
                    const replicas = p['replicas'];
                    await this.client.scaleDeployment(namespace, deployment, replicas);
                    return {
                        success: true,
                        output: { namespace, deployment, scaledTo: replicas, previousReplicas: preState.replicas },
                        rollbackable: true,
                        executionId,
                    };
                }
                case 'k8s:restart': {
                    await this.client.restartDeployment(namespace, deployment);
                    return {
                        success: true,
                        output: { namespace, deployment, previousRevision: preState.revision },
                        rollbackable: false, // restart is not directly reversible
                        executionId,
                    };
                }
                case 'k8s:rollback': {
                    const toRevision = p['toRevision'];
                    await this.client.rollbackDeployment(namespace, deployment, toRevision);
                    return {
                        success: true,
                        output: { namespace, deployment, rolledBackFrom: preState.revision, toRevision },
                        rollbackable: true, // can re-rollback to the revision we came from
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
        }
        catch (err) {
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
    // — rollback ————————————————————————————————
    async rollback(action, executionId) {
        const snapshot = this.snapshots.get(executionId);
        const p = action.params;
        const namespace = p['namespace'];
        const deployment = p['deployment'];
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
        }
        catch (err) {
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
//# sourceMappingURL=k8s-adapter.js.map