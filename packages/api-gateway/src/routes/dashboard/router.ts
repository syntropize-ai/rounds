import { Router } from 'express'
import type { Router as ExpressRouter } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { authMiddleware } from '../../middleware/auth.js'
import { createRequirePermission } from '../../middleware/require-permission.js'
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer'
import { VariableResolver } from './variable-resolver.js'
import { ac, ACTIONS } from '@agentic-obs/common'
import type { Dashboard, PanelConfig } from '@agentic-obs/common'
import type { SetupConfigService } from '../../services/setup-config-service.js'
import { getOrgId } from '../../middleware/workspace-context.js'

/**
 * Resolve the current request's org id. Prefers `req.auth.orgId` populated by
 * the auth middleware (post-T9 cutover); falls back to the header/query
 * helper for test harnesses that bypass auth.
 */
function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'

export interface DashboardRouterDeps {
  store: IGatewayDashboardStore
  /** Wave 7 — for the agent permission gate. Required. */
  accessControl: AccessControlSurface
  /** W2 / T2.4 — LLM + datasource config source. */
  setupConfig: SetupConfigService
}

export function createDashboardRouter(deps: DashboardRouterDeps): ExpressRouter {
  const store = deps.store
  const accessControl = deps.accessControl
  const setupConfig = deps.setupConfig

  const router = Router()
  const requirePermission = createRequirePermission(accessControl)

  function dashboardNotFound(res: Response): void {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } })
  }

  async function loadOwnedDashboard(req: Request, res: Response, id: string): Promise<Dashboard | undefined> {
    const dashboard = await store.findById(id)
    if (!dashboard || dashboard.workspaceId !== resolveOrgId(req)) {
      dashboardNotFound(res)
      return undefined
    }
    return dashboard
  }

  // All dashboard routes require authentication
  router.use(authMiddleware)

  // POST /dashboards
  // Creates an empty dashboard shell. Population happens through the chat
  // agent (POST /api/chat with `pageContext: { kind: 'dashboard', id }`) —
  // the orchestrator's `dashboard.*` tools mutate panels/variables and the
  // SSE stream pushes updates to the UI. There is no longer a background
  // auto-generation path; callers that want generation should drive it via
  // /api/chat after creation.
  router.post('/', requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { prompt?: string, title?: string, datasourceIds?: string[], useExistingMetrics?: boolean, folder?: string }
      if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'prompt is required and must be a non-empty string' } })
        return
      }

      const userId = (req as AuthenticatedRequest).auth?.userId ?? 'anonymous'
      const workspaceId = resolveOrgId(req)
      const dashboard = await store.create({
        title: body.title?.trim() ?? 'Untitled Dashboard',
        description: '',
        prompt: body.prompt.trim(),
        userId,
        datasourceIds: body.datasourceIds ?? [],
        useExistingMetrics: body.useExistingMetrics ?? true,
        folder: body.folder,
        workspaceId,
      })

      res.status(201).json(dashboard)
    }
    catch (err) {
      next(err)
    }
  })

  // GET /dashboards
  router.get('/', requirePermission(() => ac.eval(ACTIONS.DashboardsRead, 'dashboards:*')), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = resolveOrgId(req)
      let all = await store.findAll()
      // Filter by workspace
      all = all.filter((d) => d.workspaceId === workspaceId)
      res.json(all)
    }
    catch (err) {
      next(err)
    }
  })

  // GET /dashboards/:id/export — download as JSON file
  router.get('/:id/export', requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }
      const filename = `${dashboard.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.json(dashboard)
    } catch (err) { next(err) }
  })

  // GET /dashboards/:id
  router.get('/:id', requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }
      res.json(dashboard)
    }
    catch (err) {
      next(err)
    }
  })

  // PUT /dashboards/:id
  router.put('/:id', requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const body = req.body as { title?: string, description?: string, folder?: string }

      const patch: { title?: string, description?: string, folder?: string } = {}
      if (typeof body.title === 'string')
        patch.title = body.title.trim()
      if (typeof body.description === 'string')
        patch.description = body.description
      if (body.folder !== undefined)
        patch.folder = body.folder

      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }

      const updated = await store.update(id, patch)
      if (!updated) {
        dashboardNotFound(res)
        return
      }

      res.json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // DELETE /dashboards/:id
  router.delete('/:id', requirePermission((req) => ac.eval(ACTIONS.DashboardsDelete, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }

      const deleted = await store.delete(id)
      if (!deleted) {
        dashboardNotFound(res)
        return
      }
      res.status(204).send()
    }
    catch (err) {
      next(err)
    }
  })

  // PUT /dashboards/:id/panels
  router.put('/:id/panels', requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const body = req.body as { panels?: PanelConfig[] }
      if (!Array.isArray(body.panels)) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'panels must be an array' } })
        return
      }

      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }

      const updated = await store.updatePanels(id, body.panels)
      if (!updated) {
        dashboardNotFound(res)
        return
      }

      res.json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/panels
  router.post('/:id/panels', requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const d = await loadOwnedDashboard(req, res, id)
      if (!d) {
        return
      }

      const body = req.body as Omit<PanelConfig, 'id'>
      if (!body.title || typeof body.title !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'title is required' } })
        return
      }

      const panel: PanelConfig = { ...body, id: randomUUID() }
      const updated = await store.updatePanels(id, [...d.panels, panel])
      if (!updated) {
        dashboardNotFound(res)
        return
      }

      res.status(201).json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // DELETE /dashboards/:id/panels/:panelId
  router.delete('/:id/panels/:panelId', requirePermission((req) => ac.eval(ACTIONS.DashboardsWrite, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const panelId = req.params['panelId'] ?? ''
      const d = await loadOwnedDashboard(req, res, id)
      if (!d) {
        return
      }

      const panels = d.panels.filter((p) => p.id !== panelId)
      if (panels.length === d.panels.length) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Panel not found' } })
        return
      }

      await store.updatePanels(id, panels)
      res.status(204).send()
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/variables/resolve
  router.post('/:id/variables/resolve', requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['id']}`)), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await loadOwnedDashboard(req, res, id)
      if (!dashboard) {
        return
      }

      const body = req.body as { datasourceId?: string } | undefined
      const orgId = resolveOrgId(req)
      const allDs = await setupConfig.listDatasources({ orgId })
      const datasourceId = body?.datasourceId

      const promDs = allDs.find((d) =>
        (d.type === 'prometheus' || d.type === 'victoria-metrics')
        && (!datasourceId || d.id === datasourceId),
      )

      let prometheusUrl = ''
      const headers: Record<string, string> = {}
      if (promDs) {
        prometheusUrl = promDs.url
        if (promDs.username && promDs.password) {
          headers.Authorization = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`
        }
        else if (promDs.apiKey) {
          headers.Authorization = `Bearer ${promDs.apiKey}`
        }
      }

      const resolver = new VariableResolver(prometheusUrl, headers, setupConfig, orgId)
      const resolved: Record<string, string[]> = {}
      await Promise.all(
        dashboard.variables.map(async (v) => {
          resolved[v.name] = await resolver.resolve(v)
        }),
      )

      res.json({ variables: resolved })
    }
    catch (err) {
      next(err)
    }
  })

  return router
}
