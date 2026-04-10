/**
 * Strip markdown code fences from LLM output so the inner content
 * can be parsed as JSON (or another format).
 */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}
