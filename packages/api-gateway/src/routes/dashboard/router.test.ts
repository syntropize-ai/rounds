import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Dashboard, PanelConfig } from '@agentic-obs/common'
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer'
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'
import type { SetupConfigService } from '../../services/setup-config-service.js'
import { createDashboardRouter } from './router.js'

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: 'user_1',
      orgId: 'org_main',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    }
    next()
  },
}))

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_other',
    type: 'dashboard',
    title: 'Other Workspace',
    description: '',
    prompt: 'show me latency',
    userId: 'user_1',
    status: 'ready',
    panels: [panel()],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    workspaceId: 'org_other',
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  }
}

function panel(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return {
    id: 'panel_1',
    title: 'Latency',
    description: '',
    visualization: 'time_series',
    row: 0,
    col: 0,
    width: 6,
    height: 4,
    ...overrides,
  }
}

function makeStore(dash: Dashboard): IGatewayDashboardStore {
  return {
    create: vi.fn(),
    findById: vi.fn(async () => dash),
    findAll: vi.fn(async () => [dash]),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(),
    updateVariables: vi.fn(),
    delete: vi.fn(),
  }
}

function makeApp(
  store: IGatewayDashboardStore,
  setupConfig: Pick<SetupConfigService, 'listDatasources'> | undefined = { listDatasources: vi.fn() },
) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async () => true),
    getUserPermissions: vi.fn(async () => []),
    ensurePermissions: vi.fn(async () => []),
    filterByPermission: vi.fn(async (_identity, items) => [...items]),
  }

  const app = express()
  app.use(express.json())
  app.use('/dashboards', createDashboardRouter({
    store,
    accessControl,
    setupConfig: (setupConfig ?? { listDatasources: vi.fn() }) as SetupConfigService,
  }))
  return app
}

describe('dashboard router workspace ownership checks', () => {
  it('filters dashboard lists to the authenticated workspace', async () => {
    const owned = dashboard({ id: 'dash_owned', workspaceId: 'org_main' })
    const other = dashboard()
    const store = makeStore(other)
    vi.mocked(store.findAll).mockResolvedValue([owned, other])
    const app = makeApp(store)

    const res = await request(app).get('/dashboards')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('dash_owned')
  })

  it.each([
    ['GET', '/dashboards/dash_other'],
    ['GET', '/dashboards/dash_other/export'],
  ])('returns 404 for cross-workspace %s %s', async (method, path) => {
    const store = makeStore(dashboard())
    const app = makeApp(store)

    const res = await request(app)[method.toLowerCase() as 'get'](path)

    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
  })

  it('allows reading an owned dashboard', async () => {
    const owned = dashboard({ id: 'dash_owned', workspaceId: 'org_main' })
    const store = makeStore(owned)
    const app = makeApp(store)

    const res = await request(app).get('/dashboards/dash_owned')

    expect(res.status).toBe(200)
    expect(res.body.id).toBe('dash_owned')
  })

  it.each([
    ['put', '/dashboards/dash_other', { title: 'Renamed' }, 'update'],
    ['delete', '/dashboards/dash_other', undefined, 'delete'],
    ['put', '/dashboards/dash_other/panels', { panels: [] }, 'updatePanels'],
    ['post', '/dashboards/dash_other/panels', { title: 'CPU', visualization: 'stat', row: 0, col: 0, width: 3, height: 3 }, 'updatePanels'],
    ['delete', '/dashboards/dash_other/panels/panel_1', undefined, 'updatePanels'],
  ] as const)('returns 404 and skips mutation for cross-workspace %s %s', async (method, path, body, mutation) => {
    const store = makeStore(dashboard())
    const app = makeApp(store)
    let req = request(app)[method](path)
    if (body) req = req.send(body)

    const res = await req

    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
    expect(store[mutation]).not.toHaveBeenCalled()
  })

  it.each([
    ['put', '/dashboards/dash_owned', { title: 'Renamed' }, 'update'],
    ['delete', '/dashboards/dash_owned', undefined, 'delete'],
    ['put', '/dashboards/dash_owned/panels', { panels: [] }, 'updatePanels'],
  ] as const)('allows owned dashboard mutation for %s %s', async (method, path, body, mutation) => {
    const store = makeStore(dashboard({ id: 'dash_owned', workspaceId: 'org_main' }))
    vi.mocked(store.update).mockResolvedValue(dashboard({ id: 'dash_owned', workspaceId: 'org_main', title: 'Renamed' }))
    vi.mocked(store.delete).mockResolvedValue(true)
    vi.mocked(store.updatePanels).mockResolvedValue(dashboard({ id: 'dash_owned', workspaceId: 'org_main', panels: [] }))
    const app = makeApp(store)
    let req = request(app)[method](path)
    if (body) req = req.send(body)

    const res = await req

    expect(res.status).toBe(method === 'delete' ? 204 : 200)
    expect(store[mutation]).toHaveBeenCalled()
  })

  it('returns 404 and skips datasource resolution for cross-workspace variable resolution', async () => {
    const store = makeStore(dashboard({ variables: [{ name: 'pod', label: 'Pod', type: 'query', query: 'label_values(up, pod)' }] }))
    const setupConfig = { listDatasources: vi.fn(async () => []) }
    const app = makeApp(store, setupConfig)

    const res = await request(app)
      .post('/dashboards/dash_other/variables/resolve')
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('NOT_FOUND')
    expect(setupConfig.listDatasources).not.toHaveBeenCalled()
  })

})
