import { randomUUID } from 'crypto';

export class StubCICDClient {
    triggerCalls = [];
    statusCalls = [];
    async triggerWorkflow(repo, workflow, ref) {
        this.triggerCalls.push({ repo, workflow, ref });
        return { success: true, runId: `stub-run-${randomUUID()}`, statusCode: 201 };
    }
    async getStatus(runId) {
        this.statusCalls.push({ runId });
        return { success: true, status: 'success', statusCode: 200 };
    }
}

const VALID_OPERATIONS = ['trigger_pipeline', 'rollback_deploy'];

export class CICDAdapter {
    client;
    constructor(client = new StubCICDClient()) {
        this.client = client;
    }
    capabilities() {
        return [...VALID_OPERATIONS];
    }
    async validate(action) {
        if (!VALID_OPERATIONS.includes(action.type)) {
            return { valid: false, reason: `Unknown operation "${action.type}". Valid: ${VALID_OPERATIONS.join(', ')}` };
        }
        const p = action.params;
        if (!p['repo'] || typeof p['repo'] !== 'string' || p['repo'].trim() === '') {
            return { valid: false, reason: "'repo' is required and must be a non-empty string" };
        }
        if (!p['workflow'] || typeof p['workflow'] !== 'string' || p['workflow'].trim() === '') {
            return { valid: false, reason: "'workflow' is required and must be a non-empty string" };
        }
        if (!p['ref'] || typeof p['ref'] !== 'string' || p['ref'].trim() === '') {
            return { valid: false, reason: "'ref' is required and must be a non-empty string" };
        }
        return { valid: true };
    }
    async dryRun(action) {
        const op = action.type;
        const p = action.params;
        const impactMap = {
            trigger_pipeline: `Trigger workflow "${p['workflow']}" on repo "${p['repo']}" at ref "${p['ref']}"`,
            rollback_deploy: `Rollback deploy via workflow "${p['workflow']}" on repo "${p['repo']}" at ref "${p['ref']}"`,
        };
        const warnings = op === 'rollback_deploy' 
            ? ['This will deploy a previous version and may cause a brief service interruption'] 
            : [];
        return {
            estimatedImpact: impactMap[op],
            warnings,
            willAffect: [String(p['repo']) ?? action.targetService],
        };
    }
    async execute(action) {
        const op = action.type;
        const p = action.params;
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