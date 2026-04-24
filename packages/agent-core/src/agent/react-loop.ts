import { parseLlmJson } from './llm-json.js'
import type {
  LLMGateway,
  CompletionMessage,
} from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common/logging'
import type { DashboardSseEvent, Identity } from '@agentic-obs/common'
import type { IAccessControlService } from './types-permissions.js'
import { estimateMessagesTokens, CONTEXT_WINDOW } from './token-utils.js'

const log = createLogger('react-loop')

/**
 * Safety ceiling on iterations to prevent pathological infinite loops
 * (LLM stuck emitting parse errors, provider returning identical results,
 * etc). This is NOT the normal terminator — under well-behaved operation
 * the LLM emits `reply` / `ask_user` / `finish` long before this is hit.
 * The real budget is tokens (see TOKEN_BUDGET_BYTES below), matching the
 * way Claude Code's loop terminates.
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
 * Distinguish LLM gateway HTTP failures from our own JSON parse errors.
 *
 * Only parse errors should retry in the ReAct loop — they mean "the model
 * answered, we just couldn't decode it, maybe it'll answer cleaner next
 * turn". Any HTTP error from the gateway means the model never responded
 * or the request was rejected; retrying in a tight loop just burns money /
 * quota / time and ends in the same misleading "I have completed"
 * fallback. All of them short-circuit the loop with a user-visible reason.
 *
 * Providers (anthropic.ts / openai.ts / gemini.ts / ollama.ts) throw
 * errors shaped as `"${Provider} API error ${status}: ${body}"`, so a
 * single regex handles all of them. parseLlmJson throws with a
 * "parseLlmJson:" prefix, which never matches.
 */
function classifyLlmError(message: string): { kind: 'fatal'; userMessage: string } | { kind: 'parse' } {
  const apiErr = message.match(/API error (\d+):/i)
  if (!apiErr) {
    return { kind: 'parse' }
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
      let rawContent = ''
      try {
        const resp = await this.deps.gateway.complete(messages, {
          model: this.deps.model,
          maxTokens: 4096,
          temperature: 0,
          responseFormat: 'json',
        })
        rawContent = resp.content
        log.info(
          { step: i, rawLen: rawContent.length, rawHead: rawContent.slice(0, 400) },
          'ReAct: raw LLM response',
        )

        step = parseLlmJson(rawContent) as ReActStep
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)

        // Classify the failure. HTTP errors from the LLM gateway (429 rate
        // limit, 5xx server, auth failures) are NOT the model's fault —
        // retrying them in a tight loop just hammers the provider, burns
        // quota, and returns the same error. Bail out with a user-facing
        // message instead of spinning through MAX_ITERATIONS.
        const classification = classifyLlmError(msg)
        if (classification.kind === 'fatal') {
          log.warn({ step: i, err: msg }, 'LLM gateway error — aborting loop')
          this.deps.sendEvent({ type: 'error', message: classification.userMessage })
          this.deps.sendEvent({ type: 'reply', content: classification.userMessage })
          return classification.userMessage
        }

        // Forgiving fallback: if the model returned plain prose with no
        // JSON-shaped tokens, accept it as the direct user-facing reply.
        // Covers two legitimate patterns:
        //   - Q&A turns where the model answers inline instead of emitting
        //     {action: 'reply', message: '...'}.
        //   - Post-action wrap-ups where the model narrates "done" in prose.
        // Retrying these just burns iterations and ends in the generic
        // "I have completed the requested changes" fallback.
        const looksLikeJson = /[{[]/.test(rawContent)
        if (rawContent.trim() && !looksLikeJson) {
          const finalReply = rawContent.trim()
          this.deps.sendEvent({ type: 'reply', content: finalReply })
          return finalReply
        }

        // True parse failure (malformed JSON attempt) — surface it to the
        // next turn so the model sees what went wrong and can self-correct.
        log.warn({ step: i, err: msg }, 'LLM returned non-JSON — retrying')
        observations.push({
          action: 'parse_error',
          args: {},
          result: `Your previous response was not valid JSON. Return ONLY the JSON object, no prose, no markdown fence. Error: ${msg}`,
        })
        continue
      }

      const { message: chatReply, action, args = {} } = step
      step.args = args // normalize undefined to empty object
      lastAction = action
      lastDraftReply = chatReply
      log.info(
        {
          step: i,
          action,
          thought: step.thought?.slice(0, 120),
          message: chatReply?.slice(0, 120),
          argsKeys: Object.keys(args),
          allFields: Object.keys(step as unknown as Record<string, unknown>),
        },
        'ReAct: parsed step',
      )

      // --- Terminal actions: exit the loop immediately ---
      if (TERMINAL_ACTIONS.has(action)) {
        const text = action === 'ask_user'
          ? (chatReply ?? (typeof step.args.question === 'string' ? step.args.question : ''))
          : (chatReply ?? (typeof step.args.text === 'string' ? step.args.text : ''))
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

      // Preserve the full step shape as the LLM produced it (reasoning,
      // chain-of-thought, any extra fields), minus `message` — that's the
      // user-facing narration and replaying it tempts the model to parrot
      // itself verbatim on the next turn.
      const { message: _omitMessage, ...stepForReplay } = step as unknown as Record<string, unknown>
      void _omitMessage
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
      // Replay the original step (thought + action + args + any extras)
      // minus the user-facing `message`. This preserves the reasoning
      // chain the LLM built up, so it doesn't re-reason from scratch on
      // every turn and repeat itself.
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
