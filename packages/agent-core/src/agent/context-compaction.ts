import type { LLMGateway, CompletionMessage } from '@agentic-obs/llm-gateway'
import { estimateTokens, estimateMessagesTokens, COMPACTION_THRESHOLD, KEEP_RECENT_MESSAGES, SUMMARY_MAX_TOKENS } from './token-utils.js'

export interface CompactedContext {
  summary: string           // LLM-generated summary of old messages
  recentMessages: CompletionMessage[]  // kept in full
}

export function shouldCompact(
  systemPromptTokens: number,
  messages: CompletionMessage[],
): boolean {
  const total = systemPromptTokens + estimateMessagesTokens(messages)
  return total > COMPACTION_THRESHOLD
}

export async function compactMessages(
  gateway: LLMGateway,
  model: string,
  messages: CompletionMessage[],
): Promise<CompactedContext> {
  // Split: old messages to summarize, recent to keep
  const splitIndex = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)
  const oldMessages = messages.slice(0, splitIndex)
  const recentMessages = messages.slice(splitIndex)

  if (oldMessages.length === 0) {
    return { summary: '', recentMessages }
  }

  // Build summarization prompt — content is union (string | ContentBlock[]),
  // so flatten to text before truncating.
  const conversationText = oldMessages.map(m => {
    const flat = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return `${m.role}: ${flat.slice(0, 500)}`
  }).join('\n')

  const summaryPrompt = `Summarize the following conversation history concisely. Preserve:
1. What the user asked for and what was accomplished
2. IDs of any created artifacts (dashboardId, investigationId, alertRuleId) — these are CRITICAL, never lose them
3. Key metric names and query patterns discovered
4. Current state of work (what's done, what's pending)
5. Any important context the user provided (service names, environments, thresholds)

Keep the summary under ${SUMMARY_MAX_TOKENS} tokens. Be factual and specific — include actual IDs and metric names.

Conversation to summarize:
${conversationText}`

  try {
    const resp = await gateway.complete([
      { role: 'user', content: summaryPrompt },
    ], {
      model,
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0,
    })

    return {
      summary: resp.content.trim(),
      recentMessages,
    }
  } catch {
    // If summarization fails, just truncate old messages
    return {
      summary: `[Previous conversation with ${oldMessages.length} messages was truncated due to context limits]`,
      recentMessages,
    }
  }
}
