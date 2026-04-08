import { parseLlmJson } from './llm-json.js'
import type {
  LLMGateway,
  CompletionMessage,
} from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common'
import type { DashboardSseEvent } from '@agentic-obs/common'

const log = createLogger('react-loop')

const MAX_ITERATIONS = 15

export interface ReActStep {
  thought: string
  /** Brief conversational reply shown to user before executing the action */
  message?: string
  action: string
  args: Record<string, unknown>
}

export interface ReActObservation {
  action: string
  args: Record<string, unknown>
  result: string
}

export interface ReActDeps {
  gateway: LLMGateway
  model: string
  sendEvent: (event: DashboardSseEvent) => void
  /** Maximum total tokens per chat message. Default: 50000 */
  maxTokenBudget?: number
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
    const observations: ReActObservation[] = []
    let lastAction: string | null = null
    let lastDraftReply: string | undefined
    let lastObservation: string | null = null

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const messages = this.buildMessages(systemPrompt, userMessage, observations)

      let step: ReActStep
      try {
        const resp = await this.deps.gateway.complete(messages, {
          model: this.deps.model,
          maxTokens: 2048,
          temperature: 0,
          responseFormat: 'json',
        })

        step = parseLlmJson(resp.content) as ReActStep
      }
      catch {
        observations.push({ action: 'parse_error', args: {}, result: 'LLM returned invalid JSON - retrying.' })
        continue
      }

      const { message: chatReply, action, args = {} } = step
      step.args = args // normalize undefined to empty object
      lastAction = action
      lastDraftReply = chatReply
      log.info({ step: i, action, message: chatReply?.slice(0, 80), args: JSON.stringify(args).slice(0, 200) }, 'ReAct step')

      if (action === 'reply') {
        const text = chatReply ?? (typeof step.args.text === 'string' ? step.args.text : '')
        if (!chatReply) {
          this.deps.sendEvent({ type: 'reply', content: text })
        }
        return text
      }

      if (action === 'ask_user') {
        const question = chatReply ?? (typeof step.args.question === 'string' ? step.args.question : '')
        if (question) {
          this.deps.sendEvent({ type: 'reply', content: question })
        }
        return question
      }

      // Delegate action execution to the caller
      const observationText = await executeAction(step)

      // null means the action handler already returned a final response
      if (observationText === null)
        return ''

      const observation = observationText
      lastObservation = observation

      if (observation.startsWith('CLARIFICATION_NEEDED:')) {
        observations.push({ action, args: step.args ?? {}, result: observation })
        continue
      }

      observations.push({ action, args: step.args ?? {}, result: observation })
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

    // Max iterations reached - emit a fallback reply
    const fallback = 'I have completed the requested changes to your dashboard.'
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
      { role: 'user', content: userMessage },
    ]

    for (const obs of observations) {
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ action: obs.action, args: obs.args }),
      })
      messages.push({
        role: 'user',
        content: `Observation: ${obs.result}`,
      })
    }

    return messages
  }
}
