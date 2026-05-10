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
    private readonly orgId?: string,
  ) {}

  async resolve(variable: DashboardVariable): Promise<string[]> {
    if (variable.type === 'custom') {
      return variable.options ?? []
    }

    if (variable.type === 'query' && variable.query) {
      return this.resolveQuery(variable.query)
    }

    if (variable.type === 'datasource') {
      return this.resolveDatasources(variable.query)
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

  /**
   * Datasource variable: return the ids of every metrics-style connector.
   * The ids are what panels substitute into `${datasource}` placeholders, so
   * returning ids (not labels) keeps the substitution path single-step. The
   * UI is responsible for resolving id → human label for the dropdown.
   *
   * `filterPattern` is the variable's `query` field. When set to a regex
   * (delimited by `/.../`), only datasource names matching the pattern are
   * returned — useful for "$prom_env" filtered to `/^prom-/`.
   */
  private async resolveDatasources(filterPattern?: string): Promise<string[]> {
    if (!this.setupConfig || !this.orgId) return []
    const connectors = await this.setupConfig.listConnectors({ orgId: this.orgId })
    const metrics = connectors.filter(
      (d) => d.type === 'prometheus' || d.type === 'victoria-metrics',
    )

    let candidates = metrics
    if (filterPattern && filterPattern.startsWith('/') && filterPattern.lastIndexOf('/') > 0) {
      const last = filterPattern.lastIndexOf('/')
      const body = filterPattern.slice(1, last)
      const flags = filterPattern.slice(last + 1)
      try {
        const re = new RegExp(body, flags)
        candidates = metrics.filter((d) => {
          const label = typeof d.config.label === 'string' ? d.config.label : ''
          return re.test(d.name) || (label ? re.test(label) : false)
        })
      } catch {
        // Bad regex — fall back to all metrics datasources rather than
        // emptying the dropdown silently.
        candidates = metrics
      }
    }

    return candidates.map((d) => d.id).filter(Boolean)
  }
}
