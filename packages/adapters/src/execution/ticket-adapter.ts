import { randomUUID } from 'crypto';
import type {
  ExecutionAdapter,
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
} from './types.js';

// -- Client interface --

export interface TicketCreateResult {
  success: boolean;
  ticketId: string;
  url?: string;
  statusCode?: number;
  error?: string;
}

export interface TicketUpdateResult {
  success: boolean;
  ticketId: string;
  statusCode?: number;
  error?: string;
}

export interface TicketClient {
  createTicket(
    project: string,
    title: string,
    description: string,
    priority: string,
    labels?: string[],
  ): Promise<TicketCreateResult>;

  updateTicket(
    ticketId: string,
    fields: Record<string, unknown>,
  ): Promise<TicketUpdateResult>;
}

export class StubTicketClient implements TicketClient {
  readonly createCalls: Array<{ project: string; title: string; description: string; priority: string; labels?: string[] }> = [];
  readonly updateCalls: Array<{ ticketId: string; fields: Record<string, unknown> }> = [];

  async createTicket(
    project: string,
    title: string,
    description: string,
    priority: string,
    labels?: string[],
  ): Promise<TicketCreateResult> {
    this.createCalls.push({ project, title, description, priority, labels });
    return {
      success: true,
      ticketId: `STUB-${randomUUID().slice(0, 6).toUpperCase()}`,
      url: `https://stub.example.com/browse/STUB-001`,
      statusCode: 201,
    };
  }

  async updateTicket(ticketId: string, fields: Record<string, unknown>): Promise<TicketUpdateResult> {
    this.updateCalls.push({ ticketId, fields });
    return { success: true, ticketId, statusCode: 200 };
  }
}

// -- Param types --

export type TicketOperation = 'create_ticket' | 'update_ticket';

export interface CreateTicketParams {
  /** Project key, e.g. "OPS" or "INFRA" */
  project: string;
  /** Ticket title / summary */
  title: string;
  /** Detailed description */
  description: string;
  /** Priority: critical | high | medium | low */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Optional label tags */
  labels?: string[];
}

export interface UpdateTicketParams {
  /** Existing ticket ID, e.g. "OPS-123" */
  ticketId: string;
  /** Fields to update - arbitrary key-value pairs */
  fields: Record<string, unknown>;
}

const VALID_OPERATIONS: TicketOperation[] = ['create_ticket', 'update_ticket'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

// -- Adapter --

export class TicketAdapter implements ExecutionAdapter {
  private readonly client: TicketClient;

  constructor(client: TicketClient = new StubTicketClient()) {
    this.client = client;
  }

  capabilities(): AdapterCapability[] {
    return [...VALID_OPERATIONS];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    if (!VALID_OPERATIONS.includes(action.type as TicketOperation)) {
      return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
    }

    const op = action.type as TicketOperation;
    const p = action.params as Record<string, unknown>;

    if (op === 'create_ticket') {
      if (!p['project'] || typeof p['project'] !== 'string' || (p['project'] as string).trim() === '') {
        return { valid: false, reason: '`project` is required for create_ticket' };
      }
      if (!p['title'] || typeof p['title'] !== 'string' || (p['title'] as string).trim() === '') {
        return { valid: false, reason: '`title` is required for create_ticket' };
      }
      if (!p['description'] || typeof p['description'] !== 'string' || (p['description'] as string).trim() === '') {
        return { valid: false, reason: '`description` is required for create_ticket' };
      }
      if (!p['priority'] || !VALID_PRIORITIES.includes(p['priority'] as string)) {
        return { valid: false, reason: `\`priority\` must be one of: ${VALID_PRIORITIES.join(', ')}` };
      }
    }

    if (op === 'update_ticket') {
      if (!p['ticketId'] || typeof p['ticketId'] !== 'string' || (p['ticketId'] as string).trim() === '') {
        return { valid: false, reason: '`ticketId` is required for update_ticket' };
      }
      if (!p['fields'] || typeof p['fields'] !== 'object' || Array.isArray(p['fields'])) {
        return { valid: false, reason: '`fields` must be an object for update_ticket' };
      }
    }

    return { valid: true };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const op = action.type as TicketOperation;
    const p = action.params as Record<string, unknown>;

    const impactMap: Record<TicketOperation, string> = {
      create_ticket: `Create ticket in project "${p['project']}" - "${String(p['title'] ?? '').slice(0, 60)}" (priority: ${p['priority']})`,
      update_ticket: `Update ticket "${p['ticketId']}" with fields: ${Object.keys((p['fields'] as object) ?? {}).join(', ')}`,
    };

    return {
      estimatedImpact: impactMap[op],
      warnings: [],
      willAffect: [String(op === 'create_ticket' ? p['project'] : p['ticketId'])],
    };
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const op = action.type as TicketOperation;
    const p = action.params as Record<string, unknown>;
    const executionId = randomUUID();

    try {
      if (op === 'create_ticket') {
        const params = p as unknown as CreateTicketParams;
        const result = await this.client.createTicket(
          params.project,
          params.title,
          params.description,
          params.priority,
          params.labels,
        );
        return {
          success: result.success,
          output: { ticketId: result.ticketId, url: result.url, statusCode: result.statusCode },
          rollbackable: false,
          executionId,
          error: result.error,
        };
      }

      if (op === 'update_ticket') {
        const params = p as unknown as UpdateTicketParams;
        const result = await this.client.updateTicket(params.ticketId, params.fields);
        return {
          success: result.success,
          output: { ticketId: result.ticketId, statusCode: result.statusCode },
          rollbackable: false,
          executionId,
          error: result.error,
        };
      }

      return { success: false, output: null, rollbackable: false, executionId, error: `Unknown operation: ${op}` };
    } catch (err) {
      return { success: false, output: null, rollbackable: false, executionId, error: String(err) };
    }
  }
}