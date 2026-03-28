function stripCodeFences(raw) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
    return match?.[1]?.trim() ?? trimmed;
}
const TASK_TYPES = new Set([
    'explain_latency',
    'explain_errors',
    'check_health',
    'compare_baseline',
    'investigate_change',
    'general_query',
]);
function isIsoDate(value) {
    if (typeof value !== 'string') {
        return false;
    }
    return !isNaN(Date.parse(value));
}
export class IntentValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'IntentValidationError';
    }
}
/**
 * Parse and validate raw LLM output into a StructuredIntent.
 * Throws IntentValidationError on failure.
 */
export function parseAndValidate(raw) {
    let obj;
    try {
        obj = JSON.parse(stripCodeFences(raw));
    }
    catch {
        throw new IntentValidationError(`LLM output is not valid JSON: ${raw.slice(0, 120)}`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        throw new IntentValidationError('LLM output must be a JSON object');
    }
    const record = obj;
    if (!TASK_TYPES.has(record['taskType'])) {
        throw new IntentValidationError(`Invalid taskType: ${String(record['taskType'])}. Must be one of: ${[...TASK_TYPES].join(', ')}`);
    }
    if (typeof record['entity'] !== 'string' || record['entity'].trim() === '') {
        throw new IntentValidationError('entity must be a non-empty string');
    }
    if (record['signal'] !== null && record['signal'] !== undefined && typeof record['signal'] !== 'string') {
        throw new IntentValidationError('signal must be a string or null');
    }
    if (typeof record['timeRange'] !== 'object' || record['timeRange'] === null || Array.isArray(record['timeRange'])) {
        throw new IntentValidationError('timeRange must be an object');
    }
    if (!isIsoDate(record['timeRange']['start']) || !isIsoDate(record['timeRange']['end'])) {
        throw new IntentValidationError('timeRange.start and timeRange.end must be ISO-8601 strings');
    }
    if (typeof record['goal'] !== 'string' || record['goal'].trim() === '') {
        throw new IntentValidationError('goal must be a non-empty string');
    }
    if (record['constraints'] !== null &&
        record['constraints'] !== undefined &&
        (typeof record['constraints'] !== 'object' || Array.isArray(record['constraints']))) {
        throw new IntentValidationError('constraints must be an object or null');
    }
    return {
        taskType: record['taskType'],
        entity: record['entity'].trim(),
        signal: record['signal'] ?? null,
        timeRange: {
            start: record['timeRange']['start'],
            end: record['timeRange']['end'],
        },
        goal: record['goal'].trim(),
        constraints: record['constraints'] ?? null,
    };
}
//# sourceMappingURL=schema.js.map
