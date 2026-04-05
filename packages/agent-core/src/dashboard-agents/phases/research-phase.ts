import { parseLlmJson } from '../llm-json.js'
import { createLogger } from '@agentic-obs/common'
import type { DiscoveryResult } from '../discovery-agent.js'

const log = createLogger('research-phase')
import { ResearchAgent, type ResearchResult } from '../research-agent.js'
import { DiscoveryAgent } from '../discovery-agent.js'
import type { GeneratorDeps, GenerateInput } from '../types.js'
import type { IWebSearchAdapter } from '../../adapters/index.js'
import { DuckDuckGoSearchAdapter } from '@agentic-obs/adapters'

export interface ResearchPhaseResult {
  research?: ResearchResult
  discovery?: DiscoveryResult
}

export class ResearchPhase {
  private readonly researchAgent: ResearchAgent

  constructor(private deps: GeneratorDeps, searchAdapter?: IWebSearchAdapter) {
    this.researchAgent = new ResearchAgent(
      deps.gateway,
      deps.model,
      deps.sendEvent,
      searchAdapter ?? new DuckDuckGoSearchAdapter(),
    )
  }

  async run(input: GenerateInput): Promise<ResearchPhaseResult> {
    const { sendEvent } = this.deps

    const shortGoal = input.goal.length > 60 ? input.goal.slice(0, 60) : input.goal
    sendEvent?.({
      type: 'tool_call',
      tool: 'research',
      args: { topic: input.goal },
      displayText: `Researching monitoring patterns for: ${shortGoal}`,
    })
    if (this.deps.metrics) {
      sendEvent?.({
        type: 'tool_call',
        tool: 'discover',
        args: { goal: input.goal },
        displayText: 'Discovering available metrics from cluster',
      })
    }

    const researchPromise = this.researchAgent.research(input.goal)
      .then((result) => {
        sendEvent?.({
          type: 'tool_result',
          tool: 'research',
          summary: result.keyMetrics.length
            ? `Found ${result.keyMetrics.length} key metrics`
            : 'Using LLM knowledge (no web results)',
          success: true,
        })
        return result
      })
      .catch(() => {
        sendEvent?.({
          type: 'tool_result',
          tool: 'research',
          summary: 'Web search failed - using LLM knowledge',
          success: false,
        })
        return undefined
      })

    const discoveryPromise = this.deps.metrics
      ? (async () => {
          try {
            const discoveryAgent = new DiscoveryAgent(
              this.deps.metrics!,
              sendEvent,
            )
            // First get all metric names, then use LLM to find relevant ones
            const allMetrics = await discoveryAgent.fetchAllMetricNames()
            const relevant = await this.selectRelevantMetrics(input.goal, allMetrics)
            // Now discover labels/samples for the relevant metrics only
            const searchPatterns = relevant.length > 0
              ? relevant.slice(0, 10).map((m) => m.split('_').slice(0, 2).join('_'))
              : input.goal.split(/\s+/).filter((w) => w.length > 3)
            const uniquePatterns = [...new Set(searchPatterns)]
            const discoveryResult = await discoveryAgent.discover(uniquePatterns)

            const result: DiscoveryResult = {
              metrics: relevant,
              labelsByMetric: discoveryResult.labelsByMetric,
              sampleValues: discoveryResult.sampleValues,
              metadataByMetric: discoveryResult.metadataByMetric,
              totalMetrics: allMetrics.length,
              // When LLM found no relevant metrics, surface pattern-matched candidates
              ...(relevant.length === 0 && discoveryResult.metrics.length > 0
                ? { candidateMetrics: discoveryResult.metrics.slice(0, 20) }
                : relevant.length === 0 && allMetrics.length > 0
                  ? { candidateMetrics: allMetrics.slice(0, 20) }
                  : {}),
            }

            sendEvent?.({
              type: 'tool_result',
              tool: 'discover',
              summary: relevant.length
                ? `Found ${relevant.length} relevant metrics (from ${discoveryResult.totalMetrics} total)`
                : `Scanned ${discoveryResult.totalMetrics} metrics - using best practices`,
              success: true,
            })
            return result
          }
          catch (err) {
            sendEvent?.({
              type: 'tool_result',
              tool: 'discover',
              summary: `Discovery failed: ${err instanceof Error ? err.message : 'unknown error'}`,
              success: false,
            })
            return undefined
          }
        })()
      : Promise.resolve(undefined)

    const [research, discovery] = await Promise.all([researchPromise, discoveryPromise])

    return { research, discovery }
  }

  // LLM-based metric selection (no rule-based filtering)
  async selectRelevantMetrics(goal: string, allMetrics: string[]): Promise<string[]> {
    if (allMetrics.length === 0)
      return []

    try {
      const metricList = allMetrics.join('\n')
      const resp = await this.deps.gateway.complete([
        {
          role: 'system',
          content: `You are a Prometheus expert. Given a monitoring goal and a list of all available metric names, select the ones that are relevant for building dashboard.
Return a JSON array of the relevant metric names (exact strings from the list).
Select metrics that would be useful for monitoring the given topic.
If none are relevant, return an empty array [].
ONLY return the JSON array, nothing else.`,
        },
        {
          role: 'user',
          content: `Goal: ${goal}\n\nAvailable metrics:\n${metricList}`,
        },
      ], {
        model: this.deps.model,
        maxTokens: 4096,
        temperature: 0,
        responseFormat: 'json',
      })

      const parsed = parseLlmJson(resp.content) as unknown
      if (!Array.isArray(parsed))
        return []

      const metricSet = new Set(allMetrics)
      return parsed.filter((x): x is string => typeof x === 'string' && metricSet.has(x))
    }
    catch (err) {
      log.error({ err }, 'selectRelevantMetrics failed')
      return []
    }
  }
}
