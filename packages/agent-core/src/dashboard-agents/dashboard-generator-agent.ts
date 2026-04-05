import type {
  PanelConfig,
} from '@agentic-obs/common'
import type {
  GeneratorDeps,
  GenerateInput,
  GenerateOutput,
} from './types.js'
import { agentRegistry } from '../runtime/agent-registry.js'
import { ResearchPhase } from './phases/research-phase.js'
import { DiscoveryPhase } from './phases/discovery-phase.js'
import { GenerationPhase } from './phases/generation-phase.js'
import { applyLayout } from './layout-engine.js'

export class DashboardGeneratorAgent {
  static readonly definition = agentRegistry.get('dashboard-builder')!;

  private readonly research: ResearchPhase
  private readonly discovery: DiscoveryPhase
  private readonly generation: GenerationPhase

  constructor(private deps: GeneratorDeps) {
    this.research = new ResearchPhase(deps)
    this.discovery = new DiscoveryPhase(deps)
    this.generation = new GenerationPhase(deps)
  }

  async generate(
    input: GenerateInput,
    onGroupComplete?: (panels: PanelConfig[]) => void | Promise<void>,
  ): Promise<GenerateOutput> {
    const { sendEvent } = this.deps

    // Step 0/1: Research + Discovery in parallel
    const { research: researchResult, discovery: discoveryResult } = await this.research.run(input)

    // If Prometheus is connected but discovery found 0 relevant metrics,
    // surface a clarification signal instead of generating from guesswork.
    if (
      this.deps.metrics
      && discoveryResult
      && discoveryResult.metrics.length === 0
      && discoveryResult.totalMetrics > 0
    ) {
      sendEvent?.({
        type: 'tool_result',
        tool: 'discover',
        summary: `No relevant metrics found for "${input.goal}" — requesting clarification`,
        success: false,
      })

      return {
        title: '',
        description: '',
        panels: [],
        variables: [],
        needsClarification: {
          searchedFor: input.goal,
          totalMetricsInPrometheus: discoveryResult.totalMetrics,
          candidateMetrics: discoveryResult.candidateMetrics ?? [],
        },
      }
    }

    // Step 2: Planner
    sendEvent?.({
      type: 'tool_call',
      tool: 'planner',
      args: { goal: input.goal },
      displayText: 'Planning dashboard structure',
    })

    const plan = await this.discovery.plan(input, researchResult, discoveryResult)
    sendEvent?.({
      type: 'tool_result',
      tool: 'planner',
      summary: `Planned ${plan.groups.length} sections, ~${plan.groups.reduce((n, g) => n + g.panelSpecs.length, 0)} panels`,
      success: true,
    })

    // Step 3: Generate + Critic per group (parallel)
    sendEvent?.({ type: 'thinking', content: `Generating ${plan.groups.length} sections in parallel...` })

    let completedGroups = 0
    const totalGroups = plan.groups.length

    const groupResults = await Promise.all(
      plan.groups.map((group) =>
        this.generation.generateAndCriticLoop(
          group,
          plan.groups,
          plan.variables,
          input,
          researchResult,
          discoveryResult,
        ).then(async (panels) => {
          const tagged = panels.map((p) => ({ ...p, sectionId: group.id, sectionLabel: group.label }))
          completedGroups++
          sendEvent?.({
            type: 'tool_result',
            tool: 'build_progress',
            summary: `${completedGroups}/${totalGroups} sections - "${group.label}" (${tagged.length} panels)`,
            success: true,
          })
          if (onGroupComplete && tagged.length > 0) {
            await onGroupComplete(tagged)
          }
          return tagged
        }),
      ),
    )

    const allPanels: PanelConfig[] = groupResults.flat()

    // Step 4: Validate & fix queries against Prometheus (if available)
    let validated: PanelConfig[]
    if (this.deps.metrics) {
      const { PanelValidator } = await import('./panel-validator.js')
      const validator = new PanelValidator(
        this.deps.gateway,
        this.deps.model,
        this.deps.metrics,
        this.deps.sendEvent,
      )
      validated = await validator.validateAndCorrect(
        allPanels as any,
        discoveryResult?.metrics ?? [],
      )
    } else {
      validated = allPanels
    }

    // Step 5: Apply deterministic layout
    const laidOut = applyLayout(validated)

    // Step 6: Detect variables
    const variables = this.generation.detectVariables(laidOut, input, discoveryResult)

    return {
      title: plan.title,
      description: plan.description,
      panels: laidOut,
      variables,
    }
  }
}
