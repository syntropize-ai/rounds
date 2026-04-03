import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type { AlertCondition, AlertSeverity } from '@agentic-obs/common'

interface AlertRuleAgentDeps {
  gateway: LLMGateway
  model: string
  prometheusUrl: string | undefined
  prometheusHeaders: Record<string, string>
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

export interface AlertRuleContext {
  dashboardId?: string
  dashboardTitle?: string
  /** PromQL queries already in use on the dashboard - the alert should use consistent queries */
  existingQueries?: string[]
  /** Dashboard variables (e.g. namespace, instance) */
  variables?: Array<{ name: string, value?: string }>
}

export class AlertRuleAgent {
  constructor(private deps: AlertRuleAgentDeps) {}

  async generate(prompt: string, context?: AlertRuleContext): Promise<GeneratedAlertRule> {
    // Step 1: Discover available metrics (if Prometheus available)
    let availableMetrics = ''
    if (this.deps.prometheusUrl) {
      try {
        const resp = await fetch(`${this.deps.prometheusUrl}/api/v1/label/__name__/values`, {
          headers: this.deps.prometheusHeaders,
        })
        if (resp.ok) {
          const data = await resp.json() as { data?: string[] }
          const metrics = (data.data ?? []).slice(0, 200)
          availableMetrics = `\n## Available Prometheus Metrics (sample)\n${metrics.join(', ')}`
        }
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
${availableMetrics}${dashboardContext}

## PromQL Patterns

Common patterns for alert conditions:
- Error rate: "rate(http_requests_total{code=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100"
- Latency: "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))"
- CPU usage: "100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)"
- Memory: "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100"
- Disk: "(1 - node_filesystem_avail_bytes / node_filesystem_size_bytes) * 100"
- Pod restarts: "increase(kube_pod_container_status_restarts_total[5m])"
- SLO burn rate: "(rate(http_requests_total{code!~"5.."}[1h]) / rate(http_requests_total[1h]))"

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
    if (this.deps.prometheusUrl) {
      try {
        const testUrl = `${this.deps.prometheusUrl}/api/v1/query?query=${encodeURIComponent(generated.condition.query)}`
        const testResp = await fetch(testUrl, { headers: this.deps.prometheusHeaders })
        if (!testResp.ok) {
          // Query failed - ask LLM to fix
          const fixResp = await this.deps.gateway.complete([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
            { role: 'assistant', content: cleaned },
            { role: 'user', content: `The PromQL query "${generated.condition.query}" failed validation against Prometheus (status ${testResp.status}). Please fix the query and return the complete JSON again.` },
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
          const fixed = JSON.parse(fixedMatch[0]) as GeneratedAlertRule
          return fixed
        }
      }
      catch {
        // Validation failed but non-fatal - return original
      }
    }

    return generated
  }
}
