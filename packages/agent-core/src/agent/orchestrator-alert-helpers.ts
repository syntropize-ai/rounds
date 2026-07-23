import type { DashboardMessage } from '@agentic-obs/common'

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

export function buildStructuredAlertHistory(
  history: DashboardMessage[],
  currentAlertRules: AlertRuleSummary[] = [],
): string {
  const entries: string[] = []
  const currentRuleIds = new Set(currentAlertRules.map((rule) => rule.id))

  for (const message of history.slice(-10)) {
    const actions = message.actions ?? []
    for (const action of actions) {
      if (action.type === 'create_alert_rule') {
        if (!currentRuleIds.has(action.ruleId)) continue
        entries.push(`- Assistant created alert [${action.ruleId}] "${action.name}" (${action.severity}) - ${action.query} ${action.operator} ${action.threshold}`)
      }
      else if (action.type === 'modify_alert_rule') {
        if (!currentRuleIds.has(action.ruleId)) continue
        entries.push(`- Assistant modified alert [${action.ruleId}] with patch ${JSON.stringify(action.patch)}`)
      }
      else if (action.type === 'delete_alert_rule') {
        entries.push(`- Assistant deleted alert [${action.ruleId}]${action.name ? ` "${action.name}"` : ''}`)
      }
    }
  }

  return entries.join('\n')
}
