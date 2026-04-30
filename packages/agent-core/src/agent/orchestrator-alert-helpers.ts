import type { DashboardMessage } from '@agentic-obs/common'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type { ReActStep } from './react-loop.js'

/** Summary of an existing alert rule — used for follow-up intent detection. */
export interface AlertRuleSummary {
  id: string
  name: string
  severity: string
  condition: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export function getStructuredAlertRuleContext(
  history: DashboardMessage[],
  alertRules: AlertRuleSummary[],
): AlertRuleSummary | null {
  if (alertRules.length === 0) return null

  const byId = new Map(alertRules.map((rule) => [rule.id, rule]))

  for (const message of [...history].reverse()) {
    const actions = message.actions ?? []
    for (const action of [...actions].reverse()) {
      if (
        action.type === 'create_alert_rule'
        || action.type === 'modify_alert_rule'
        || action.type === 'delete_alert_rule'
      ) {
        const match = byId.get(action.ruleId)
        if (match) return match
      }
    }
  }

  return null
}

export function buildStructuredAlertHistory(history: DashboardMessage[]): string {
  const entries: string[] = []

  for (const message of history.slice(-10)) {
    const actions = message.actions ?? []
    for (const action of actions) {
      if (action.type === 'create_alert_rule') {
        entries.push(`- Assistant created alert [${action.ruleId}] "${action.name}" (${action.severity}) - ${action.query} ${action.operator} ${action.threshold}`)
      }
      else if (action.type === 'modify_alert_rule') {
        entries.push(`- Assistant modified alert [${action.ruleId}] with patch ${JSON.stringify(action.patch)}`)
      }
      else if (action.type === 'delete_alert_rule') {
        entries.push(`- Assistant deleted alert [${action.ruleId}]${action.name ? ` "${action.name}"` : ''}`)
      }
    }
  }

  return entries.join('\n')
}

export function parseAlertFollowUpAction(
  message: string,
  activeAlertRule: AlertRuleSummary | null,
): ReActStep | null {
  if (!activeAlertRule) return null

  const trimmed = message.trim()
  if (!trimmed) return null

  if (/(^|\b)(delete|remove|drop|get rid of)\b/.test(trimmed)) {
    return {
      thought: 'Structured alert follow-up delete',
      action: 'alert_rule_write',
      args: { op: 'delete', ruleId: activeAlertRule.id },
    }
  }

  const thresholdMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i)
  const hasModifyIntent = /(change|update|make|set|adjust|modify)/i.test(trimmed)
    || /alert me|notify me|warn me|tell me/i.test(trimmed)
    || thresholdMatch !== null

  if (!hasModifyIntent || !thresholdMatch) return null

  const numericValue = Number(thresholdMatch[1])
  if (!Number.isFinite(numericValue)) return null

  const unit = (thresholdMatch[2] ?? '').toLowerCase()
  const normalizedThreshold =
    unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'seconds'
      ? numericValue * 1000
      : unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minutes'
        ? numericValue * 60 * 1000
        : numericValue

  const patch: Record<string, unknown> = { threshold: normalizedThreshold }
  if (/less than|below|under/i.test(trimmed)) patch.operator = '<'
  if (/at most|no more than/i.test(trimmed)) patch.operator = '<='
  if (/at least|not less than/i.test(trimmed)) patch.operator = '>='
  if (/more than|greater than|over|above|exceed/i.test(trimmed)) patch.operator = '>'

  return {
    thought: 'Structured alert follow-up modify',
    action: 'alert_rule_write',
    args: {
      op: 'update',
      ruleId: activeAlertRule.id,
      patch,
    },
  }
}

export async function composeAlertFollowUpReply(
  gateway: LLMGateway,
  model: string,
  userMessage: string,
  action: ReActStep,
  observationText: string,
): Promise<string> {
  try {
    const resp = await gateway.complete([
      {
        role: 'system',
        content: 'You are writing a short assistant reply for an observability dashboard chat. The requested action has already succeeded. Reply in one natural sentence. Do not mention tool names, internal IDs, or implementation details.',
      },
      {
        role: 'user',
        content: `User request: ${userMessage}\nExecuted action: ${action.action}\nResult: ${observationText}`,
      },
    ], {
      model,
      maxTokens: 80,
      temperature: 0.2,
    })

    const text = resp.content.trim()
    if (text) return text
  }
  catch {
    // Fall back to the execution summary below.
  }

  return observationText
}
