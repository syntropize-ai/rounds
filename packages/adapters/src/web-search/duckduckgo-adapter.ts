/**
 * DuckDuckGo HTML search adapter — concrete implementation of IWebSearchAdapter.
 */

import { createLogger } from '@agentic-obs/common/logging';
import type { IWebSearchAdapter, WebSearchResult } from '../interfaces.js';

const log = createLogger('duckduckgo-adapter');

export class DuckDuckGoSearchAdapter implements IWebSearchAdapter {
  async search(query: string, maxResults = 8): Promise<WebSearchResult[]> {
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
      const results: WebSearchResult[] = []
      const snippetPattern = /<a class="result__snippet" [^>]*>([\s\S]*?)<\/a>/g
      let match: RegExpExecArray | null
      while ((match = snippetPattern.exec(html)) !== null && results.length < maxResults) {
        const text = (match[1] ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#x27;/g, '\'')
          .trim()

        if (text.length > 20)
          results.push({ snippet: text })
      }

      return results
    }
    catch (err) {
      log.warn({ err }, 'failed to fetch DuckDuckGo search results');
      return []
    }
  }
}
