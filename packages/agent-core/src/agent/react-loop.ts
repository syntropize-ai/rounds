import type {
  LLMGateway,
  CompletionMessage,
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
 * TOKEN_BUDGET_TOKENS below), matching the way Claude Code's loop terminates.
 */
const MAX_ITERATIONS = 200

/**
 * Soft token budget: when the messages about to be sent to the LLM would
 * exceed this, exit the loop with a graceful "reached context limit" reply
 * rather than letting the gateway reject the request. Set slightly under
 * CONTEXT_WINDOW to leave headroom for the model's own completion tokens.
 */
const TOKEN_BUDGET_TOKENS = Math.floor(CONTEXT_WINDOW * 0.95)
/** Keep the last N observations in full; older ones are summarized to save context. */
const OBSERVATION_KEEP_RECENT = 6
/** Truncate individual observation text to this many characters. */
const OBSERVATION_MAX_CHARS = 2000

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
   * The full step object the LLM produced (minus `message`, which is
   * user-facing and would invite parroting). We replay this verbatim so
   * the model sees its own reasoning chain on the next turn, without us
   * second-guessing which fields matter.
   */
  stepForReplay?: Record<string, unknown>
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

      let step: ReActStep
      try {
        const resp = await this.deps.gateway.complete(messages, {
          model: this.deps.model,
          maxTokens: 4096,
          temperature: 0,
          tools,
          toolChoice: 'auto',
        })

        log.info(
          {
            step: i,
            toolCallCount: resp.toolCalls.length,
            firstToolName: resp.toolCalls[0]?.name,
            contentHead: resp.content.slice(0, 200),
          },
          'ReAct: gateway response',
        )

        if (resp.toolCalls.length > 0) {
          // Multi-tool turns are deferred to a follow-up PR; for now we honor
          // the first tool_use block and ignore the rest. The pre-tool prose
          // (if any) is preserved as `message` so the existing terminal-action
          // logic and pre-tool narration paths still work.
          const tc = resp.toolCalls[0]!
          step = {
            thought: '',
            message: resp.content?.trim() ? resp.content.trim() : undefined,
            action: tc.name,
            args: tc.input ?? {},
          }
        } else {
          // No tool call — model returned plain text. Two legitimate patterns:
          //   - Q&A turns where the model answered inline instead of invoking
          //     `reply`. Treat the text as the final reply.
          //   - Truly empty content — surface as an error so the user knows
          //     the prompt or schema is misconfigured rather than seeing a
          //     silent "" return.
          const text = resp.content?.trim() ?? ''
          if (text) {
            this.deps.sendEvent({ type: 'reply', content: text })
            return text
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

      const { message: chatReply, action, args = {} } = step
      step.args = args // normalize undefined to empty object
      lastAction = action
      lastDraftReply = chatReply
      log.info(
        {
          step: i,
          action,
          message: chatReply?.slice(0, 120),
          argsKeys: Object.keys(args),
        },
        'ReAct: synthesized step',
      )

      // --- Terminal actions: exit the loop immediately ---
      if (TERMINAL_ACTIONS.has(action)) {
        // The schema says reply/finish/ask_user carry their text in
        // args.message (or args.question for ask_user). Models still
        // occasionally drift to other field names — accept any of them so a
        // harmless format variation doesn't drop the whole reply. Order:
        // pre-tool prose (chatReply) → args.message → args.question →
        // args.text → args.content.
        const pickString = (v: unknown): string | undefined =>
          typeof v === 'string' && v.trim() ? v : undefined
        const text = action === 'ask_user'
          ? (chatReply ?? pickString(step.args.question) ?? pickString(step.args.message) ?? pickString(step.args.text) ?? '')
          : (chatReply ?? pickString(step.args.message) ?? pickString(step.args.text) ?? pickString(step.args.content) ?? '')
        if (text) {
          this.deps.sendEvent({ type: 'reply', content: text })
        }
        return text
      }

      // Emit the agent's pre-tool narration as a reply so it renders as an
      // AssistantMessage bubble interleaved between tool cards — mimicking
      // Claude Code's pattern of "briefly state what you're about to do".
      if (chatReply && chatReply.trim()) {
        this.deps.sendEvent({ type: 'reply', content: chatReply.trim() })
      }

      // --- Non-terminal action: execute and continue the loop ---
      const observationText = await executeAction(step)

      // null means the action handler already returned a final response
      if (observationText === null)
        return ''

      const observation = observationText
      lastObservation = observation

      // Preserve a compact replay of what the model invoked so the next turn
      // can see its own action chain. With native tool_use there's no
      // "thought" field to preserve — the action+args are the whole story.
      const stepForReplay: Record<string, unknown> = {
        action,
        args: step.args ?? {},
      }
      observations.push({
        action,
        args: step.args ?? {},
        result: observation,
        stepForReplay,
      })
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

    // Compress older observations to save context window.
    // Keep the last OBSERVATION_KEEP_RECENT in full; summarize earlier ones.
    const cutoff = Math.max(0, observations.length - OBSERVATION_KEEP_RECENT)

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i]!
      // Replay the original step so the LLM sees its action chain. With
      // native tool_use we don't yet send tool_use/tool_result content blocks
      // through the gateway type system (CompletionMessage is text-only); we
      // serialize the action+args into the assistant turn as a compact JSON
      // marker. This keeps the model from re-reasoning from scratch each turn
      // while staying within the existing string-content message shape.
      const assistantPayload = obs.stepForReplay ?? { action: obs.action, args: obs.args }
      messages.push({
        role: 'assistant',
        content: JSON.stringify(assistantPayload),
      })

      let resultText = obs.result
      if (i < cutoff) {
        // Older observation — compress to a one-line summary
        resultText = `[Earlier observation] ${obs.action}: ${obs.result.slice(0, 120)}${obs.result.length > 120 ? '...' : ''}`
      } else if (resultText.length > OBSERVATION_MAX_CHARS) {
        // Recent but very long — truncate
        resultText = resultText.slice(0, OBSERVATION_MAX_CHARS) + `\n... (truncated, ${resultText.length} chars total)`
      }

      messages.push({
        role: 'user',
        content: `Observation: ${resultText}`,
      })
    }

    return messages
  }
}
