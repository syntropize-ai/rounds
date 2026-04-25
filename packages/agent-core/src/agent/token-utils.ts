/** Rough token estimation: ~4 characters per token (conservative) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string | unknown[] }>,
): number {
  // Content blocks (native tool_use shape) get a JSON-stringified estimate
  // since the field varies per block type. Plain strings pass through.
  return messages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return sum + estimateTokens(text) + 4
  }, 0) // +4 for role/formatting overhead
}

// Configurable thresholds
export const CONTEXT_WINDOW = 128_000
export const COMPACTION_THRESHOLD = 100_000  // trigger at ~78%
export const KEEP_RECENT_MESSAGES = 10       // always keep last N messages in full
export const SUMMARY_MAX_TOKENS = 2000       // max tokens for the summary itself
