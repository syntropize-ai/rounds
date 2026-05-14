/**
 * Audit wiring tests for the dashboard router (Wave 1 / PR-A).
 *
 * Verifies that PUT /dashboards/:id emits a dashboard.update audit row
 * (or dashboard.move when the folder changes) via the AuditWriter passed
 * through router deps.
 */

import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AuditAction, type Dashboard, type PanelConfig } from '@agentic-obs/common'
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer'
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js'
import type { SetupConfigService } from '../../services/setup-config-service.js'
import type { AuditWriter } from '../../auth/audit-writer.js'
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
    id: 'dash_owned',
    type: 'dashboard',
    title: 'Latency',
    description: '',
    prompt: 'show me latency',
    userId: 'user_1',
    status: 'ready',
    panels: [] as PanelConfig[],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    workspaceId: 'org_main',
    folder: 'observability',
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  }
}

function makeStore(dash: Dashboard): IGatewayDashboardStore {
  return {
    create: vi.fn(),
    findById: vi.fn(async () => dash),
    findAll: vi.fn(async () => [dash]),
    listByWorkspace: vi.fn(async () => [dash]),
    update: vi.fn(async (_id, patch) => ({ ...dash, ...patch })),
    updateStatus: vi.fn(),
    updatePanels: vi.fn(),
    updateVariables: vi.fn(),
    delete: vi.fn(),
    getFolderUid: vi.fn(async () => null),
    size: vi.fn(async () => 0),
    clear: vi.fn(),
    toJSON: vi.fn(async () => []),
    loadJSON: vi.fn(),
  } as unknown as IGatewayDashboardStore
}

function makeApp(store: IGatewayDashboardStore, audit: AuditWriter) {
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
    setupConfig: { listConnectors: vi.fn() } as unknown as SetupConfigService,
    audit,
  }))
  return app
}

describe('dashboard router audit wiring', () => {
  it('emits DashboardUpdate audit row on title change', async () => {
    const log = vi.fn(async () => {})
    const audit = { log } as unknown as AuditWriter
    const store = makeStore(dashboard())
    const app = makeApp(store, audit)

    const res = await request(app)
      .put('/dashboards/dash_owned')
      .send({ title: 'New Title' })

    expect(res.status).toBe(200)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.DashboardUpdate,
      actorType: 'user',
      actorId: 'user_1',
      orgId: 'org_main',
      targetType: 'dashboard',
      targetId: 'dash_owned',
      targetName: 'New Title',
      outcome: 'success',
      metadata: expect.objectContaining({
        before: expect.objectContaining({ title: 'Latency', folder: 'observability' }),
        after: expect.objectContaining({ title: 'New Title', folder: 'observability' }),
      }),
    }))
  })

  it('emits DashboardMove audit row when folder changes', async () => {
    const log = vi.fn(async () => {})
    const audit = { log } as unknown as AuditWriter
    const store = makeStore(dashboard())
    const app = makeApp(store, audit)

    const res = await request(app)
      .put('/dashboards/dash_owned')
      .send({ folder: 'security' })

    expect(res.status).toBe(200)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.DashboardMove,
      targetId: 'dash_owned',
      metadata: expect.objectContaining({
        before: expect.objectContaining({ folder: 'observability' }),
        after: expect.objectContaining({ folder: 'security' }),
      }),
    }))
  })
})
