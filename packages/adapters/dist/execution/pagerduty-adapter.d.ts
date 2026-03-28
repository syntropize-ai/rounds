import type { ExecutionAdapter, AdapterAction, AdapterCapability,
    ValidationResult, DryRunResult, ExecutionResult } from '@agentic-obs/agent-core';
import type { PagerDutyClient } from './pagerduty-client.js';
import type { PagerDutySeverity } from './pagerduty-client.js';

export type PagerDutyOperation = 'create_incident' | 'escalate' | 'resolve' | 'add_note';

export interface CreateIncidentParams {
    /** Short summary / title of the incident */
    description: string;
    /** Affected service name */
    service: string;
    /** PagerDuty severity: critical | error | warning | info */
    severity: PagerDutySeverity;
    /** Stable key for deduplication; defaults to a UUID if omitted */
    dedupKey?: string;
    /** Optional component field */
    component?: string;
    /** Routing key / integration key - populated from credentialRef */
    routingKey?: string;
}

export interface EscalateParams {
    /** Existing PagerDuty dedup_key to escalate */
    dedupKey: string;
    /** New severity level (must be more severe than current) */
    severity: PagerDutySeverity;
    /** Description to attach */
    description: string;
    /** Routing key */
    routingKey?: string;
}

export interface ResolveParams {
    /** dedup_key of the incident to resolve */
    dedupKey: string;
    /** Routing key */
    routingKey?: string;
}

export interface AddNoteParams {
    /** PagerDuty incident ID (e.g. "P123ABC") */
    incidentId: string;
    /** Note content */
    content: string;
    /** PagerDuty REST API key - populated from credentialRef */
    apiKey?: string;
    /** The requester's email (PagerDuty requires a From header) */
    callerEmail?: string;
}

export declare class PagerDutyAdapter implements ExecutionAdapter {
    private readonly client;
    constructor(client?: PagerDutyClient);
    capabilities(): AdapterCapability[];
    validate(action: AdapterAction): Promise<ValidationResult>;
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    execute(action: AdapterAction): Promise<ExecutionResult>;
    /**
     * Rollback a create_incident by resolving the created incident.
     * Only valid for create_incident executions where rollbackable=true.
     */
    rollback(action: AdapterAction, _executionId: string): Promise<ExecutionResult>;
}
//# sourceMappingURL=pagerduty-adapter.d.ts.map