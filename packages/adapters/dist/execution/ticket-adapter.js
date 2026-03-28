// TicketAdapter - ExecutionAdapter for Jira/Linear ticket operations
import { randomUUID } from 'crypto';

export class StubTicketClient {
    createCalls = [];
    updateCalls = [];
    async createTicket(project, title, description, priority, labels) {
        this.createCalls.push({ project, title, description, priority, labels });
        return {
            success: true,
            ticketId: `STUB-${randomUUID().slice(0, 6).toUpperCase()}`,
            url: `https://stub.example.com/browse/STUB-001`,
            statusCode: 201,
        };
    }
    async updateTicket(ticketId, fields) {
        this.updateCalls.push({ ticketId, fields });
        return { success: true, ticketId, statusCode: 200 };
    }
}

const VALID_OPERATIONS = ['create_ticket', 'update_ticket'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

// — Adapter ———————————————————————————————————————————————————————————————————
export class TicketAdapter {
    client;
    constructor(client = new StubTicketClient()) {
        this.client = client;
    }
    capabilities() {
        return [...VALID_OPERATIONS];
    }
    async validate(action) {
        if (!VALID_OPERATIONS.includes(action.type)) {
            return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
        }
        const op = action.type;
        const p = action.params;
        if (op === 'create_ticket') {
            if (!p['project'] || typeof p['project'] !== 'string' || p['project'].trim() === '') {
                return { valid: false, reason: "'project' is required for create_ticket" };
            }
            if (!p['title'] || typeof p['title'] !== 'string' || p['title'].trim() === '') {
                return { valid: false, reason: "'title' is required for create_ticket" };
            }
            if (!p['description'] || typeof p['description'] !== 'string' || p['description'].trim() === '') {
                return { valid: false, reason: "'description' is required for create_ticket" };
            }
            if (!p['priority'] || !VALID_PRIORITIES.includes(p['priority'])) {
                return { valid: false, reason: `'priority' must be one of: ${VALID_PRIORITIES.join(', ')}` };
            }
        }
        if (op === 'update_ticket') {
            if (!p['ticketId'] || typeof p['ticketId'] !== 'string' || p['ticketId'].trim() === '') {
                return { valid: false, reason: "'ticketId' is required for update_ticket" };
            }
            if (!p['fields'] || typeof p['fields'] !== 'object' || Array.isArray(p['fields'])) {
                return { valid: false, reason: "'fields' must be an object for update_ticket" };
            }
        }
        return { valid: true };
    }
    async dryRun(action) {
        const op = action.type;
        const p = action.params;
        const impactMap = {
            create_ticket: `Create ticket in project "${p['project']}" - "${String(p['title'] ?? '').slice(0, 60)}" (priority: ${p['priority']})`,
            update_ticket: `Update ticket "${p['ticketId']}" with fields: ${Object.keys(p['fields'] ?? {}).join(', ')}`,
        };
        return {
            estimatedImpact: impactMap[op],
            warnings: [],
            willAffect: [String(op === 'create_ticket' ? p['project'] : p['ticketId'])],
        };
    }
    async execute(action) {
        const op = action.type;
        const p = action.params;
        const executionId = randomUUID();
        try {
            if (op === 'create_ticket') {
                const params = p;
                const result = await this.client.createTicket(params.project, params.title, params.description, params.priority, params.labels);
                return {
                    success: result.success,
                    outputs: { ticketId: result.ticketId, url: result.url, statusCode: result.statusCode },
                    rollbackable: false,
                    executionId,
                    errors: result.error,
                };
            }
            if (op === 'update_ticket') {
                const params = p;
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
        }
        catch (err) {
            return { success: false, output: null, rollbackable: false, executionId, error: String(err) };
        }
    }
}
//# sourceMappingURL=ticket-adapter.js.map