import type { LLMGateway, ToolDefinition } from '@agentic-obs/llm-gateway'
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

/**
 * Internal tool the alert-rule generator forces the LLM to call. We treat the
 * tool's `input` as the structured rule payload — this replaces the old
 * "return JSON in prose, regex it out" path. Required fields mirror the
 * GeneratedAlertRule shape; the LLM cannot omit them because the schema
 * marks them required.
 */
const EMIT_ALERT_RULE_TOOL: ToolDefinition = {
  name: 'emit_alert_rule',
  description:
    'Emit the structured alert rule. Call this exactly once with the full rule payload. Do not return prose — the rule fields must come through the tool input.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short descriptive rule name' },
      description: {
        type: 'string',
        description: 'Human-readable description of what this alert detects and why it matters',
      },
      condition: {
        type: 'object',
        description: 'PromQL condition: query, comparison operator, threshold, and dwell time',
        properties: {
          query: { type: 'string', description: 'Valid PromQL expression returning a scalar or single-element vector' },
          operator: {
            type: 'string',
            enum: ['>', '<', '>=', '<=', '=='],
            description: 'Comparison operator',
          },
          threshold: { type: 'number', description: 'Numeric threshold the operator compares against' },
          forDurationSec: {
            type: 'number',
            description: 'Seconds the condition must hold before firing (typically 120-300 for non-critical, 0-60 for critical)',
          },
        },
        required: ['query', 'operator', 'threshold', 'forDurationSec'],
      },
      evaluationIntervalSec: {
        type: 'number',
        description: 'Evaluation cadence (15-30s for critical, 60s for high/medium, 300s for low)',
      },
      severity: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low'],
        description: 'Severity inferred from the user wording',
      },
      labels: {
        type: 'object',
        description: 'Labels attached to the rule (at minimum include "source" and "user")',
      },
      autoInvestigate: {
        type: 'boolean',
        description: 'True if the user wants automatic investigation when the alert fires',
      },
    },
    required: [
      'name',
      'description',
      'condition',
      'evaluationIntervalSec',
      'severity',
      'labels',
      'autoInvestigate',
    ],
  },
}

function inputToRule(input: Record<string, unknown>): GeneratedAlertRule {
  const condition = (input.condition ?? {}) as Record<string, unknown>
  return {
    name: String(input.name ?? ''),
    description: String(input.description ?? ''),
    condition: {
      query: String(condition.query ?? ''),
      operator: condition.operator as AlertCondition['operator'],
      threshold: Number(condition.threshold ?? 0),
      forDurationSec: Number(condition.forDurationSec ?? 0),
    },
    evaluationIntervalSec: Number(input.evaluationIntervalSec ?? 60),
    severity: input.severity as AlertSeverity,
    labels: (input.labels as Record<string, string>) ?? {},
    autoInvestigate: input.autoInvestigate === true,
  }
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

    // Step 2: LLM emits the alert rule via the emit_alert_rule tool
    const systemPrompt = `You are a Prometheus alerting expert. Given a natural language description, generate a structured alert rule by calling the emit_alert_rule tool exactly once.
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

Call emit_alert_rule with the complete payload — the schema enforces every required field.`

    const resp = await this.deps.gateway.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], {
      model: this.deps.model,
      maxTokens: 1024,
      temperature: 0,
      tools: [EMIT_ALERT_RULE_TOOL],
      toolChoice: { type: 'tool', name: 'emit_alert_rule' },
    })

    const firstCall = resp.toolCalls[0]
    if (!firstCall || firstCall.name !== 'emit_alert_rule') {
      log.warn({ hasCall: !!firstCall, name: firstCall?.name, content: resp.content?.slice(0, 200) }, 'alert-rule-builder: model did not emit the expected tool call')
      throw new Error('LLM did not emit an alert rule via the emit_alert_rule tool')
    }
    const generated = inputToRule(firstCall.input)

    // Step 3: Validate query against Prometheus
    let finalRule = generated
    if (this.deps.metrics) {
      try {
        const testResult = await this.deps.metrics.testQuery(generated.condition.query)
        if (!testResult.ok) {
          // Query failed - ask LLM to fix. Re-emit via the same forced tool
          // call so the response shape is identical to the first attempt.
          const fixResp = await this.deps.gateway.complete([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
            { role: 'assistant', content: `(previous attempt: ${generated.condition.query})` },
            { role: 'user', content: `The PromQL query "${generated.condition.query}" failed validation against Prometheus: ${testResult.error ?? 'unknown error'}. Please fix the query and call emit_alert_rule again with the corrected payload.` },
          ], {
            model: this.deps.model,
            maxTokens: 1024,
            temperature: 0,
            tools: [EMIT_ALERT_RULE_TOOL],
            toolChoice: { type: 'tool', name: 'emit_alert_rule' },
          })

          const fixCall = fixResp.toolCalls[0]
          if (!fixCall || fixCall.name !== 'emit_alert_rule') {
            throw new Error('LLM did not emit a fixed alert rule via the emit_alert_rule tool')
          }
          finalRule = inputToRule(fixCall.input)
        }
      }
      catch {
        // Validation failed but non-fatal - return original
      }
    }

    return { rule: finalRule }
  }
}
