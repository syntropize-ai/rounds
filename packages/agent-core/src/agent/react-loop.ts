import type {
  LLMGateway,
  LLMResponse,
  CompletionMessage,
  ContentBlock,
  ToolCall,
} from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common/logging'
import type { DashboardSseEvent, Identity } from '@agentic-obs/common'
import type { IAccessControlService } from './types-permissions.js'
import { estimateMessagesTokens, CONTEXT_WINDOW } from './token-utils.js'
import { toolsForAgent } from './tool-schema-registry.js'

const log = createLogger('react-loop')

/**
 * Safety ceiling on iterations to prevent pathological infinite loops
 * (provider returning identical results, model unable to terminate, etc).
 * Under well-behaved operation the LLM emits `reply` / `ask_user` / `finish`
 * long before this is hit. The real budget is tokens (see
 * TOKEN_BUDGET_TOKENS below); iteration count is just a backstop.
 */
const MAX_ITERATIONS = 200

/**
 * Soft token budget: when the messages about to be sent to the LLM would
 * exceed this, exit the loop with a graceful "reached context limit" reply
 * rather than letting the gateway reject the request. Set at 95% of
 * CONTEXT_WINDOW to leave headroom for the model's own completion tokens.
 */
const TOKEN_BUDGET_TOKENS = Math.floor(CONTEXT_WINDOW * 0.95)
/** Keep the last N observations in full; older ones are summarized to save context. */
const OBSERVATION_KEEP_RECENT = 6
/** Truncate individual observation text to this many characters. */
const OBSERVATION_MAX_CHARS = 2000

/**
 * Default effort for extended thinking. Medium gives Claude/o1/Gemini-2.5
 * enough room to deliberate before acting without ballooning latency.
 * Override at runtime with OPENOBS_THINKING_EFFORT=low|medium|high|off.
 */
function thinkingEffort(): 'low' | 'medium' | 'high' {
  const raw = (process.env.OPENOBS_THINKING_EFFORT ?? 'medium').toLowerCase()
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw
  // 'off' or unrecognized → low (cheapest); we never fully disable so models
  // that support thinking still get a small budget by default.
  return 'low'
}

export interface ReActStep {
  thought: string
  /** Brief conversational reply shown to user before executing the action */
  message?: string
  action: string
  args: Record<string, unknown>
}

/** Actions that commit a final result and exit the loop. */
const TERMINAL_ACTIONS = new Set(['reply', 'ask_user', 'finish'])

/**
 * Classify gateway HTTP failures so the loop can bail out with a user-facing
 * message instead of spinning through MAX_ITERATIONS hammering a provider
 * that's rejecting every request. Providers (anthropic.ts / openai.ts /
 * gemini.ts / ollama.ts) throw errors shaped as
 * `"${Provider} API error ${status}: ${body}"`, so a single regex handles all
 * of them. Anything that doesn't match the pattern is unknown — surface it
 * as fatal too, since with native tool_use we no longer have a parse-retry
 * path that could recover from a transient mis-format.
 */
function classifyLlmError(message: string): { kind: 'fatal'; userMessage: string } {
  const apiErr = message.match(/API error (\d+):/i)
  if (!apiErr) {
    return {
      kind: 'fatal',
      userMessage: `The LLM call failed: ${message}`,
    }
  }
  const status = Number(apiErr[1])

  // Rate limit / quota — try to surface the retryAfter hint if provider
  // included one.
  if (status === 429 || /rate[- ]?limit|quota|RESOURCE_EXHAUSTED|credit balance|billing/i.test(message)) {
    const retryMatch =
      message.match(/retry in ([\d.]+\s*[ms]?s?)/i) ||
      message.match(/retryDelay['":\s]+["']?([\d.]+s)/i)
    const retryHint = retryMatch ? ` (try again in ${retryMatch[1]})` : ''
    const isBilling = /credit balance|billing|insufficient.*(credit|funds)/i.test(message)
    return {
      kind: 'fatal',
      userMessage: isBilling
        ? 'The LLM provider rejected the request due to insufficient credits / billing. Top up the account or switch to a different model in Setup.'
        : `The LLM provider hit a rate limit or quota cap${retryHint}. Switch to a different model or wait before retrying.`,
    }
  }
  // Auth
  if (status === 401 || status === 403) {
    return {
      kind: 'fatal',
      userMessage: 'The LLM provider rejected the API key. Check the model configuration in Setup.',
    }
  }
  // Client errors (400 validation, 404 model not found, 413 payload too large, …)
  // — none of these get better on retry.
  if (status >= 400 && status < 500) {
    return {
      kind: 'fatal',
      userMessage: `The LLM provider rejected the request (${status}). Check the model configuration and try again.`,
    }
  }
  // 5xx server errors — transient in principle, but our retry is a tight
  // loop with no backoff, so hammering the provider is worse than failing
  // fast. The user can simply resend.
  if (status >= 500) {
    return {
      kind: 'fatal',
      userMessage: `The LLM provider returned a server error (${status}). Please retry in a moment.`,
    }
  }
  // Unknown API error — treat as fatal to avoid burning iterations.
  return {
    kind: 'fatal',
    userMessage: `The LLM provider returned an unexpected error (${status}).`,
  }
}

export interface ReActObservation {
  action: string
  args: Record<string, unknown>
  result: string
  /**
   * The original tool_use id from the provider (Anthropic toolu_*, OpenAI
   * call_*). Required so the next turn's tool_result block can be paired
   * with the matching tool_use block — without it Anthropic rejects the
   * request and OpenAI loses the threading. When the model emits multiple
   * parallel tool_use blocks in one turn, we group them under a single
   * batchId so buildMessages knows to coalesce them into one assistant
   * message containing all tool_use blocks + one user message containing
   * all matching tool_result blocks.
   */
  toolUseId?: string
  batchId?: number
  /**
   * The pre-tool prose the model emitted alongside this batch (only set on
   * the first observation of each batch). Replayed as a text block before
   * the tool_use blocks in the assistant turn.
   */
  preToolText?: string
}

export interface ReActDeps {
  gateway: LLMGateway
  model: string
  sendEvent: (event: DashboardSseEvent) => void
  /**
   * The authenticated principal on whose behalf the agent runs. Required —
   * loop refuses to start without one. There is no ambient "system" identity.
   * See docs/auth-perm-design/11-agent-permissions.md §D1, §D4.
   */
  identity: Identity
  /** Access control surface the permission gate calls from the loop. */
  accessControl: IAccessControlService
  /**
   * The tool surface this loop exposes to the LLM. Resolved from
   * `agent-registry.ts` `allowedTools` for the agent type. Required so the
   * gateway call uses native tool_use — we no longer rely on prose-JSON.
   */
  allowedTools: readonly string[]
  /** Maximum total tokens per chat message. Default: 50000 */
  maxTokenBudget?: number
  /** LLM-generated summary of earlier conversation turns (from context compaction) */
  conversationSummary?: string
}

export class ReActLoop {
  constructor(private deps: ReActDeps) {}

  private async composePostActionReply(
    userMessage: string,
    action: string,
    draftReply: string | undefined,
    observationText: string,
  ): Promise<string> {
    try {
      const resp = await this.deps.gateway.complete([
        {
          role: 'system',
          content: 'You are writing the final assistant reply for an observability dashboard chat after an action has already completed. Write one short, natural sentence in plain language. Do not mention internal tool names, JSON, or implementation details.',
        },
        {
          role: 'user',
          content: `User request: ${userMessage}\nAction: ${action}\nDraft reply: ${draftReply ?? '(none)'}\nResult: ${observationText}`,
        },
      ], {
        model: this.deps.model,
        maxTokens: 100,
        temperature: 0.2,
      })

      const text = resp.content.trim()
      if (text) return text
    }
    catch {
      // Fall back to the execution summary below.
    }

    return draftReply?.trim() || observationText
  }

  async runLoop(
    systemPrompt: string,
    userMessage: string,
    executeAction: (step: ReActStep) => Promise<string | null>,
  ): Promise<string> {
    // D4 — no ambient identity. If the caller didn't bind one, refuse to run.
    // Undefined / null / empty userId all fail the same way: the agent is the
    // user's hands, and without a user there are no hands.
    if (!this.deps.identity || !this.deps.identity.userId) {
      throw new Error(
        'ReActLoop.runLoop: identity is required. ' +
          'Background callers must resolve a service account token before starting the loop.',
      )
    }

    const tools = toolsForAgent(this.deps.allowedTools)

    const observations: ReActObservation[] = []
    let lastAction: string | null = null
    let lastDraftReply: string | undefined
    let lastObservation: string | null = null
    let batchCounter = 0

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const messages = this.buildMessages(systemPrompt, userMessage, observations)

      // Token-budget termination — the primary "we're done" signal once the
      // LLM stops emitting terminal actions on its own. Estimated, not exact,
      // so leave headroom (TOKEN_BUDGET_TOKENS < CONTEXT_WINDOW).
      const estimatedTokens = estimateMessagesTokens(messages)
      if (estimatedTokens > TOKEN_BUDGET_TOKENS) {
        log.warn({ step: i, estimatedTokens, budget: TOKEN_BUDGET_TOKENS }, 'token budget exhausted — ending loop')
        const reply = `I've worked through ${i} step${i === 1 ? '' : 's'} on this task, but the conversation has grown past the context budget. Here's a summary of where I am so far — ask me a focused follow-up if you need more detail.`
        this.deps.sendEvent({ type: 'reply', content: reply })
        return reply
      }

      let toolCalls: ToolCall[]
      let preToolProse: string | undefined
      let resp: LLMResponse
      try {
        resp = await this.deps.gateway.complete(messages, {
          model: this.deps.model,
          maxTokens: 4096,
          temperature: 0,
          tools,
          toolChoice: 'auto',
          thinking: { effort: thinkingEffort() },
        })

        toolCalls = resp.toolCalls
        preToolProse = resp.content?.trim() ? resp.content.trim() : undefined

        if (resp.thinkingBlocks && resp.thinkingBlocks.length > 0) {
          for (const tb of resp.thinkingBlocks) {
            this.deps.sendEvent({ type: 'thinking', content: tb })
          }
        }

        log.info(
          {
            step: i,
            toolCallCount: toolCalls.length,
            toolNames: toolCalls.map((tc) => tc.name),
            contentHead: resp.content.slice(0, 200),
            thinkingBlockCount: resp.thinkingBlocks?.length ?? 0,
          },
          'ReAct: gateway response',
        )

        if (toolCalls.length === 0) {
          // No tool call — model returned plain text. Two legitimate patterns:
          //   - Q&A turns where the model answered inline instead of invoking
          //     `reply`. Treat the text as the final reply.
          //   - Truly empty content — surface as an error so the user knows
          //     the prompt or schema is misconfigured rather than seeing a
          //     silent "" return.
          if (preToolProse) {
            this.deps.sendEvent({ type: 'reply', content: preToolProse })
            return preToolProse
          }
          const fallback =
            'Model returned no content and no tool call. This usually means the prompt or tool schema is misconfigured.'
          this.deps.sendEvent({ type: 'error', message: fallback })
          this.deps.sendEvent({ type: 'reply', content: fallback })
          return fallback
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const classification = classifyLlmError(msg)
        log.warn({ step: i, err: msg }, 'LLM gateway error — aborting loop')
        this.deps.sendEvent({ type: 'error', message: classification.userMessage })
        this.deps.sendEvent({ type: 'reply', content: classification.userMessage })
        return classification.userMessage
      }

      // Emit the model's pre-tool narration ONCE per turn (not once per
      // tool call) — it's a single sentence describing the whole batch.
      if (preToolProse) {
        this.deps.sendEvent({ type: 'reply', content: preToolProse })
      }

      // --- Execute every tool call in this turn ---
      // Native tool_use providers (Anthropic, OpenAI, ...) routinely emit
      // multiple tool_use blocks per assistant turn for parallel discovery
      // (e.g. metrics.metric_names + metrics.metadata in one shot).
      // Dropping the extras left the model expecting results it never got
      // and confused subsequent turns; iterating honors the protocol.
      // A terminal action (reply/finish/ask_user) inside the batch ends
      // the loop immediately — anything queued after it is discarded
      // because the conversation is over.
      const batchId = batchCounter++
      for (const tc of toolCalls) {
        const step: ReActStep = {
          thought: '',
          // Only the first call inherits the pre-tool prose so it isn't
          // re-emitted per call. Subsequent calls have no separate message.
          message: tc === toolCalls[0] ? preToolProse : undefined,
          action: tc.name,
          args: tc.input ?? {},
        }
        const { action, args = {} } = step
        step.args = args
        lastAction = action
        lastDraftReply = step.message

        log.info(
          {
            step: i,
            action,
            message: step.message?.slice(0, 120),
            argsKeys: Object.keys(args),
          },
          'ReAct: synthesized step',
        )

        // --- Terminal action inside the batch — exit immediately ---
        if (TERMINAL_ACTIONS.has(action)) {
          const pickString = (v: unknown): string | undefined =>
            typeof v === 'string' && v.trim() ? v : undefined
          const text = action === 'ask_user'
            ? (step.message ?? pickString(args.question) ?? pickString(args.message) ?? pickString(args.text) ?? '')
            : (step.message ?? pickString(args.message) ?? pickString(args.text) ?? pickString(args.content) ?? '')
          if (text) {
            this.deps.sendEvent({ type: 'reply', content: text })
          }
          return text
        }

        // --- Non-terminal: execute and record observation ---
        const observationText = await executeAction(step)
        if (observationText === null)
          return ''

        lastObservation = observationText

        // Record the observation with its tool_use_id and batchId so the
        // next-turn replay can rebuild proper Anthropic-style content
        // blocks: [tool_use_a, tool_use_b] in the assistant turn, paired
        // with [tool_result_a, tool_result_b] in the user turn. Without
        // this pairing the model would see a string-serialized assistant
        // turn and learn that prose-JSON is a valid response — which is
        // exactly what destabilized the loop before this fix.
        observations.push({
          action,
          args,
          result: observationText,
          toolUseId: tc.id,
          batchId,
          // Only the first tool of the batch carries the pre-tool prose so
          // we don't repeat it across N tool_result blocks.
          ...(tc === toolCalls[0] && preToolProse ? { preToolText: preToolProse } : {}),
        })
      }
    }

    if (lastAction && lastObservation) {
      const finalReply = await this.composePostActionReply(
        userMessage,
        lastAction,
        lastDraftReply,
        lastObservation,
      )
      this.deps.sendEvent({ type: 'reply', content: finalReply })
      return finalReply
    }

    // Iteration ceiling reached — safety net, not a normal completion path.
    // Be honest: we didn't converge, the user needs to know to retry with a
    // narrower scope rather than assume success.
    log.warn({ iterations: MAX_ITERATIONS }, 'iteration ceiling reached without terminal action')
    const fallback = `I ran through ${MAX_ITERATIONS} steps without reaching a clear stopping point. This usually means the task branched more than expected or I got stuck on a loop. Try narrowing the request, or ask me what I learned along the way.`
    this.deps.sendEvent({ type: 'reply', content: fallback })
    return fallback
  }

  buildMessages(
    systemPrompt: string,
    userMessage: string,
    observations: ReActObservation[],
  ): CompletionMessage[] {
    const messages: CompletionMessage[] = [
      { role: 'system', content: systemPrompt },
    ]

    // Inject conversation summary from context compaction if available
    if (this.deps.conversationSummary) {
      messages.push({
        role: 'user',
        content: `[Conversation Summary]\n${this.deps.conversationSummary}`,
      })
      messages.push({
        role: 'assistant',
        content: 'Understood. I have the context from the previous conversation.',
      })
    }

    messages.push({ role: 'user', content: userMessage })

    // Coalesce observations by batchId so each gateway turn reproduces the
    // exact assistant/user content-block pair that originally happened —
    // tool_use blocks in the assistant message, paired tool_result blocks
    // in the user message. Without this the model sees its own previous
    // multi-tool turns as a sequence of single-action steps, which both
    // destabilizes the conversation and teaches it to emit prose-JSON.
    //
    // Older batches (beyond OBSERVATION_KEEP_RECENT) are compressed to
    // one-line summaries to save context — but still as structured blocks
    // so the model knows they were tool calls.
    const cutoff = Math.max(0, observations.length - OBSERVATION_KEEP_RECENT)

    // Group by batchId, preserving ordering.
    const batches: ReActObservation[][] = []
    let currentBatch: ReActObservation[] = []
    let currentBatchId: number | undefined
    for (const obs of observations) {
      if (obs.batchId !== currentBatchId) {
        if (currentBatch.length > 0) batches.push(currentBatch)
        currentBatch = []
        currentBatchId = obs.batchId
      }
      currentBatch.push(obs)
    }
    if (currentBatch.length > 0) batches.push(currentBatch)

    let observationIndex = 0
    for (const batch of batches) {
      const isOlder = observationIndex + batch.length <= cutoff
      observationIndex += batch.length

      // Assistant turn: optional pre-tool text + one tool_use block per call.
      const assistantBlocks: ContentBlock[] = []
      const preText = batch[0]?.preToolText
      if (preText) {
        assistantBlocks.push({ type: 'text', text: preText })
      }
      for (const obs of batch) {
        // Older batches without a recorded toolUseId (legacy) fall back to a
        // synthesized id so block-pairing stays consistent. The id only has
        // to be unique within this request, not stable across requests.
        const id = obs.toolUseId ?? `replay_${observationIndex}_${obs.action}`
        assistantBlocks.push({
          type: 'tool_use',
          id,
          name: obs.action,
          input: obs.args,
        })
      }
      messages.push({ role: 'assistant', content: assistantBlocks })

      // User turn: one tool_result block per call, paired by tool_use_id.
      const userBlocks: ContentBlock[] = []
      for (const obs of batch) {
        const id = obs.toolUseId ?? `replay_${observationIndex - batch.length + userBlocks.length + 1}_${obs.action}`
        let resultText = obs.result
        if (isOlder) {
          resultText = `[Earlier] ${obs.result.slice(0, 120)}${obs.result.length > 120 ? '...' : ''}`
        } else if (resultText.length > OBSERVATION_MAX_CHARS) {
          resultText = resultText.slice(0, OBSERVATION_MAX_CHARS) + `\n... (truncated, ${resultText.length} chars total)`
        }
        userBlocks.push({
          type: 'tool_result',
          tool_use_id: id,
          tool_name: obs.action,
          content: resultText,
        })
      }
      messages.push({ role: 'user', content: userBlocks })
    }

    return messages
  }
}
