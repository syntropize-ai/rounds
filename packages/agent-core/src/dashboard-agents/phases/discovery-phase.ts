import { parseLlmJson } from '../llm-json.js'
import { createLogger } from '@agentic-obs/common'
import type { ResearchResult } from '../research-agent.js'
import { GENERATION_PRINCIPLES, buildGroundingContext } from '../system-context.js'

const log = createLogger('discovery-phase')
import type { DiscoveryResult } from '../discovery-agent.js'
import type {
  GeneratorDeps,
  GenerateInput,
  DashboardPlan,
} from '../types.js'

export class DiscoveryPhase {
  constructor(private deps: GeneratorDeps) {}

  // Planner: decompose goal into panel groups
  async plan(
    input: GenerateInput,
    research?: ResearchResult,
    discovery?: DiscoveryResult,
  ): Promise<DashboardPlan> {
    const scopePlanningGuidance: Record<'single' | 'group' | 'comprehensive' | 'auto', string> = {
      single: `- SINGLE scope: plan the smallest useful answer.
- Stay tightly focused on the specific signals or questions the user named.
- Do NOT add breakdown/detail sections unless they are necessary to answer the request.`,
      group: `- GROUP scope: plan a focused dashboard, not a platform-wide overview.
- Include supporting sections only when they directly strengthen the requested view.
- Do NOT add unrelated reliability, infra, or deep-detail sections unless explicitly requested.`,
      comprehensive: `- COMPREHENSIVE scope: it is appropriate to build a broader dashboard.
- Multiple sections are allowed when they are all relevant to the request.
- Use overview -> trends -> breakdowns -> detail sections only when they materially improve the requested dashboard.
- Even in comprehensive mode, do not introduce unrelated metric families.`,
      auto: `- AUTO scope: infer the right breadth from the user's intent and the available data.
- First decide whether the user is asking for an operator's first-look dashboard or a deeper analytical/dashboard-expansion view.
- For a first-look dashboard, include only the core panels needed to judge health quickly.
- For a deeper analytical view, broader supporting sections are appropriate when they materially improve the answer.
- Do not expand the dashboard just because more metrics exist.`,
    }
    const scopeMode = input.scope ?? 'auto'

    const researchContext = research
      ? `\n## Research Context (from web search)\nMonitoring approach: ${research.monitoringApproach}\nKey metrics: ${research.keyMetrics.join(', ')}\nBest practices: ${research.bestPractices.join(', ')}\n`
      : ''

    const metricsContext = discovery
      ? buildGroundingContext({
          discoveredMetrics: discovery.metrics,
          labelsByMetric: discovery.labelsByMetric,
          sampleValues: discovery.sampleValues,
          metadataByMetric: discovery.metadataByMetric,
        })
      : ''

    const existingContext = input.existingPanels.length
      ? `\n## Existing Panels (do NOT duplicate)\n${input.existingPanels.map((p) => `- ${p.title}`).join('\n')}\n`
      : ''

    const systemPrompt = `You are a senior SRE planning a monitoring dashboard.
${GENERATION_PRINCIPLES}

## Task
Decompose the monitoring goal into logical panel GROUPS. Each group is a section of the dashboard.
${researchContext}${metricsContext}${existingContext}

## Planning Rules
1. Use your expertise to determine the right monitoring methodology (RED, USE, 4 Golden Signals, or custom) based on the technology.
2. The dashboard structure must match the user's requested breadth. Do NOT default to a full observability template.
3. Panel count is determined by what the user asked and what data exists. No fixed targets.
4. Each panel spec needs a queryIntent (natural language description of the query).
5. Only introduce sections, supporting signals, or metric families that are directly necessary to answer the user's request.
6. Before creating sections, identify the distinct THEMES in the user's request (for example: business outcomes, application behavior, platform/dependency health). Group panels by theme first, then create sections from those themes.
7. A panel must belong to the section that best matches its primary theme. Do NOT place platform/dependency panels inside business sections, and do NOT place business outcome panels inside platform sections.
8. Avoid duplicate coverage within a theme. If two candidate panels express nearly the same signal at the same level of detail, keep the clearer one instead of including both.
9. When the request mixes business and platform concerns, prefer a small number of representative panels per theme instead of exhausting one theme before covering the other.
10. For broad subjects like Redis, Postgres, gateway, worker, or service health, do NOT assume the user wants a full exporter or deep-dive dashboard. Start by identifying the core signals that best answer "is this healthy?" or "what should I look at first?"
11. Distinguish CORE panels from EXTENDED panels in your reasoning. CORE panels are the smallest set needed for a good first-look dashboard. EXTENDED panels are drill-down, exporter-detail, or specialist diagnostics.
12. Unless the user's intent is clearly exploratory, exhaustive, or diagnostic, plan only CORE panels and omit EXTENDED panels.
13. For first-look health dashboards, prefer a small number of representative sections and representative panels within each section. Do not create extra sections or second-order detail panels once the core health questions are already covered.

## Scope-Specific Planning Guidance
${scopePlanningGuidance[scopeMode]}

## Output Format (JSON)
{
  "title": "Dashboard Title",
  "description": "What this dashboard monitors",
  "groups": [
    {
      "id": "overview",
      "label": "Overview",
      "purpose": "Key health indicators at a glance",
      "panelSpecs": []
    }
  ],
  "variables": [
    { "name": "namespace", "label": "Namespace", "purpose": "Filter by namespace" }
  ]
}`

    // Retry up to 2 times on JSON parse failure
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await this.deps.gateway.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Goal: ${input.goal}\nScope hint: ${input.scope ?? 'unspecified - decide breadth from the request itself'}` },
        ], {
          model: this.deps.model,
          maxTokens: 8192,
          temperature: 0.1,
          responseFormat: 'json',
        })

        const parsed = parseLlmJson(resp.content) as DashboardPlan

        return {
          title: parsed.title ?? input.goal,
          description: parsed.description ?? '',
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
          variables: Array.isArray(parsed.variables) ? parsed.variables : [],
        }
      }
      catch (err) {
        log.warn({ err, attempt: attempt + 1 }, 'planner attempt failed')
        if (attempt === 1)
          throw err
        this.deps.sendEvent?.({ type: 'thinking', content: 'Planner returned invalid JSON - retrying...' })
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new Error('Planner failed after retries')
  }
}
