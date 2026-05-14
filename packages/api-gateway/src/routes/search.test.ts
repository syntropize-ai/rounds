import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { Evaluator, Identity, ResolvedPermission } from '@agentic-obs/common'
import type { IDashboardRepository, IFolderRepository, IOrgUserRepository } from '@agentic-obs/common'
import type { AccessControlSurface } from '../services/accesscontrol-holder.js'
import { createSearchRouter } from './search.js'
import type { IAlertRuleRepository } from '@agentic-obs/data-layer'

const mockState = vi.hoisted(() => ({
  identity: {
    userId: 'u_1',
    orgId: 'org_a',
    orgRole: 'Viewer',
    isServerAdmin: false,
    authenticatedBy: 'session',
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request & { auth?: Identity }, _res: express.Response, next: express.NextFunction) => {
    req.auth = { ...mockState.identity } as Identity
    next()
  },
}))

function makeAccessControl(deniedFragments: string[] = []): AccessControlSurface {
  const evaluate = async (_id: Identity, evaluator: Evaluator): Promise<boolean> => {
    const rendered = evaluator.string()
    return !deniedFragments.some((fragment) => rendered.includes(fragment))
  }

  return {
    getUserPermissions: async (): Promise<ResolvedPermission[]> => [],
    ensurePermissions: async (): Promise<ResolvedPermission[]> => [],
    evaluate,
    filterByPermission: async <T>(
      id: Identity,
      items: readonly T[],
      buildEvaluator: (item: T) => Evaluator,
    ): Promise<T[]> => {
      const kept: T[] = []
      for (const item of items) {
        if (await evaluate(id, buildEvaluator(item))) kept.push(item)
      }
      return kept
    },
  }
}

function makeApp(deniedFragments: string[] = []) {
  const folderStore = {
    async list(opts) {
      const items = [
        {
          id: 'folder-row-a',
          uid: 'folder-a',
          orgId: 'org_a',
          title: 'Redis folder',
          description: null,
          parentUid: null,
          created: '',
          updated: '',
          createdBy: null,
          updatedBy: null,
        },
        {
          id: 'folder-row-b',
          uid: 'folder-b',
          orgId: 'org_b',
          title: 'Redis leaked folder',
          description: null,
          parentUid: null,
          created: '',
          updated: '',
          createdBy: null,
          updatedBy: null,
        },
      ].filter((f) => f.orgId === opts.orgId)
      return { items, total: items.length }
    },
    async listAncestors() {
      return []
    },
  } as Partial<IFolderRepository> as IFolderRepository

  const dashboardStore = {
    async listByWorkspace(workspaceId: string) {
      return [
        {
          id: 'dash-a',
          title: 'Redis dashboard',
          description: 'safe dashboard',
          workspaceId: 'org_a',
          panels: [{ id: 'panel-a', title: 'Redis panel', queries: [{ expr: 'rate(redis_hits_total[5m])' }] }],
        },
        {
          id: 'dash-b',
          title: 'Redis leaked dashboard',
          description: 'other org dashboard',
          workspaceId: 'org_b',
          panels: [{ id: 'panel-b', title: 'Redis leaked panel', queries: [{ expr: 'redis_secret_metric' }] }],
        },
      ].filter((d) => d.workspaceId === workspaceId)
    },
  } as Partial<IDashboardRepository> as IDashboardRepository

  const alertRuleStore = {
    async findByWorkspace(workspaceId: string) {
      return [
        {
          id: 'alert-a',
          name: 'RedisHighLatency',
          description: 'safe alert',
          workspaceId: 'org_a',
          condition: { query: 'histogram_quantile(redis_latency)', operator: '>', threshold: 1 },
        },
        {
          id: 'alert-b',
          name: 'RedisLeakedAlert',
          description: 'other org alert',
          workspaceId: 'org_b',
          condition: { query: 'redis_secret_alert', operator: '>', threshold: 1 },
        },
      ].filter((a) => a.workspaceId === workspaceId)
    },
  } as Partial<IAlertRuleRepository> as IAlertRuleRepository

  const orgUsers = {
    async findMembership(orgId: string, userId: string) {
      return orgId === 'org_a' && userId === mockState.identity.userId
        ? { orgId, userId, role: 'Viewer' }
        : null
    },
  } as Partial<IOrgUserRepository> as IOrgUserRepository

  const app = express()
  app.use(
    '/api/search',
    createSearchRouter({
      dashboardStore,
      alertRuleStore,
      folderStore,
      orgUsers,
      accessControl: makeAccessControl(deniedFragments),
    }),
  )
  return app
}

describe('/api/search', () => {
  beforeEach(() => {
    delete (mockState.identity as Identity).permissions
  })

  it('searches only the resolved org workspace before matching metadata', async () => {
    const res = await request(makeApp()).get('/api/search?q=redis')

    expect(res.status).toBe(200)
    const ids = (res.body.results as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining(['folder-a', 'dash-a', 'alert-a']))
    expect(ids).not.toContain('folder-b')
    expect(ids).not.toContain('dash-b')
    expect(ids).not.toContain('dash-b:panel-b')
    expect(ids).not.toContain('alert-b')

    const promqlLeak = await request(makeApp()).get('/api/search?q=redis_secret_metric')
    expect(promqlLeak.status).toBe(200)
    expect(promqlLeak.body.results).toEqual([])
  })

  it('filters folder, dashboard, panel, promql, and alert results through RBAC', async () => {
    const res = await request(makeApp(['folder-a', 'dash-a', 'alert-a'])).get('/api/search?q=redis')

    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([])
  })

  it('rejects an explicit org context when the caller is not a member', async () => {
    const res = await request(makeApp()).get('/api/search?q=redis&orgId=org_b')

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('FORBIDDEN')
  })
})
