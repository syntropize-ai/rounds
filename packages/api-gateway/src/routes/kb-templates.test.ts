/**
 * Tests for the KB templates route — POST/save and GET/list.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type {
  Dashboard,
  IKnowledgeRepository,
  KnowledgeEntry,
  KnowledgeInsertInput,
  PanelConfig,
} from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createKbTemplatesRouter } from './kb-templates.js';

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: 'user_1',
      orgId: 'org_main',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

function panel(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return {
    id: 'p1',
    title: 'Pod CPU for orders',
    description: '',
    visualization: 'time_series',
    queries: [{
      refId: 'A',
      expr: 'rate(container_cpu_usage_seconds_total{namespace="orders"}[5m])',
      legendFormat: '{{pod}} orders',
      datasourceId: 'ds_prom',
    }],
    row: 0, col: 0, width: 6, height: 4,
    ...overrides,
  };
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash_a',
    type: 'dashboard',
    title: 'Orders dashboard',
    description: '',
    prompt: '',
    userId: 'user_1',
    status: 'ready',
    panels: [panel()],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: ['ds_prom'],
    useExistingMetrics: true,
    workspaceId: 'org_main',
    source: 'manual',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function inMemoryKbRepo(): IKnowledgeRepository {
  const rows = new Map<string, KnowledgeEntry>();
  return {
    async insert(input: KnowledgeInsertInput) {
      const now = new Date().toISOString();
      const entry: KnowledgeEntry = {
        ...input,
        useCount: 0, approvedCount: 0, rejectedCount: 0,
        createdAt: now, updatedAt: now,
      };
      rows.set(`${input.orgId}::${input.id}`, entry);
      return entry;
    },
    async getById(orgId, id) { return rows.get(`${orgId}::${id}`) ?? null; },
    async list(orgId, opts) {
      const out: KnowledgeEntry[] = [];
      for (const [k, v] of rows) {
        if (!k.startsWith(`${orgId}::`)) continue;
        if (opts?.kind && v.kind !== opts.kind) continue;
        out.push(v);
      }
      return out;
    },
    async update(orgId, id, patch) {
      const cur = rows.get(`${orgId}::${id}`);
      if (!cur) return null;
      const next = {
        ...cur,
        title: patch.title ?? cur.title,
        kind: patch.kind ?? cur.kind,
        intentTags: patch.intentTags ?? cur.intentTags,
        content: patch.content !== undefined ? patch.content : cur.content,
        sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : cur.sourceRef,
        updatedAt: new Date().toISOString(),
      };
      rows.set(`${orgId}::${id}`, next);
      return next;
    },
    async bumpUseCount() {},
    async recordFeedback() {},
    async delete() {},
    async listForSearch(orgId, opts) { return this.list(orgId, opts); },
  };
}

function makeStore(dashboards: Dashboard[]): IGatewayDashboardStore {
  const map = new Map(dashboards.map((d) => [d.id, { ...d }] as const));
  return {
    findById: vi.fn(async (id: string) => map.get(id) ?? null),
  } as unknown as IGatewayDashboardStore;
}

function makeAc(opts: { allowWrite?: boolean; allowReadDash?: boolean } = {}): AccessControlSurface {
  const allowWrite = opts.allowWrite ?? true;
  const allowReadDash = opts.allowReadDash ?? true;
  return {
    evaluate: vi.fn(async (_id, evaluator) => {
      const s = evaluator.string();
      if (s.startsWith('dashboards:create')) return allowWrite;
      if (s.startsWith('dashboards:read')) return allowReadDash;
      if (s.startsWith('chat:use')) return true;
      return true;
    }),
    filterByPermission: vi.fn(async (_id, items) => [...items]),
  } as unknown as AccessControlSurface;
}

function buildApp(deps: {
  knowledge: IKnowledgeRepository;
  dashboards: IGatewayDashboardStore;
  accessControl: AccessControlSurface;
}) {
  const app = express();
  app.use(express.json());
  app.use('/api/kb/templates', createKbTemplatesRouter(deps));
  return app;
}

describe('POST /api/kb/templates', () => {
  let knowledge: IKnowledgeRepository;
  let dashboards: IGatewayDashboardStore;

  beforeEach(() => {
    knowledge = inMemoryKbRepo();
  });

  it('returns 201 + id and substitutes literals with ${VAR} placeholders', async () => {
    dashboards = makeStore([dashboard()]);
    const app = buildApp({ knowledge, dashboards, accessControl: makeAc() });
    const res = await request(app)
      .post('/api/kb/templates')
      .send({
        dashboardId: 'dash_a',
        paramSpec: [
          { key: 'NAMESPACE', label: 'Namespace', literalValue: 'orders', defaultValue: '' },
        ],
        intentTags: ['k8s', 'orders'],
        notes: 'saved by test',
      });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
    const entry = await knowledge.getById('org_main', res.body.id);
    expect(entry).toBeTruthy();
    expect(entry!.source).toBe('saved');
    expect(entry!.kind).toBe('template');
    const content = entry!.content as { panels: Array<{ title: string; queries: Array<{ expr: string; legendFormat?: string }> }>; variables: unknown[] };
    expect(content.panels[0]!.title).toBe('Pod CPU for ${NAMESPACE}');
    expect(content.panels[0]!.queries[0]!.expr).toContain('namespace="${NAMESPACE}"');
    expect(content.panels[0]!.queries[0]!.legendFormat).toBe('{{pod}} ${NAMESPACE}');
    expect(content.variables).toHaveLength(1);
  });

  it('returns 400 on invalid body', async () => {
    dashboards = makeStore([dashboard()]);
    const app = buildApp({ knowledge, dashboards, accessControl: makeAc() });
    const res = await request(app).post('/api/kb/templates').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when source dashboard is missing', async () => {
    dashboards = makeStore([]);
    const app = buildApp({ knowledge, dashboards, accessControl: makeAc() });
    const res = await request(app)
      .post('/api/kb/templates')
      .send({ dashboardId: 'missing', paramSpec: [] });
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller lacks dashboards:create', async () => {
    dashboards = makeStore([dashboard()]);
    const app = buildApp({ knowledge, dashboards, accessControl: makeAc({ allowWrite: false }) });
    const res = await request(app)
      .post('/api/kb/templates')
      .send({ dashboardId: 'dash_a', paramSpec: [] });
    expect(res.status).toBe(403);
  });

  it('returns 403 when caller lacks dashboards:read on source', async () => {
    dashboards = makeStore([dashboard()]);
    const app = buildApp({
      knowledge, dashboards,
      accessControl: makeAc({ allowWrite: true, allowReadDash: false }),
    });
    const res = await request(app)
      .post('/api/kb/templates')
      .send({ dashboardId: 'dash_a', paramSpec: [] });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/kb/templates', () => {
  it('200 returns kind=template entries for the org', async () => {
    const knowledge = inMemoryKbRepo();
    await knowledge.insert({
      id: 't1', orgId: 'org_main', source: 'saved', sourceRef: null,
      kind: 'template', title: 'sample', intentTags: [], content: { panels: [], variables: [], notes: '' },
      createdBy: null,
    });
    // Pattern should not appear in template list
    await knowledge.insert({
      id: 'p1', orgId: 'org_main', source: 'bundled', sourceRef: null,
      kind: 'pattern', title: 'red', intentTags: [], content: {},
      createdBy: null,
    });
    const app = buildApp({
      knowledge,
      dashboards: makeStore([]),
      accessControl: makeAc(),
    });
    const res = await request(app).get('/api/kb/templates');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].id).toBe('t1');
  });
});
