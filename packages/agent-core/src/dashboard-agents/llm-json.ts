/**
 * Parse JSON from LLM output — handles common issues:
 * - Strips markdown code fences
 * - Fixes invalid escape sequences (e.g. \s, \d from PromQL regex)
 * - Returns undefined on parse failure instead of throwing
 */
export function parseLlmJson<T = unknown>(raw: string): T | undefined {
  const stripped = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  // Fix invalid JSON escapes: \s \d \w etc. → \\s \\d \\w
  const sanitized = stripped.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
  try {
    return JSON.parse(sanitized) as T;
  } catch {
    return undefined;
  }
}
