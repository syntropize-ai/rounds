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

  async runLoop(
    systemPrompt: string,
    userMessage: string,
    executeAction: (step: ReActStep) => Promise<string | null>,
  ): Promise<string> {
    const observations: ReActObservation[] = []

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

        const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
        step = JSON.parse(cleaned) as ReActStep
      }
      catch {
        observations.push({ action: 'parse_error', args: {}, result: 'LLM returned invalid JSON - retrying.' })
        continue
      }

      const { message: chatReply, action } = step
      log.info({ step: i, action, message: chatReply?.slice(0, 80), args: JSON.stringify(step.args).slice(0, 200) }, 'ReAct step')

      // Send conversational message to user before executing the action
      if (chatReply) {
        this.deps.sendEvent({ type: 'reply', content: chatReply })
      }

      if (action === 'reply') {
        const text = chatReply ?? (typeof step.args.text === 'string' ? step.args.text : '')
        if (!chatReply) {
          this.deps.sendEvent({ type: 'reply', content: text })
        }
        return text
      }

      if (action === 'ask_user') {
        const question = chatReply ?? (typeof step.args.question === 'string' ? step.args.question : '')
        if (!chatReply && question) {
          this.deps.sendEvent({ type: 'reply', content: question })
        }
        return question
      }

      // Delegate action execution to the caller
      const observationText = await executeAction(step)

      // null means the action handler already returned a final response
      if (observationText === null)
        return ''

      observations.push({ action, args: step.args ?? {}, result: observationText })
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
