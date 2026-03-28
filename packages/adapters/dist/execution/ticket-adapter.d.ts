import type { ExecutionAdapter, AdapterAction, AdapterCapability,
    ValidationResult, DryRunResult, ExecutionResult } from '@agentic-obs/agent-core';

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
    createTicket(project: string, title: string, description: string, priority: string, labels?: string[]): Promise<TicketCreateResult>;
    updateTicket(ticketId: string, fields: Record<string, unknown>): Promise<TicketUpdateResult>;
}
export declare class StubTicketClient implements TicketClient {
    readonly createCalls: Array<{
        project: string;
        title: string;
        description: string;
        priority: string;
        labels?: string[];
    }>;
    readonly updateCalls: Array<{
        ticketId: string;
        fields: Record<string, unknown>;
    }>;
    createTicket(project: string, title: string, description: string, priority: string, labels?: string[]): Promise<TicketCreateResult>;
    updateTicket(ticketId: string, fields: Record<string, unknown>): Promise<TicketUpdateResult>;
}
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
export declare class TicketAdapter implements ExecutionAdapter {
    private readonly client;
    constructor(client?: TicketClient);
    capabilities(): AdapterCapability[];
    validate(action: AdapterAction): Promise<ValidationResult>;
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    execute(action: AdapterAction): Promise<ExecutionResult>;
}
//# sourceMappingURL=ticket-adapter.d.ts.map