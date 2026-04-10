// PagerDutyAdapter - ExecutionAdapter for PagerDuty incident management

import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';

const log = createLogger('pagerduty-adapter');
import type {
  ExecutionAdapter,
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
} from './types.js';
import type { PagerDutyClient } from './pagerduty-client.js';
import { HttpPagerDutyClient } from './pagerduty-client.js';
import type { PagerDutySeverity } from './pagerduty-client.js';

// -- Param types --

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

const VALID_OPERATIONS: PagerDutyOperation[] = ['create_incident', 'escalate', 'resolve', 'add_note'];
const VALID_SEVERITIES: PagerDutySeverity[] = ['critical', 'error', 'warning', 'info'];

// -- Adapter --

export class PagerDutyAdapter implements ExecutionAdapter {
  private readonly client: PagerDutyClient;

  constructor(client: PagerDutyClient = new HttpPagerDutyClient()) {
    this.client = client;
  }

  capabilities(): AdapterCapability[] {
    return VALID_OPERATIONS;
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    if (!VALID_OPERATIONS.includes(action.type as PagerDutyOperation)) {
      return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
    }

    const op = action.type as PagerDutyOperation;
    const p = action.params as Record<string, unknown>;

    if (op === 'create_incident') {
      if (!p['description'] || typeof p['description'] !== 'string' || (p['description'] as string).trim() === '') {
        return { valid: false, reason: '`description` is required for create_incident' };
      }
      if (!p['service'] || typeof p['service'] !== 'string' || (p['service'] as string).trim() === '') {
        return { valid: false, reason: '`service` is required for create_incident' };
      }
      if (!p['severity'] || !VALID_SEVERITIES.includes(p['severity'] as PagerDutySeverity)) {
        return { valid: false, reason: `\`severity\` must be one of: ${VALID_SEVERITIES.join(', ')}` };
      }
    }

    if (op === 'escalate') {
      if (!p['dedupKey'] || typeof p['dedupKey'] !== 'string') {
        return { valid: false, reason: '`dedupKey` is required for escalate' };
      }
      if (!p['severity'] || !VALID_SEVERITIES.includes(p['severity'] as PagerDutySeverity)) {
        return { valid: false, reason: `\`severity\` must be one of: ${VALID_SEVERITIES.join(', ')}` };
      }
      if (!p['description'] || typeof p['description'] !== 'string') {
        return { valid: false, reason: '`description` is required for escalate' };
      }
    }

    if (op === 'resolve') {
      if (!p['dedupKey'] || typeof p['dedupKey'] !== 'string') {
        return { valid: false, reason: '`dedupKey` is required for resolve' };
      }
    }

    if (op === 'add_note') {
      if (!p['incidentId'] || typeof p['incidentId'] !== 'string' || (p['incidentId'] as string).trim() === '') {
        return { valid: false, reason: '`incidentId` is required for add_note' };
      }
      if (!p['content'] || typeof p['content'] !== 'string' || (p['content'] as string).trim() === '') {
        return { valid: false, reason: '`content` is required for add_note' };
      }
    }

    return { valid: true };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const op = action.type as PagerDutyOperation;
    const p = action.params as Record<string, unknown>;

    const impactMap: Record<PagerDutyOperation, string> = {
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

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const op = action.type as PagerDutyOperation;
    const p = action.params as Record<string, unknown>;
    const executionId = randomUUID();

    try {
      if (op === 'create_incident') {
        const params = p as unknown as CreateIncidentParams;
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
        const params = p as unknown as EscalateParams;
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
        const params = p as unknown as ResolveParams;
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
        const params = p as unknown as AddNoteParams;
        if (!params.apiKey) {
          return { success: false, output: null, rollbackable: false, executionId, error: 'apiKey is required for add_note (populate from credentialRef)' };
        }
        const result = await this.client.addNote(
          params.apiKey,
          params.incidentId,
          params.content,
          params.callerEmail ?? 'agentic-obs@system',
        );
        return {
          success: result.success,
          output: { incidentId: params.incidentId, statusCode: result.statusCode },
          rollbackable: false,
          executionId,
          error: result.error,
        };
      }

      return { success: false, output: null, rollbackable: false, executionId, error: `Unknown operation: ${op}` };
    } catch (err) {
      log.warn({ err }, 'PagerDuty operation failed');
      return { success: false, output: null, rollbackable: false, executionId, error: 'PagerDuty operation failed due to an internal error' };
    }
  }

  /**
   * Rollback a create_incident by resolving the created incident.
   * Only valid for create_incident executions where rollbackable=true.
   */
  async rollback(action: AdapterAction, _executionId: string): Promise<ExecutionResult> {
    const p = action.params as unknown as CreateIncidentParams;
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