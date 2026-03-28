import type { StructuredIntent } from '@agentic-obs/common';

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}

const TASK_TYPES = new Set([
  'explain_latency',
  'explain_errors',
  'check_health',
  'compare_baseline',
  'investigate_change',
  'general_query',
] as const);

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return !isNaN(Date.parse(value));
}

export class IntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentValidationError';
  }
}

/**
 * Parse and validate raw LLM output into a StructuredIntent.
 * Throws IntentValidationError on failure.
 */
export function parseAndValidate(raw: string): StructuredIntent {
  let obj: unknown;
  try {
    obj = JSON.parse(stripCodeFences(raw));
  } catch {
    throw new IntentValidationError(`LLM output is not valid JSON: ${raw.slice(0, 120)}`);
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new IntentValidationError('LLM output must be a JSON object');
  }

  const record = obj as Record<string, unknown>;

  // taskType
  if (!TASK_TYPES.has(record['taskType'] as StructuredIntent['taskType'])) {
    throw new IntentValidationError(
      `Invalid taskType: ${String(record['taskType'])}. Must be one of ${[...TASK_TYPES].join(', ')}`,
    );
  }

  // entity
  if (typeof record['entity'] !== 'string' || record['entity'].trim() === '') {
    throw new IntentValidationError('entity must be a non-empty string');
  }

  // signal [optional]
  if (record['signal'] !== null && record['signal'] !== undefined && typeof record['signal'] !== 'string') {
    throw new IntentValidationError('signal must be a string or null');
  }

  // timeRange
  const tr = record['timeRange'];
  if (typeof tr !== 'object' || tr === null || Array.isArray(tr)) {
    throw new IntentValidationError('timeRange must be an object');
  }

  const trRecord = tr as Record<string, unknown>;
  if (!isIsoDate(trRecord['start'])) {
    throw new IntentValidationError(`timeRange.start must be a valid ISO-8601 date, got: ${String(trRecord['start'])}`);
  }
  if (!isIsoDate(trRecord['end'])) {
    throw new IntentValidationError(`timeRange.end must be a valid ISO-8601 date, got: ${String(trRecord['end'])}`);
  }

  // goal
  if (typeof record['goal'] !== 'string' || record['goal'].trim() === '') {
    throw new IntentValidationError('goal must be a non-empty string');
  }

  // constraints [optional]
  if (
    record['constraints'] !== null &&
    record['constraints'] !== undefined &&
    (typeof record['constraints'] !== 'object' || Array.isArray(record['constraints']))
  ) {
    throw new IntentValidationError('constraints must be an object or null');
  }

  return {
    taskType: record['taskType'] as StructuredIntent['taskType'],
    entity: record['entity'] as string,
    signal: (record['signal'] ?? undefined) as string | undefined,
    timeRange: {
      start: trRecord['start'] as string,
      end: trRecord['end'] as string,
    },
    goal: record['goal'] as string,
    constraints: (record['constraints'] ?? undefined) as Record<string, unknown> | undefined,
  };
}
