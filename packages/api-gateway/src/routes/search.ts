import { Router } from 'express'
import type { Response } from 'express'
import { ac, ACTIONS } from '@agentic-obs/common'
import type { IDashboardRepository, IFolderRepository, IOrgUserRepository } from '@agentic-obs/common'
import { authMiddleware } from '../middleware/auth.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { createOrgContextMiddleware } from '../middleware/org-context.js'
import type { AccessControlSurface } from '../services/accesscontrol-holder.js'
import type { IAlertRuleRepository } from '@agentic-obs/data-layer'

export interface SearchResult {
  type: 'dashboard' | 'investigation' | 'alert' | 'folder' | 'panel'
  id: string
  title: string
  subtitle?: string
  matchField?: string
  navigateTo: string
}

function matchesQuery(text: string | undefined, q: string): boolean {
  return !!text && text.toLowerCase().includes(q)
}

export interface SearchRouterDeps {
  dashboardStore: IDashboardRepository;
  alertRuleStore: IAlertRuleRepository;
  folderStore: IFolderRepository;
  orgUsers: IOrgUserRepository;
  accessControl: AccessControlSurface;
}

export function createSearchRouter(deps: SearchRouterDeps): Router {
  const dashStore = deps.dashboardStore;
  const alertStore = deps.alertRuleStore;
  const folderStore = deps.folderStore;
  const accessControl = deps.accessControl;

  const router = Router()
  router.use(authMiddleware)
  router.use(createOrgContextMiddleware({ orgUsers: deps.orgUsers }))

  // GET /api/search?q=redis&limit=20
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    const q = (req.query['q'] as string ?? '').toLowerCase().trim()
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '20', 10), 50)
    const orgId = req.auth!.orgId

    if (!q) {
      res.json({ results: [] })
      return
    }

    const results: SearchResult[] = []

    // Search folders
    const folderItems = []
    for (let offset = 0; ; ) {
      const page = await folderStore.list({ orgId, limit: 200, offset })
      folderItems.push(...page.items)
      offset += page.items.length
      if (page.items.length === 0 || offset >= page.total) break
    }
    const folders = await accessControl.filterByPermission(
      req.auth!,
      folderItems,
      (f) => ac.eval(ACTIONS.FoldersRead, `folders:uid:${f.uid}`),
    )
    for (const f of folders) {
      if (results.length >= limit) break
      if (matchesQuery(f.title, q)) {
        const ancestors = await folderStore.listAncestors(orgId, f.uid)
        const path = [...ancestors].reverse().map((a) => a.title).concat(f.title).join('/')
        const expandIds = [...ancestors].reverse().map((a) => a.uid).concat(f.uid).join(',')
        results.push({ type: 'folder', id: f.uid, title: f.title, subtitle: path, navigateTo: `/dashboards?expand=${expandIds}` })
      }
    }

    // Search dashboards
    const dashboards = await accessControl.filterByPermission(
      req.auth!,
      await dashStore.listByWorkspace(orgId),
      (d) => ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${d.id}`),
    )
    for (const d of dashboards) {
      if (results.length >= limit) break
      const type = 'dashboard'
      const nav = `/dashboards/${d.id}`

      if (matchesQuery(d.title, q)) {
        results.push({ type, id: d.id, title: d.title, subtitle: d.description, navigateTo: nav })
        continue
      }
      if (matchesQuery(d.description, q)) {
        results.push({ type, id: d.id, title: d.title, subtitle: d.description, matchField: 'description', navigateTo: nav })
        continue
      }
      let panelMatch = false
      for (const p of d.panels) {
        if (matchesQuery(p.title, q)) {
          results.push({ type: 'panel', id: `${d.id}:${p.id}`, title: p.title, subtitle: d.title, matchField: 'panel', navigateTo: nav })
          panelMatch = true
          break
        }
        for (const pq of p.queries ?? []) {
          if (matchesQuery(pq.expr, q)) {
            results.push({ type: 'panel', id: `${d.id}:${p.id}`, title: p.title, subtitle: `${d.title} · ${pq.expr.slice(0, 60)}`, matchField: 'promql', navigateTo: nav })
            panelMatch = true
            break
          }
        }
        if (panelMatch) break
      }
    }

    // Search alerts
    const alerts = await accessControl.filterByPermission(
      req.auth!,
      await alertStore.findByWorkspace(orgId),
      (a) => ac.eval(ACTIONS.AlertRulesRead, `alert.rules:uid:${a.id}`),
    )
    for (const a of alerts) {
      if (results.length >= limit) break
      const name = a.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').trim()
      if (matchesQuery(name, q) || matchesQuery(a.description, q) || matchesQuery(a.condition.query, q)) {
        results.push({
          type: 'alert',
          id: a.id,
          title: name,
          subtitle: a.description || a.condition.query.slice(0, 60),
          matchField: matchesQuery(name, q) ? undefined : 'query',
          navigateTo: '/alerts',
        })
      }
    }

    res.json({ results })
  })

  return router
}
