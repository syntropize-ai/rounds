import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common/logging'
import { agentRegistry } from './agent-registry.js'
import { GENERATION_PRINCIPLES, buildGroundingContext } from './system-context.js'
import type { IMetricsAdapter } from '../adapters/index.js'
import type { AlertCondition, AlertSeverity } from '@agentic-obs/common'

const log = createLogger('alert-rule-agent')

interface AlertRuleAgentDeps {
  gateway: LLMGateway
  model: string
  metrics?: IMetricsAdapter
}

interface GeneratedAlertRule {
  name: string
  description: string
  condition: AlertCondition
  evaluationIntervalSec: number
  severity: AlertSeverity
  labels: Record<string, string>
  autoInvestigate: boolean
}

export interface AlertRuleGenerationResult {
  rule: GeneratedAlertRule
}

export interface AlertRuleContext {
  dashboardId?: string
  dashboardTitle?: string
  /** PromQL queries already in use on the dashboard - the alert should use consistent queries */
  existingQueries?: string[]
  /** Dashboard variables (e.g. namespace, instance) */
  variables?: Array<{ name: string, value?: string }>
}

export class AlertRuleAgent {
  static readonly definition = agentRegistry.get('alert-rule-builder')!;

  constructor(private deps: AlertRuleAgentDeps) {}

  async generate(prompt: string, context?: AlertRuleContext): Promise<AlertRuleGenerationResult> {
    // Step 1: Discover available metrics (if adapter available)
    let metricsContext = ''
    if (this.deps.metrics) {
      try {
        const allNames = await this.deps.metrics.listMetricNames()
        metricsContext = buildGroundingContext({
          discoveredMetrics: allNames.slice(0, 200),
        })
      }
      catch {
        // Ignore - proceed without metric list
      }
    }

    // Build dashboard context section
    let dashboardContext = ''
    if (context?.existingQueries?.length) {
      dashboardContext += '\n## Dashboard Context\n'
      if (context.dashboardTitle)
        dashboardContext += `Dashboard: "${context.dashboardTitle}"\n`
      dashboardContext += 'The following PromQL queries are already in use on this dashboard.\n'
      dashboardContext += 'PREFER reusing these queries or their metric names/label selectors for consistency:\n'
      dashboardContext += `${context.existingQueries.map((q) => `- "${q}"`).join('\n')}\n`
      if (context.variables?.length) {
        dashboardContext += `\nDashboard variables:\n${context.variables.map((v) => `- ${v.name}${v.value ? `="${v.value}"` : ''}`).join('\n')}\n`
      }
    }

    // Step 2: LLM generates the alert rule
    const systemPrompt = `You are a Prometheus alerting expert. Given a natural language description, generate a structured alert rule.
${GENERATION_PRINCIPLES}
${metricsContext}${dashboardContext}

## PromQL Syntax Reference (use ONLY with discovered metrics)

These are syntax patterns, NOT metric names to copy:
- Counter rate: rate(METRIC_total[5m])
- Histogram percentile: histogram_quantile(0.99, sum(rate(METRIC_bucket[5m])) by (le))
- Ratio: sum(rate(A[5m])) / sum(rate(B[5m]))

Replace METRIC with actual discovered metric names. Do NOT use these example metric names directly.

## Rules
1. The query MUST be a valid PromQL expression that returns a scalar or single-element vector.
2. Choose appropriate operator and threshold based on the user's intent.
3. Set forDurationSec to prevent transient spikes (typically 120-300s for non-critical, 0-60s for critical).
4. Set severity from the user's language (urgent/critical -> critical, important -> high, etc.). Default to medium.
5. Set evaluationIntervalSec: 15-30s for critical, 60s for high/medium, 300s for low.
6. Set autoInvestigate to true if the user implies they want automatic investigation when the alert fires.
7. Generate meaningful labels: at minimum include "source", "user" and any service/component labels.

## Output Format

Return ONLY valid JSON:
{
  "name": "Short descriptive name",
  "description": "Human-readable description of what this alert detects and why it matters",
  "condition": {
    "query": "PromQL expression",
    "operator": ">" | "<" | ">=" | "<=" | "==",
    "threshold": 0
  },
  "forDurationSec": 120,
  "evaluationIntervalSec": 60,
  "severity": "critical" | "high" | "medium" | "low",
  "labels": { "source": "user", ... },
  "autoInvestigate": true
}`

    const resp = await this.deps.gateway.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], {
      model: this.deps.model,
      maxTokens: 1024,
      temperature: 0,
      responseFormat: 'json',
    })

    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
    // Extract the first complete JSON object - LLM sometimes appends explanatory text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch)
      throw new Error('LLM did not return valid JSON for alert rule')
    const generated = JSON.parse(jsonMatch[0]) as GeneratedAlertRule

    // Step 3: Validate query against Prometheus
    let finalRule = generated
    if (this.deps.metrics) {
      try {
        const testResult = await this.deps.metrics.testQuery(generated.condition.query)
        if (!testResult.ok) {
          // Query failed - ask LLM to fix
          const fixResp = await this.deps.gateway.complete([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
            { role: 'assistant', content: cleaned },
            { role: 'user', content: `The PromQL query "${generated.condition.query}" failed validation against Prometheus: ${testResult.error ?? 'unknown error'}. Please fix the query and return the complete JSON again.` },
          ], {
            model: this.deps.model,
            maxTokens: 1024,
            temperature: 0,
            responseFormat: 'json',
          })

          const fixedCleaned = fixResp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim()
          const fixedMatch = fixedCleaned.match(/\{[\s\S]*\}/)
          if (!fixedMatch)
            throw new Error('LLM did not return valid JSON for alert rule fix')
          finalRule = JSON.parse(fixedMatch[0]) as GeneratedAlertRule
        }
      }
      catch {
        // Validation failed but non-fatal - return original
      }
    }

    return { rule: finalRule }
  }
}
