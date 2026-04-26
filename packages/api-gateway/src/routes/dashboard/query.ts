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

async function resolvePrometheusDatasource(
  setupConfig: SetupConfigService,
  orgId: string | null | undefined,
  datasourceId?: string,
  environment?: string,
  cluster?: string,
): Promise<InstanceDatasource | null> {
  const isPrometheus = (d: InstanceDatasource) =>
    d.type === 'prometheus' || d.type === 'victoria-metrics'
  const belongsToOrg = (d: InstanceDatasource) =>
    d.orgId === null || d.orgId === undefined || d.orgId === orgId

  if (datasourceId) {
    const ds = await setupConfig.getDatasource(datasourceId)
    return ds && isPrometheus(ds) && belongsToOrg(ds) ? ds : null
  }

  const all = await setupConfig.listDatasources()
  const candidates = all.filter((d) => isPrometheus(d) && belongsToOrg(d))

  if (environment || cluster) {
    const match = candidates.find((d) => {
      if (environment && d.environment !== environment) return false
      if (cluster && d.cluster !== cluster) return false
      return true
    })
    return match ?? null
  }

  return candidates[0] ?? null
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
    const { query, start, end, step = '30s', datasourceId, environment, cluster } = req.body as {
      query?: string
      start?: string
      end?: string
      step?: string
      datasourceId?: string
      environment?: string
      cluster?: string
    }

    if (!query) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } })
      return
    }

    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId, environment, cluster)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } })
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
    const { query, time, datasourceId, environment, cluster } = req.body as {
      query?: string
      time?: string
      datasourceId?: string
      environment?: string
      cluster?: string
    }

    if (!query) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'query is required' } })
      return
    }

    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId, environment, cluster)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } })
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

  // GET /api/query/metadata?match={pattern}&datasourceId=xxx&environment=prod&cluster=my-cluster-a
  router.get('/metadata', authMiddleware, async (req: Request, res: Response) => {
    const { match, datasourceId, environment, cluster } = req.query as {
      match?: string
      datasourceId?: string
      environment?: string
      cluster?: string
    }

    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId, environment, cluster)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } })
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

  // GET /api/query/labels?metric={name}&datasourceId=xxx&environment=prod&cluster=my-cluster-a
  router.get('/labels', authMiddleware, async (req: Request, res: Response) => {
    const { metric, datasourceId, environment, cluster } = req.query as {
      metric?: string
      datasourceId?: string
      environment?: string
      cluster?: string
    }

    const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), datasourceId, environment, cluster)
    if (!ds) {
      res.status(400).json({ error: { code: 'NO_DATASOURCE', message: 'No Prometheus datasource configured' } })
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
    const { queries, start, end, step = '30s', datasourceId, environment, cluster } = req.body as {
      queries?: Array<{ refId: string, expr: string, instant?: boolean, datasourceId?: string }>
      start?: string
      end?: string
      step?: string
      datasourceId?: string
      environment?: string
      cluster?: string
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
    }

    const endDate = end ? new Date(end) : new Date()
    const startDate = start ? new Date(start) : new Date(endDate.getTime() - 30 * 60 * 1000)
    const resolved: InstanceDatasource[] = []
    for (const q of queries) {
      const ds = await resolvePrometheusDatasource(setupConfig, getRequestOrgId(req), q.datasourceId ?? datasourceId, environment, cluster)
      if (!ds) {
        res.status(400).json({
          error: {
            code: 'NO_DATASOURCE',
            message: q.datasourceId
              ? `Datasource ${q.datasourceId} is not a configured Prometheus datasource`
              : 'No Prometheus datasource configured',
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
