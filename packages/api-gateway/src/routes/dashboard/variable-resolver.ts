// Resolves DashboardVariable options from Prometheus or setup config.
// Datasource variables are populated from SetupConfigService (W2 / T2.4).

import { AppError, getErrorMessage, type DashboardVariable } from '@agentic-obs/common'
import type { SetupConfigService } from '../../services/setup-config-service.js'

export class DashboardVariableResolutionError extends AppError {
  constructor(message: string, details?: unknown) {
    super('DASHBOARD_VARIABLE_RESOLUTION_FAILED', 424, message, details)
  }
}

export class VariableResolver {
  constructor(
    private readonly prometheusUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly setupConfig?: SetupConfigService,
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

      return this.fetchLabelValues(url)
    }

    // Single-arg form: label_values(labelName)
    const singleArgMatch = query.match(/label_values\(\s*([^)]+?)\s*\)/)
    if (singleArgMatch) {
      const labelName = singleArgMatch[1]!.trim()
      const url = `${baseUrl}/api/v1/label/${encodeURIComponent(labelName)}/values`

      return this.fetchLabelValues(url)
    }

    return []
  }

  private async fetchLabelValues(url: string): Promise<string[]> {
    let res: Response
    try {
      res = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      })
    }
    catch (err) {
      throw new DashboardVariableResolutionError(
        `Prometheus label_values request failed: ${getErrorMessage(err)}`,
        { url },
      )
    }

    if (!res.ok) {
      throw new DashboardVariableResolutionError(
        `Prometheus label_values request failed with HTTP ${res.status}`,
        { url, status: res.status },
      )
    }

    let body: { status?: string, data?: string[] }
    try {
      body = await res.json() as { status?: string, data?: string[] }
    }
    catch (err) {
      throw new DashboardVariableResolutionError(
        `Prometheus label_values response could not be parsed: ${getErrorMessage(err)}`,
        { url, status: res.status },
      )
    }

    if (body.status === 'success' && Array.isArray(body.data))
      return [...new Set(body.data)].sort()

    throw new DashboardVariableResolutionError(
      'Prometheus label_values response was not successful',
      { url, status: body.status },
    )
  }

  private async resolveDatasources(): Promise<string[]> {
    if (!this.setupConfig) return []
    const datasources = await this.setupConfig.listDatasources()
    return datasources.map((d) => d.label ?? d.name ?? d.id).filter(Boolean)
  }
}
