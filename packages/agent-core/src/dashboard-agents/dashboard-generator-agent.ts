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
    // Pre-calculate start rows so groups can run in parallel
    const groupStartRows: number[] = []
    let estimatedRow = 0
    for (const group of plan.groups) {
      groupStartRows.push(estimatedRow)
      const estimatedHeight = group.panelSpecs.reduce((h, s) => {
        if (s.visualization === 'stat')
          return Math.max(h, 2)
        return h + (s.height ?? 3)
      }, 0)
      estimatedRow += Math.max(2, estimatedHeight)
    }

    sendEvent?.({ type: 'thinking', content: `Generating ${plan.groups.length} sections in parallel...` })

    let completedGroups = 0
    const totalGroups = plan.groups.length

    const groupResults = await Promise.all(
      plan.groups.map((group, i) =>
        this.generation.generateAndCriticLoop(
          group,
          input,
          researchResult,
          discoveryResult,
          groupStartRows[i] ?? 0,
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
    if (this.deps.prometheusUrl) {
      const { PanelValidator } = await import('./panel-validator.js')
      const validator = new PanelValidator(
        this.deps.gateway,
        this.deps.model,
        this.deps.prometheusUrl,
        this.deps.prometheusHeaders ?? {},
        this.deps.sendEvent,
      )
      validated = await validator.validateAndCorrect(
        allPanels as any,
        discoveryResult?.metrics ?? [],
      )
    } else {
      validated = allPanels
    }

    // Step 5: Detect variables
    const variables = this.generation.detectVariables(validated, input, discoveryResult)

    return {
      title: plan.title,
      description: plan.description,
      panels: validated,
      variables,
    }
  }
}
