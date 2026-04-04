import { parseLlmJson } from './llm-json.js'
import type { LLMGateway, CompletionMessage } from '@agentic-obs/llm-gateway'
import { createLogger } from '@agentic-obs/common'
import type { DashboardSseEvent } from '@agentic-obs/common'

const log = createLogger('research-agent')

export interface ResearchResult {
  topic: string
  keyMetrics: string[]
  metricPrefixes: string[]
  monitoringApproach: string
  bestPractices: string[]
  panelSuggestions: string[]
  rawContext: string
}

interface ExtractedKnowledge {
  keyMetrics: string[]
  metricPrefixes: string[]
  monitoringApproach: string
  bestPractices: string[]
  panelSuggestions: string[]
}

const FALLBACK_KNOWLEDGE: ExtractedKnowledge = {
  keyMetrics: [],
  metricPrefixes: [],
  monitoringApproach: 'RED method (Rate, Errors, Duration)',
  bestPractices: ['Monitor key resource utilization', 'Set up alerting for critical metrics'],
  panelSuggestions: ['Request rate', 'Error rate', 'Latency percentiles'],
}

export class ResearchAgent {
  constructor(
    private gateway: LLMGateway,
    private model: string,
    private sendEvent: (event: DashboardSseEvent) => void,
  ) {}

  async research(topic: string): Promise<ResearchResult> {
    this.sendEvent({ type: 'thinking', content: `Researching ${topic} monitoring best practices...` })

    // Build an English search query for better technical results
    const searchQuery = await this.buildSearchQuery(topic)
    log.info({ searchQuery, topic }, 'built search query')

    // Step 1: Web search
    this.sendEvent({
      type: 'tool_call',
      tool: 'web_search',
      args: { query: searchQuery },
      displayText: `Searching: ${searchQuery}`,
    })

    const searchResults = await this.webSearch(searchQuery)
    log.info({ count: searchResults.length, firstSnippet: searchResults[0]?.slice(0, 120) }, 'web search complete')

    this.sendEvent({
      type: 'tool_result',
      tool: 'web_search',
      summary: `Found ${searchResults.length} results`,
      success: searchResults.length > 0,
    })

    // Step 2: LLM extracts structured knowledge from search results
    this.sendEvent({ type: 'thinking', content: 'Extracting monitoring insights...' })
    const knowledge = await this.extractKnowledge(topic, searchResults)
    log.info({ metrics: knowledge.keyMetrics.length, practices: knowledge.bestPractices.length }, 'extracted monitoring knowledge')

    const rawContext = searchResults.length > 0
      ? `Web search results:\n${searchResults.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : ''

    return {
      topic,
      keyMetrics: knowledge.keyMetrics,
      metricPrefixes: knowledge.metricPrefixes,
      monitoringApproach: knowledge.monitoringApproach,
      bestPractices: knowledge.bestPractices,
      panelSuggestions: knowledge.panelSuggestions,
      rawContext,
    }
  }

  private async buildSearchQuery(topic: string): Promise<string> {
    try {
      const resp = await this.gateway.complete([
        {
          role: 'system',
          content: `You are a search query optimizer. Convert the user's input into an effective English web search query for finding Prometheus monitoring metrics and best practices for the relevant technology.
Return ONLY the query string, nothing else.`,
        },
        { role: 'user', content: topic },
      ], {
        model: this.model,
        maxTokens: 64,
        temperature: 0,
      })

      const query = resp.content.replace(/['"]/g, '').trim()
      return query || `${topic} prometheus monitoring metrics`
    }
    catch {
      return `${topic} prometheus monitoring metrics`
    }
  }

  private async webSearch(query: string): Promise<string[]> {
    try {
      const encodedQuery = encodeURIComponent(query)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; observability-assistant/1.0)' },
        signal: AbortSignal.timeout(8_000),
      })

      if (!res.ok)
        return []

      const html = await res.text()
      const snippets: string[] = []
      const snippetPattern = /<a class="result__snippet" [^>]*>([\s\S]*?)<\/a>/g
      let match: RegExpExecArray | null
      while ((match = snippetPattern.exec(html)) !== null && snippets.length < 8) {
        const text = (match[1] ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#x27;/g, '\'')
          .trim()

        if (text.length > 20)
          snippets.push(text)
      }

      return snippets
    }
    catch {
      return []
    }
  }

  private async extractKnowledge(topic: string, snippets: string[]): Promise<ExtractedKnowledge> {
    if (!snippets.length)
      return FALLBACK_KNOWLEDGE

    const searchContext = snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')
    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content: `You are an observability expert. Given web search results about monitoring ${topic}, extract:
1. Key Prometheus metric names commonly used for this specific technology (exact metric names)
2. Prometheus metric name prefixes specific to this technology (for discovering metrics in Prometheus)
3. Recommended monitoring approach (RED/USE/4 Golden Signals/custom)
4. Best practices and common patterns
5. Suggested dashboard panel ideas

IMPORTANT: metricPrefixes must be specific to the technology being monitored. They will be used to search Prometheus for relevant metrics.

Return JSON: { keyMetrics: [...], metricPrefixes: [...], monitoringApproach: "...", bestPractices: [...], panelSuggestions: [...] }`,
      },
      {
        role: 'user',
        content: `Web search results for "${topic} monitoring best practices":\n${searchContext}`,
      },
    ]

    try {
      const resp = await this.gateway.complete(messages, {
        model: this.model,
        maxTokens: 4096,
        temperature: 0,
        responseFormat: 'json',
      })

      log.debug({ raw: resp.content.slice(0, 300) }, 'LLM extraction raw output')
      const parsed = parseLlmJson(resp.content) as ExtractedKnowledge

      return {
        keyMetrics: Array.isArray(parsed.keyMetrics) ? parsed.keyMetrics : [],
        metricPrefixes: Array.isArray(parsed.metricPrefixes) ? parsed.metricPrefixes : [],
        monitoringApproach: typeof parsed.monitoringApproach === 'string' ? parsed.monitoringApproach : FALLBACK_KNOWLEDGE.monitoringApproach,
        bestPractices: Array.isArray(parsed.bestPractices) ? parsed.bestPractices : [],
        panelSuggestions: Array.isArray(parsed.panelSuggestions) ? parsed.panelSuggestions : [],
      }
    }
    catch (err) {
      log.error({ err }, 'extractKnowledge failed')
      return FALLBACK_KNOWLEDGE
    }
  }
}
