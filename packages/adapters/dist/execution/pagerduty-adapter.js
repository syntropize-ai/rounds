// PagerDutyAdapter - ExecutionAdapter for PagerDuty incident management
import { randomUUID } from 'crypto';
import { HttpPagerDutyClient } from './pagerduty-client.js';

const VALID_OPERATIONS = ['create_incident', 'escalate', 'resolve', 'add_note'];
const VALID_SEVERITIES = ['critical', 'error', 'warning', 'info'];

// — Adapter ———————————————————————————————————————————————————————————————————
export class PagerDutyAdapter {
    client;
    constructor(client = new HttpPagerDutyClient()) {
        this.client = client;
    }
    capabilities() {
        return VALID_OPERATIONS;
    }
    async validate(action) {
        if (!VALID_OPERATIONS.includes(action.type)) {
            return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
        }
        const op = action.type;
        const p = action.params;
        if (op === 'create_incident') {
            if (!p['description'] || typeof p['description'] !== 'string' || p['description'].trim() === '') {
                return { valid: false, reason: "'description' is required for create_incident" };
            }
            if (!p['service'] || typeof p['service'] !== 'string' || p['service'].trim() === '') {
                return { valid: false, reason: "'service' is required for create_incident" };
            }
            if (!p['severity'] || !VALID_SEVERITIES.includes(p['severity'])) {
                return { valid: false, reason: `'severity' must be one of: ${VALID_SEVERITIES.join(', ')}` };
            }
        }
        if (op === 'escalate') {
            if (!p['dedupKey'] || typeof p['dedupKey'] !== 'string') {
                return { valid: false, reason: "'dedupKey' is required for escalate" };
            }
            if (!p['severity'] || !VALID_SEVERITIES.includes(p['severity'])) {
                return { valid: false, reason: `'severity' must be one of: ${VALID_SEVERITIES.join(', ')}` };
            }
            if (!p['description'] || typeof p['description'] !== 'string') {
                return { valid: false, reason: "'description' is required for escalate" };
            }
        }
        if (op === 'resolve') {
            if (!p['dedupKey'] || typeof p['dedupKey'] !== 'string') {
                return { valid: false, reason: "'dedupKey' is required for resolve" };
            }
        }
        if (op === 'add_note') {
            if (!p['incidentId'] || typeof p['incidentId'] !== 'string' || p['incidentId'].trim() === '') {
                return { valid: false, reason: "'incidentId' is required for add_note" };
            }
            if (!p['content'] || typeof p['content'] !== 'string' || p['content'].trim() === '') {
                return { valid: false, reason: "'content' is required for add_note" };
            }
        }
        return { valid: true };
    }
    async dryRun(action) {
        const op = action.type;
        const p = action.params;
        const impactMap = {
            create_incident: `Create PagerDuty incident for service "${p['service'] ?? action.targetService}" with severity "${p['severity']}"`,
            escalate: `Escalate PagerDuty incident ${p['dedupKey']} to severity "${p['severity']}"`,
            resolve: `Resolve PagerDuty incident ${p['dedupKey']}`,
            add_note: `Add note to PagerDuty incident ${p['incidentId']}: "${String(p['content'] ?? '').slice(0, 60)}"`,
        };
        return {
            estimatedImpact: impactMap[op] ?? `PagerDuty ${op}`,
            warnings: op === 'create_incident' ? ['This will page on-call responders'] : [],
            willAffect: [String(p['service'] ?? p['dedupKey'] ?? p['incidentId'] ?? action.targetService)],
        };
    }
    async execute(action) {
        const op = action.type;
        const p = action.params;
        const executionId = randomUUID();
        try {
            if (op === 'create_incident') {
                const params = p;
                const routingKey = params.routingKey;
                if (!routingKey) {
                    return { success: false, output: null, rollbackable: false, executionId, error: 'routingKey is required (populate from credentialRef)' };
                }
                const dedupKey = params.dedupKey ?? randomUUID();
                const result = await this.client.sendEvent({
                    routing_key: routingKey,
                    event_action: 'trigger',
                    dedup_key: dedupKey,
                    payload: {
                        summary: params.description,
                        source: params.service,
                        severity: params.severity,
                        component: params.component,
                    },
                    client: 'agentic-obs',
                });
                return {
                    success: result.success,
                    output: { dedupKey: result.dedupKey, statusCode: result.statusCode },
                    rollbackable: result.success, // can resolve
                    executionId,
                    error: result.error,
                };
            }
            if (op === 'escalate') {
                const params = p;
                const routingKey = params.routingKey;
                if (!routingKey) {
                    return { success: false, output: null, rollbackable: false, executionId, error: 'routingKey is required (populate from credentialRef)' };
                }
                const result = await this.client.sendEvent({
                    routing_key: routingKey,
                    event_action: 'trigger',
                    dedup_key: params.dedupKey,
                    payload: {
                        summary: params.description,
                        source: action.targetService,
                        severity: params.severity,
                    },
                });
                return {
                    success: result.success,
                    output: { dedupKey: params.dedupKey, statusCode: result.statusCode },
                    rollbackable: false,
                    executionId,
                    error: result.error,
                };
            }
            if (op === 'resolve') {
                const params = p;
                const routingKey = params.routingKey;
                if (!routingKey) {
                    return { success: false, output: null, rollbackable: false, executionId, error: 'routingKey is required (populate from credentialRef)' };
                }
                const result = await this.client.sendEvent({
                    routing_key: routingKey,
                    event_action: 'resolve',
                    dedup_key: params.dedupKey,
                });
                return {
                    success: result.success,
                    output: { dedupKey: params.dedupKey, statusCode: result.statusCode },
                    rollbackable: false,
                    executionId,
                    error: result.error,
                };
            }
            if (op === 'add_note') {
                const params = p;
                if (!params.apiKey) {
                    return { success: false, output: null, rollbackable: false, executionId, error: 'apiKey is required for add_note (populate from credentialRef)' };
                }
                const result = await this.client.addNote(params.apiKey, params.incidentId, params.content,
                    params.callerEmail ?? 'agentic-obs@system');
                return {
                    success: result.success,
                    output: { incidentId: params.incidentId, statusCode: result.statusCode },
                    rollbackable: false,
                    executionId,
                    error: result.error,
                };
            }
            return { success: false, output: null, rollbackable: false, executionId, error: `Unknown operation: ${op}` };
        }
        catch {
            return { success: false, output: null, rollbackable: false, executionId, error: 'PagerDuty operation failed due to an internal error' };
        }
    }

    /**
     * Rollback a create_incident by resolving the created incident.
     * Only valid for create_incident executions where rollbackable=true.
     */
    async rollback(action, _executionId) {
        const p = action.params;
        const executionId = randomUUID();
        if (!p.dedupKey) {
            return { success: false, output: null, rollbackable: false, executionId, error: 'dedupKey required for rollback' };
        }
        if (!p.routingKey) {
            return { success: false, output: null, rollbackable: false, executionId, error: 'routingKey required for rollback' };
        }
        const result = await this.client.sendEvent({
            routing_key: p.routingKey,
            event_action: 'resolve',
            dedup_key: p.dedupKey,
        });
        return {
            success: result.success,
            output: { dedupKey: p.dedupKey, statusCode: result.statusCode },
            rollbackable: false,
            executionId,
            error: result.error,
        };
    }
}
//# sourceMappingURL=pagerduty-adapter.js.map