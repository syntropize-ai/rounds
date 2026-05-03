/**
 * The system-prompt cache boundary marker emitted by
 * `@agentic-obs/agent-core`'s `buildSystemPrompt` to delimit the static
 * (cacheable) prefix from the session-dynamic suffix. The literal must
 * match `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in `agent-core/orchestrator-prompt.ts`
 * verbatim — the string is the contract.
 *
 * The Anthropic provider splits on this marker to set a `cache_control:
 * ephemeral` breakpoint at the static/dynamic seam. Other providers don't
 * support that primitive; they call `stripCacheBoundary()` to remove the
 * marker so it never reaches the model as garbage text.
 *
 * Why duplicate the literal across packages instead of importing from
 * agent-core: `@agentic-obs/llm-gateway` is upstream of `@agentic-obs/agent-core`
 * in the dependency graph; importing back would invert the layering.
 * The wire-strip tests on each provider guard against drift via behaviour
 * (round-trip a string with the marker; confirm it doesn't appear in the
 * sent body).
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__OPENOBS_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * Remove every occurrence of the boundary marker from a system prompt
 * string. Used by providers that don't (yet) split on the marker for
 * cache scoping — they receive the concatenated string and must scrub
 * the marker before shipping to the model.
 */
export function stripCacheBoundary(systemText: string): string {
  if (!systemText.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return systemText;
  // Replace the marker plus any leading/trailing newlines that joined it
  // to surrounding content, so the strip is invisible in the rendered
  // prompt rather than leaving a double-blank-line scar. Empty parts
  // (marker-at-end / marker-only / adjacent markers) drop out.
  return systemText
    .split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .map((part) => part.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((part) => part.length > 0)
    .join('\n\n');
}
