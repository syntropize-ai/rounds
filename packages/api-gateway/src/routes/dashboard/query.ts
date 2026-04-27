// Prometheus query proxy - lets frontend panels fetch live data.
// Resolves datasource via SetupConfigService (W2 / T2.4), proxies PromQL to
// Prometheus, and handles basic label/metadata endpoints.

import { Router } from 'express'
import type { Request, Response } from 'express'
import { ac, ACTIONS, getErrorMessage } from '@agentic-obs/common'
import type { InstanceDatasource } from '@agentic-obs/common'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { authMiddleware } from '../../middleware/auth.js'
import { PrometheusHttpClient } from '@agentic-obs/adapters'
import type { SetupConfigService } from '../../services/setup-config-service.js'
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'

export interface QueryRouterDeps {
  setupConfig: SetupConfigService
  ac: AccessControlSurface
}

// -- Helpers

/**
 * Strict id-based lookup. Caller must supply the exact datasource — there's
 * no fallback to "the default", "the only one", or env/cluster narrowing.
 * Panel queries always have a datasourceId by the time they reach here
 * (enforced by the dashboard.add_panels / dashboard.modify_panel handlers
 * at write time); $datasource template substitution happens before this
 * call. If a caller hits this without a datasourceId, that's a contract
 * violation — surface it as a clear NO_DATASOURCE so the bug is visible.
 */
async function resolvePrometheusDatasource(
  setupConfig: SetupConfigService,
  orgId: string | null | undefined,
  datasourceId: string,
): Promise<InstanceDatasource | null> {
  if (!datasourceId) return null
  const ds = await setupConfig.getDatasource(datasourceId)
  if (!ds) return null
  const isPrometheus = ds.type === 'prometheus' || ds.type === 'victoria-metrics'
  const belongsToOrg = ds.orgId === orgId
  return isPrometheus && belongsToOrg ? ds : null
}

function buildClientConfig(ds: InstanceDatasource): ConstructorParameters<typeof PrometheusHttpClient>[0] {
  const cfg: ConstructorParameters<typeof PrometheusHttpClient>[0] = { baseUrl: ds.url }
  if (ds.username && ds.password) {
    cfg.auth = { username: ds.username, password: ds.password }
  } else if (ds.apiKey) {
    cfg.headers = { Authorization: `Bearer ${ds.apiKey}` }
  }
  return cfg
}

function buildFetchHeaders(ds: InstanceDatasource): Record<string, string> {
  if (ds.username && ds.password) {
    const token = Buffer.from(`${ds.username}:${ds.password}`).toString('base64')
    return { Authorization: `Basic ${token}` }
  }
  if (ds.apiKey) {
    return { Authorization: `Bearer ${ds.apiKey}` }
  }
  return {}
}

function getRequestOrgId(req: Request): string | null | undefined {
  return (req as AuthenticatedRequest).auth?.orgId
}

/**
 * Substitute `${name}` / `$name` placeholders against a value map. Used so a
 * panel's `datasourceId: '${datasource}'` resolves to the id picked by the
 * dashboard's `$datasource` template variable before resolution. Returns the
 * input unchanged when nothing matches — non-placeholder ids pass through.
 */
function substituteVariableTokens(
  value: string | undefined,
  values: Record<string, string> | undefined,
): string | undefined {
  if (!value || !values) return value
  // Match ${name} OR $name (alphanumeric / underscore). Substitution is
  // applied repeatedly to handle the rare ${a}${b} adjacency case in one pass.
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare
    if (key && Object.prototype.hasOwnProperty.call(values, key)) {
      return values[key] ?? match
    }
    return match
  })
}

async function requireDatasourcePermission(
  deps: QueryRouterDeps,
  req: Request,
  res: Response,
  action: typeof ACTIONS.DatasourcesQuery | typeof ACTIONS.DatasourcesRead,
  datasourceId: string,
): Promise<boolean> {
  const identity = (req as AuthenticatedRequest).auth
  if (!identity) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'authentication required' },
    })
    return false
  }
  const evaluator = ac.eval(action, `datasources:uid:${datasourceId}`)
  const allowed = await deps.ac.evaluate(identity, evaluator)
  if (!allowed) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: `User has no permission to ${evaluator.string()}`,
      },
    })
    return false
  }
  return true
}

// -- Router

export function createQueryRouter(deps: QueryRouterDeps): Router {
  const router = Router()
  const { setupConfig } = deps

  // POST /api/query/range
  router.post('/range', authMiddleware, async (req: Request, res: Response) => {
    const { query, start, end, step = '30s', datasourceId, environment, cluster, variableValues } = req.body as {
      query?: string
      start?: string
      end?: string
      step?: string
      datasourceId?: string
      environment?: string
      cluster?: string
      variableValues?: Record<string, string>
    }

    if (!query) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } })
      return
    }

    const resolvedDatasourceId = substituteVariableTokens(datasourceId, variableValues)
    if (!resolvedDatasourceId) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'datasourceId is required' } })
      return
    }
    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), resolvedDatasourceId)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: `Datasource ${resolvedDatasourceId} not found, not Prometheus, or not in your org` } })
      return
    }
    if (!(await requireDatasourcePermission(deps, req, res, ACTIONS.DatasourcesQuery, ds.id))) return

    const endDate = end ? new Date(end) : new Date()
    const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 60 * 1000)

    try {
      const client = new PrometheusHttpClient(buildClientConfig(ds))
      const result = await client.rangeQuery(query, startDate, endDate, step)
      res.json(result)
    } catch (err) {
      res.status(502).json({ error: { code: 'PROMETHEUS_ERROR', message: getErrorMessage(err) } })
    }
  })

  // POST /api/query/instant
  router.post('/instant', authMiddleware, async (req: Request, res: Response) => {
    const { query, time, datasourceId, environment, cluster, variableValues } = req.body as {
      query?: string
      time?: string
      datasourceId?: string
      environment?: string
      cluster?: string
      variableValues?: Record<string, string>
    }

    if (!query) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } })
      return
    }

    const resolvedDatasourceId = substituteVariableTokens(datasourceId, variableValues)
    if (!resolvedDatasourceId) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'datasourceId is required' } })
      return
    }
    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), resolvedDatasourceId)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: `Datasource ${resolvedDatasourceId} not found, not Prometheus, or not in your org` } })
      return
    }
    if (!(await requireDatasourcePermission(deps, req, res, ACTIONS.DatasourcesQuery, ds.id))) return

    try {
      const client = new PrometheusHttpClient(buildClientConfig(ds))
      const result = await client.instantQuery(query, time ? new Date(time) : undefined)
      res.json(result)
    } catch (err) {
      res.status(502).json({ error: { code: 'PROMETHEUS_ERROR', message: getErrorMessage(err) } })
    }
  })

  // GET /api/query/metadata?match={pattern}&datasourceId=xxx
  router.get('/metadata', authMiddleware, async (req: Request, res: Response) => {
    const { match, datasourceId } = req.query as {
      match?: string
      datasourceId?: string
    }

    if (!datasourceId) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'datasourceId is required' } })
      return
    }
    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: `Datasource ${datasourceId} not found, not Prometheus, or not in your org` } })
      return
    }
    if (!(await requireDatasourcePermission(deps, req, res, ACTIONS.DatasourcesRead, ds.id))) return

    try {
      const baseUrl = ds.url.replace(/\/$/, '')
      const headers = buildFetchHeaders(ds)

      let url: string
      if (match) {
        const params = new URLSearchParams()
        params.set('match[]', match)
        url = `${baseUrl}/api/v1/series?${params}`
      } else {
        url = `${baseUrl}/api/v1/label/__name__/values`
      }

      const fetchRes = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })

      if (!fetchRes.ok) {
        res.status(502).json({
          error: { code: 'PROMETHEUS_ERROR', message: `Prometheus HTTP ${fetchRes.status}` },
        })
        return
      }

      const body = await fetchRes.json() as { status?: string, data?: unknown[] }

      if (match) {
        const series = body.data as Array<Record<string, string>>
        const names = [...new Set(series.map((s) => s['__name__']).filter(Boolean))].sort()
        res.json({ status: 'success', data: names })
      } else {
        res.json(body)
      }
    } catch (err) {
      res.status(502).json({ error: { code: 'PROMETHEUS_ERROR', message: getErrorMessage(err) } })
    }
  })

  // GET /api/query/labels?metric={name}&datasourceId=xxx
  router.get('/labels', authMiddleware, async (req: Request, res: Response) => {
    const { metric, datasourceId } = req.query as {
      metric?: string
      datasourceId?: string
    }

    if (!datasourceId) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'datasourceId is required' } })
      return
    }
    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: `Datasource ${datasourceId} not found, not Prometheus, or not in your org` } })
      return
    }
    if (!(await requireDatasourcePermission(deps, req, res, ACTIONS.DatasourcesRead, ds.id))) return

    try {
      const baseUrl = ds.url.replace(/\/$/, '')
      const headers = buildFetchHeaders(ds)
      const params = new URLSearchParams()
      if (metric) params.set('match[]', metric)
      const url = `${baseUrl}/api/v1/labels?${params}`

      const fetchRes = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })

      if (!fetchRes.ok) {
        res.status(502).json({
          error: { code: 'PROMETHEUS_ERROR', message: `Prometheus HTTP ${fetchRes.status}` },
        })
        return
      }

      const body = await fetchRes.json()
      res.json(body)
    } catch (err) {
      res.status(502).json({ error: { code: 'PROMETHEUS_ERROR', message: getErrorMessage(err) } })
    }
  })

  // POST /api/query/batch
  router.post('/batch', authMiddleware, async (req: Request, res: Response) => {
    const { queries, start, end, step = '30s', variableValues } = req.body as {
      queries?: Array<{ refId: string, expr: string, instant?: boolean, datasourceId?: string }>
      start?: string
      end?: string
      step?: string
      variableValues?: Record<string, string>
    }

    if (!queries || queries.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'queries array is required and must not be empty' } })
      return
    }

    if (queries.length > 20) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'queries array must not exceed 20 items' } })
      return
    }

    for (const q of queries) {
      if (!q.refId || !q.expr) {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'each query must have refId and expr' } })
        return
      }
      if (!q.datasourceId) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `query ${q.refId} is missing datasourceId — every batched query must carry its own (no batch-level fallback)` } })
        return
      }
    }

    const endDate = end ? new Date(end) : new Date()
    const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 60 * 1000)
    const resolved: InstanceDatasource[] = []
    for (const q of queries) {
      const dsId = substituteVariableTokens(q.datasourceId, variableValues)
      if (!dsId) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `query ${q.refId} datasourceId resolved empty after variable substitution` } })
        return
      }
      const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), dsId)
      if (!ds) {
        res.status(400).json({
          error: {
            code: 'NO_DATASOURCE',
            message: `Datasource ${dsId} (query ${q.refId}) not found, not Prometheus, or not in your org`,
          },
        })
        return
      }
      if (!(await requireDatasourcePermission(deps, req, res, ACTIONS.DatasourcesQuery, ds.id))) return
      resolved.push(ds)
    }

    const settled = await Promise.allSettled(
      queries.map(async (q, i) => {
        const ds = resolved[i]!
        const client = new PrometheusHttpClient(buildClientConfig(ds))
        return q.instant
          ? client.instantQuery(q.expr)
          : client.rangeQuery(q.expr, startDate, endDate, step)
      }),
    )

    const results: Record<string, { status: string, data: unknown, error?: string }> = {}
    queries.forEach((q, i) => {
      const outcome = settled[i]!
      if (outcome.status === 'fulfilled') {
        results[q.refId] = { status: 'success', data: outcome.value }
      } else {
        const msg = getErrorMessage(outcome.reason)
        results[q.refId] = { status: 'error', data: { resultType: 'matrix', result: [] }, error: msg }
      }
    })

    res.json({ results })
  })

  return router
}
