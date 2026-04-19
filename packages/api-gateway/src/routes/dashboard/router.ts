import { Router } from 'express'
import type { Router as ExpressRouter } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import type { AuthenticatedRequest } from '../../middleware/auth.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/rbac.js'
import type { IGatewayDashboardStore, IConversationStore, IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer'
import { handleChatMessage } from './chat-handler.js'
import { VariableResolver } from './variable-resolver.js'
import type { PanelConfig } from '@agentic-obs/common'
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
import { DashboardService, withDashboardLock } from '../../services/dashboard-service.js'
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'
import type { AuditWriter } from '../../auth/audit-writer.js'
import { createLogger } from '@agentic-obs/common/logging'

const log = createLogger('dashboard-router')

export interface DashboardRouterDeps {
  store: IGatewayDashboardStore
  conversationStore: IConversationStore
  investigationReportStore: IInvestigationReportRepository
  alertRuleStore: IAlertRuleRepository
  investigationStore?: IGatewayInvestigationStore
  feedStore?: IGatewayFeedStore
  /** Wave 7 — for the agent permission gate. Required. */
  accessControl: AccessControlSurface
  /** Audit writer for agent tool calls. */
  auditWriter?: AuditWriter
  /** Folder backend — enables agent folder.* tools. Optional. */
  folderRepository?: import('@agentic-obs/common').IFolderRepository
  /** W2 / T2.4 — LLM + datasource config source. */
  setupConfig: SetupConfigService
}

export function createDashboardRouter(deps: DashboardRouterDeps): ExpressRouter {
  const store = deps.store
  const conversationStore = deps.conversationStore
  const investigationReportStore = deps.investigationReportStore
  const alertRuleStore = deps.alertRuleStore
  const investigationStore = deps.investigationStore
  const feedStore = deps.feedStore
  const accessControl = deps.accessControl
  const auditWriter = deps.auditWriter
  const folderRepository = deps.folderRepository
  const setupConfig = deps.setupConfig

  const router = Router()

  // All dashboard routes require authentication
  router.use(authMiddleware)

  // POST /dashboards
  router.post('/', requirePermission('dashboard:create'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { prompt?: string, title?: string, datasourceIds?: string[], useExistingMetrics?: boolean, folder?: string, stream?: boolean }
      if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'prompt is required and must be a non-empty string' })
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

      // Trigger generation in background via the orchestrator agent (same path as chat)
      if (!body.stream) {
        const callerAuth = (req as AuthenticatedRequest).auth
        if (!callerAuth) {
          // Should never happen — authMiddleware is registered above. Bail
          // rather than starting the agent with an ambient identity.
          log.warn({ dashboardId: dashboard.id }, 'background generation skipped — no req.auth')
        } else {
          const service = new DashboardService({
            store, conversationStore, investigationReportStore, alertRuleStore,
            investigationStore, feedStore, accessControl, setupConfig,
            ...(auditWriter ? { auditWriter } : {}),
            ...(folderRepository ? { folderRepository } : {}),
          })
          void withDashboardLock(dashboard.id, async () => {
            try {
              await service.handleChatMessage(
                dashboard.id,
                dashboard.prompt,
                undefined,
                () => {},  // no SSE sink for background generation
                callerAuth,
              )
            } catch (err) {
              log.error({ err, dashboardId: dashboard.id }, 'background generation failed')
              await store.updateStatus(dashboard.id, 'failed')
            }
          })
        }
      }
    }
    catch (err) {
      next(err)
    }
  })

  // GET /dashboards
  router.get('/', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = resolveOrgId(req)
      let all = await store.findAll()
      // Filter by workspace
      all = all.filter((d) => (d.workspaceId ?? 'default') === workspaceId)
      res.json(all)
    }
    catch (err) {
      next(err)
    }
  })

  // GET /dashboards/:id/export — download as JSON file
  router.get('/:id/export', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await store.findById(id)
      if (!dashboard) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }
      const filename = `${dashboard.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.json(dashboard)
    } catch (err) { next(err) }
  })

  // GET /dashboards/:id
  router.get('/:id', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await store.findById(id)
      if (!dashboard) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }
      const workspaceId = resolveOrgId(req)
      if ((dashboard.workspaceId ?? 'default') !== workspaceId) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }
      res.json(dashboard)
    }
    catch (err) {
      next(err)
    }
  })

  // PUT /dashboards/:id
  router.put('/:id', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
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

      const updated = await store.update(id, patch)
      if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      res.json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // DELETE /dashboards/:id
  router.delete('/:id', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const deleted = await store.delete(id)
      if (!deleted) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }
      // Cascade: remove associated conversation messages
      await conversationStore.deleteConversation(id)
      res.status(204).send()
    }
    catch (err) {
      next(err)
    }
  })

  // PUT /dashboards/:id/panels
  router.put('/:id/panels', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const body = req.body as { panels?: PanelConfig[] }
      if (!Array.isArray(body.panels)) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'panels must be an array' })
        return
      }

      const updated = await store.updatePanels(id, body.panels)
      if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      res.json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/panels
  router.post('/:id/panels', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const d = await store.findById(id)
      if (!d) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      const body = req.body as Omit<PanelConfig, 'id'>
      if (!body.title || typeof body.title !== 'string') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'title is required' })
        return
      }

      const panel: PanelConfig = { ...body, id: randomUUID() }
      const updated = await store.updatePanels(id, [...d.panels, panel])
      if (!updated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      res.status(201).json(updated)
    }
    catch (err) {
      next(err)
    }
  })

  // DELETE /dashboards/:id/panels/:panelId
  router.delete('/:id/panels/:panelId', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const panelId = req.params['panelId'] ?? ''
      const d = await store.findById(id)
      if (!d) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      const panels = d.panels.filter((p) => p.id !== panelId)
      if (panels.length === d.panels.length) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Panel not found' })
        return
      }

      await store.updatePanels(id, panels)
      res.status(204).send()
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/chat
  router.post('/:id/chat', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const body = req.body as { message?: string; timeRange?: { start?: string; end?: string; timezone?: string } }
      if (typeof body.message !== 'string' || body.message.trim() === '') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required and must be a non-empty string' })
        return
      }

      await handleChatMessage(req as AuthenticatedRequest, res, id, body.message.trim(), body.timeRange, store, conversationStore, investigationReportStore, alertRuleStore, accessControl, setupConfig, investigationStore, feedStore, auditWriter, folderRepository)
    }
    catch (err) {
      next(err)
    }
  })

  // POST /dashboards/:id/variables/resolve
  router.post('/:id/variables/resolve', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await store.findById(id)
      if (!dashboard) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      const body = req.body as { datasourceId?: string } | undefined
      const allDs = await setupConfig.listDatasources()
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

      const resolver = new VariableResolver(prometheusUrl, headers, setupConfig)
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

  // GET /dashboards/:id/chat
  router.get('/:id/chat', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params['id'] ?? ''
      const dashboard = await store.findById(id)
      if (!dashboard) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard not found' })
        return
      }

      res.json({ messages: await conversationStore.getMessages(id) })
    }
    catch (err) {
      next(err)
    }
  })

  return router
}
