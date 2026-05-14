import { Router } from 'express'
import type { Router as ExpressRouter } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { authMiddleware } from '../../middleware/auth.js'
import { createRequirePermission } from '../../middleware/require-permission.js'
import type { IGatewayDashboardStore, IServiceAttributionRepository } from '@agentic-obs/data-layer'
import { applyTier1PromqlAttribution } from '@agentic-obs/data-layer'
import { VariableResolver } from './variable-resolver.js'
import { ac, ACTIONS, AuditAction, assertWritable, ProvisionedResourceError, hashVariables } from '@agentic-obs/common'
import type { IDashboardVariableAckRepository } from '@agentic-obs/common'
import type { Dashboard, PanelConfig } from '@agentic-obs/common'
import type { SetupConfigService } from '../../services/setup-config-service.js'
import type { AuditWriter } from '../../auth/audit-writer.js'
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
  /**
   * Audit writer — records resource mutation events (dashboard.create/update/
   * delete/move). Optional so legacy tests can construct the router without
   * one; production wires the same writer used by auth routes.
   */
  audit?: AuditWriter
  /**
   * Wave 2 / Step 4 — per-user-per-dashboard ack store for inferred URL
   * variables. Optional so legacy tests can omit it; routes that depend
   * on it return 503 when missing.
   */
  variableAcks?: IDashboardVariableAckRepository
  /**
   * W2 step 2 — Tier-1 service-name extraction from panel PromQL. Optional
   * so legacy tests can construct the router without one.
   */
  serviceAttribution?: IServiceAttributionRepository
}

export function createDashboardRouter(deps: DashboardRouterDeps): ExpressRouter {
  const store = deps.store
  const accessControl = deps.accessControl
  const setupConfig = deps.setupConfig
  const audit = deps.audit
  const variableAcks = deps.variableAcks
  const serviceAttribution = deps.serviceAttribution

  function panelsToPromqlQueries(panels: PanelConfig[]): string[] {
    const out: string[] = []
    for (const p of panels) {
      if (p.query) out.push(p.query)
      if (p.queries) for (const q of p.queries) if (q.expr) out.push(q.expr)
    }
    return out
  }

  /**
   * Tier-1 service auto-fill. Best-effort: writes a `prom_label` attribution
   * row with confidence 0.95 when any panel query contains a `service="x"`
   * label. Runs after the primary panel write; failures are swallowed inside
   * `applyTier1PromqlAttribution`.
   */
  async function autoAttributeDashboard(orgId: string, dashboardId: string, panels: PanelConfig[]): Promise<void> {
    if (!serviceAttribution) return
    await applyTier1PromqlAttribution(serviceAttribution, orgId, {
      kind: 'dashboard',
      id: dashboardId,
      queries: panelsToPromqlQueries(panels),
    })
  }

  const router = Router()
  const requirePermission = createRequirePermission(accessControl)

  function dashboardNotFound(res: Response): void {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } })
  }

  /**
   * Returns true and writes the 409 response when the dashboard is owned by a
   * file/GitOps pipeline; callers should `return` immediately after.
   */
  function refuseIfProvisioned(res: Response, dashboard: Dashboard): boolean {
    try {
      assertWritable({ kind: 'dashboard', id: dashboard.id, source: dashboard.source ?? 'manual' })
      return false
    } catch (err) {
      if (err instanceof ProvisionedResourceError) {
        res.status(409).json({
          error: {
            code: 'PROVISIONED_RESOURCE',
            message: err.message,
            source: err.resource.source,
          },
        })
        return true
      }
      throw err
    }
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
        // REST API created — see writable-gate.ts for the source taxonomy.
        source: 'api',
      })

      void audit?.log({
        action: AuditAction.DashboardCreate,
        actorType: 'user',
        actorId: userId,
        orgId: workspaceId,
        targetType: 'dashboard',
        targetId: dashboard.id,
        targetName: dashboard.title,
        outcome: 'success',
        metadata: { folder: dashboard.folder ?? null },
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
      if (refuseIfProvisioned(res, dashboard)) return

      const updated = await store.update(id, patch)
      if (!updated) {
        dashboardNotFound(res)
        return
      }

      const actorId = (req as AuthenticatedRequest).auth?.userId ?? null
      const orgId = resolveOrgId(req)
      const folderChanged = patch.folder !== undefined && patch.folder !== dashboard.folder
      void audit?.log({
        action: folderChanged ? AuditAction.DashboardMove : AuditAction.DashboardUpdate,
        actorType: 'user',
        actorId,
        orgId,
        targetType: 'dashboard',
        targetId: id,
        targetName: updated.title,
        outcome: 'success',
        metadata: {
          before: { title: dashboard.title, folder: dashboard.folder ?? null },
          after: { title: updated.title, folder: updated.folder ?? null },
        },
      })

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
      if (refuseIfProvisioned(res, dashboard)) return

      const deleted = await store.delete(id)
      if (!deleted) {
        dashboardNotFound(res)
        return
      }
      void audit?.log({
        action: AuditAction.DashboardDelete,
        actorType: 'user',
        actorId: (req as AuthenticatedRequest).auth?.userId ?? null,
        orgId: resolveOrgId(req),
        targetType: 'dashboard',
        targetId: id,
        targetName: dashboard.title,
        outcome: 'success',
      })
      res.status(204).send()
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/fork — Wave 2 / Step 5
  // Copy the (possibly provisioned) source dashboard into the caller's personal
  // folder as a `source: 'manual'` row. Reads bypass the writable-gate on
  // purpose: forking a provisioned dashboard is the supported "edit it" path.
  // We require read on the source AND create-in-folders for the destination.
  router.post(
    '/:id/fork',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['id']}`)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params['id'] ?? ''
        const body = (req.body ?? {}) as { newTitle?: string }
        const source = await loadOwnedDashboard(req, res, id)
        if (!source) return

        const userId = (req as AuthenticatedRequest).auth?.userId ?? 'anonymous'
        const orgId = resolveOrgId(req)
        // Personal-folder convention — see docs/auth-perm-design and the
        // writable-gate RFC. The folder is created on-demand by callers; here
        // we just attach the uid string so the create-folder-RBAC scope works.
        const personalFolderUid = `personal-${userId}`

        const newTitle =
          typeof body.newTitle === 'string' && body.newTitle.trim()
            ? body.newTitle.trim()
            : `${source.title} (forked)`

        const created = await store.create({
          title: newTitle,
          description: source.description,
          prompt: source.prompt,
          userId,
          datasourceIds: source.datasourceIds,
          useExistingMetrics: source.useExistingMetrics,
          folder: personalFolderUid,
          workspaceId: orgId,
          // Fork lands as a plain manual row so the writable-gate lets the
          // user edit it freely going forward.
          source: 'manual',
          provenance: { forkedFrom: source.id },
        })

        // Copy panels + variables onto the freshly created shell. We persist
        // through the dedicated methods (rather than passing into create())
        // because create() doesn't accept them — same pattern as agent clone.
        if (source.panels.length > 0) {
          await store.updatePanels(created.id, source.panels)
        }
        if (source.variables.length > 0) {
          await store.updateVariables(created.id, source.variables)
        }

        void audit?.log({
          action: AuditAction.DashboardFork,
          actorType: 'user',
          actorId: userId,
          orgId,
          targetType: 'dashboard',
          targetId: created.id,
          targetName: created.title,
          outcome: 'success',
          metadata: {
            sourceId: source.id,
            sourceSource: source.source ?? 'manual',
            folder: personalFolderUid,
          },
        })

        // Reload so the response includes the panels/variables we just wrote.
        const full = await store.findById(created.id)
        res.status(201).json(full ?? created)
      } catch (err) {
        next(err)
      }
    },
  )

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
      if (refuseIfProvisioned(res, dashboard)) return

      const updated = await store.updatePanels(id, body.panels)
      if (!updated) {
        dashboardNotFound(res)
        return
      }

      void autoAttributeDashboard(resolveOrgId(req), id, body.panels)
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
      if (refuseIfProvisioned(res, d)) return

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

      void autoAttributeDashboard(resolveOrgId(req), id, updated.panels)
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
      if (refuseIfProvisioned(res, d)) return

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
      const connectors = await setupConfig.listConnectors({ orgId })
      const datasourceId = body?.datasourceId

      const promConnector = connectors.find((d) =>
        (d.type === 'prometheus' || d.type === 'victoria-metrics')
        && (!datasourceId || d.id === datasourceId),
      )

      let prometheusUrl = ''
      const headers: Record<string, string> = {}
      if (promConnector) {
        prometheusUrl = typeof promConnector.config.url === 'string' ? promConnector.config.url : ''
        const username = typeof promConnector.config.username === 'string' ? promConnector.config.username : ''
        const password = typeof promConnector.config.password === 'string' ? promConnector.config.password : ''
        const apiKey = typeof promConnector.config.apiKey === 'string' ? promConnector.config.apiKey : ''
        if (username && password) {
          headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
        }
        else if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`
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

  // ── Wave 2 / Step 4: variable-inference ack endpoints ────────────────
  //
  // GET  /:uid/variable-ack?vars=<hash>     → { acked: boolean }
  // POST /:uid/variable-ack body { vars }   → server hashes, upserts row
  //
  // Both require dashboards:read on the target dashboard. Ack is keyed by
  // (userId, dashboardUid, varsHash) — see packages/common/src/utils/variable-hash.ts.

  router.get(
    '/:uid/variable-ack',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['uid']}`)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!variableAcks) {
          res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'variable-ack repository not wired' } })
          return
        }
        const uid = req.params['uid'] ?? ''
        const varsHash = typeof req.query['vars'] === 'string' ? req.query['vars'] : ''
        if (!varsHash) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'vars query param required' } })
          return
        }
        const userId = (req as AuthenticatedRequest).auth?.userId ?? 'anonymous'
        const row = await variableAcks.findAck(userId, uid, varsHash)
        res.json({ acked: row != null })
      }
      catch (err) {
        next(err)
      }
    },
  )

  router.post(
    '/:uid/variable-ack',
    requirePermission((req) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${req.params['uid']}`)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!variableAcks) {
          res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'variable-ack repository not wired' } })
          return
        }
        const uid = req.params['uid'] ?? ''
        const body = req.body as { vars?: Record<string, unknown> } | undefined
        const rawVars = body?.vars
        if (!rawVars || typeof rawVars !== 'object' || Array.isArray(rawVars)) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'vars object required' } })
          return
        }
        // Coerce all values to strings — anything else (e.g. someone POSTing
        // a nested object) is rejected so the hash domain stays {string→string}.
        const vars: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawVars)) {
          if (typeof v !== 'string') {
            res.status(400).json({ error: { code: 'INVALID_INPUT', message: `vars.${k} must be a string` } })
            return
          }
          vars[k] = v
        }
        const userId = (req as AuthenticatedRequest).auth?.userId ?? 'anonymous'
        const orgId = resolveOrgId(req)
        const varsHash = hashVariables(vars)
        await variableAcks.ackVariables({ orgId, userId, dashboardUid: uid, varsHash })
        res.json({ acked: true })
      }
      catch (err) {
        next(err)
      }
    },
  )

  return router
}
