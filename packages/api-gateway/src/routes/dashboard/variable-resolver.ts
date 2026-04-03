// Resolves DashboardVariable options from Prometheus or setup config

import type { DashboardVariable } from '@agentic-obs/common'
import { getSetupConfig } from '../setup.js'

export class VariableResolver {
  constructor(
    private readonly prometheusUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async resolve(variable: DashboardVariable): Promise<string[]> {
    if (variable.type === 'custom') {
      return variable.options ?? []
    }

    if (variable.type === 'query' && variable.query) {
      return this.resolveQuery(variable.query)
    }

    if (variable.type === 'datasource') {
      return this.resolveDatasources()
    }

    return []
  }

  private async resolveQuery(query: string): Promise<string[]> {
    const baseUrl = this.prometheusUrl.replace(/\/$/, '')

    // Two-arg form: label_values(metric, label)
    const twoArgMatch = query.match(/label_values\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/)
    if (twoArgMatch) {
      const [, metric, labelName] = twoArgMatch
      const params = new URLSearchParams()
      params.set('match[]', metric!)
      const url = `${baseUrl}/api/v1/label/${encodeURIComponent(labelName!)}/values?${params}`

      try {
        const res = await fetch(url, {
          headers: this.headers,
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok)
          return []
        const body = await res.json() as { status?: string, data?: string[] }
        if (body.status === 'success' && Array.isArray(body.data))
          return [...new Set(body.data)].sort()
      }
      catch {
        return []
      }
    }

    // Single-arg form: label_values(labelName)
    const singleArgMatch = query.match(/label_values\(\s*([^)]+?)\s*\)/)
    if (singleArgMatch) {
      const labelName = singleArgMatch[1]!.trim()
      const url = `${baseUrl}/api/v1/label/${encodeURIComponent(labelName)}/values`

      try {
        const res = await fetch(url, {
          headers: this.headers,
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok)
          return []
        const body = await res.json() as { status?: string, data?: string[] }
        if (body.status === 'success' && Array.isArray(body.data))
          return [...new Set(body.data)].sort()
      }
      catch {
        return []
      }
    }

    return []
  }

  private resolveDatasources(): string[] {
    const config = getSetupConfig()
    return config.datasources.map((d) => d.label ?? d.name ?? d.id).filter(Boolean)
  }
}
