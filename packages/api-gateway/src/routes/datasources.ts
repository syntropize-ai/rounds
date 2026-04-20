/**
 * Datasource CRUD router (W2 / T2.4).
 *
 * Backed by `SetupConfigService` (SQLite `instance_datasources`). Replaces
 * the old flat-file path in routes/setup.ts. Auth is handled by the
 * caller — see server.ts for the bootstrap-aware mount added in T2.5.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type {
  DatasourceType,
  InstanceDatasource,
  NewInstanceDatasource,
  InstanceDatasourcePatch,
} from '@agentic-obs/common';
import { ACTIONS, ac } from '@agentic-obs/common';
import { testDatasourceConnection } from '../utils/datasource.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

export interface DatasourcesRouterDeps {
  setupConfig: SetupConfigService;
  /**
   * Pre-bootstrap the wizard hits `POST /api/datasources` unauthenticated
   * (see `bootstrapAware` in server.ts). Once the bootstrap marker is set
   * the permission middleware kicks in: `datasources:read` for GETs,
   * `datasources:create` for POST, `datasources:write` for PUT,
   * `datasources:delete` for DELETE — matching Grafana's stock role grants
   * (Viewer: read only; Editor: read + explore/query; Admin: full CRUD).
   */
  ac: AccessControlSurface;
}

interface DatasourceBody {
  id?: string;
  type?: DatasourceType;
  name?: string;
  url?: string;
  environment?: string | null;
  cluster?: string | null;
  label?: string | null;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  isDefault?: boolean;
  orgId?: string | null;
}

function actorFromReq(req: Request): { userId: string | null } {
  const ar = req as AuthenticatedRequest;
  return { userId: ar.auth?.userId ?? null };
}

export function createDatasourcesRouter(deps: DatasourcesRouterDeps): Router {
  const router = Router();
  const { setupConfig } = deps;
  const requirePermission = createRequirePermission(deps.ac);

  // GET /api/datasources — list (masked)
  router.get(
    '/',
    requirePermission(() => ac.eval(ACTIONS.DatasourcesRead, 'datasources:*')),
    async (_req: Request, res: Response) => {
      const datasources = await setupConfig.listDatasources({ masked: true });
      res.json({ datasources });
    },
  );

  // POST /api/datasources/test — test connection without saving (a "dry run"
  // write probe; gated as `datasources:create` because the UX is "I'm about
  // to add one and want to check it").
  router.post(
    '/test',
    requirePermission(() => ac.eval(ACTIONS.DatasourcesCreate)),
    async (req: Request, res: Response) => {
    const body = req.body as DatasourceBody;
    if (!body?.type || !body.url) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'type and url are required' },
      });
      return;
    }
    const probe = {
      type: body.type,
      url: body.url,
      apiKey: body.apiKey ?? undefined,
      username: body.username ?? undefined,
      password: body.password ?? undefined,
    } as Parameters<typeof testDatasourceConnection>[0];
    const result = await testDatasourceConnection(probe);
    res.status(result.ok ? 200 : 400).json(result);
  },
  );

  // POST /api/datasources — create
  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.DatasourcesCreate)),
    async (req: Request, res: Response) => {
    const body = req.body as DatasourceBody;
    if (!body?.type || !body.url || !body.name) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'type, name, and url are required' },
      });
      return;
    }
    const actor = actorFromReq(req);
    // If caller supplies an id that already exists, surface 409.
    if (body.id && (await setupConfig.getDatasource(body.id))) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: `Datasource "${body.id}" already exists` },
      });
      return;
    }
    const input: NewInstanceDatasource = {
      id: body.id,
      type: body.type,
      name: body.name,
      url: body.url,
      environment: body.environment ?? null,
      cluster: body.cluster ?? null,
      label: body.label ?? null,
      apiKey: body.apiKey ?? null,
      username: body.username ?? null,
      password: body.password ?? null,
      isDefault: body.isDefault ?? false,
      orgId: body.orgId ?? null,
    };
    const created = await setupConfig.createDatasource(input, actor);
    res.status(201).json({ datasource: maskForWire(created) });
  },
  );

  // GET /api/datasources/:id — get one
  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.DatasourcesRead, `datasources:uid:${req.params['id']}`),
    ),
    async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    const ds = await setupConfig.getDatasource(id, { masked: true });
    if (!ds) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` },
      });
      return;
    }
    res.json({ datasource: ds });
  },
  );

  // PUT /api/datasources/:id — update
  router.put(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.DatasourcesWrite, `datasources:uid:${req.params['id']}`),
    ),
    async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    const existing = await setupConfig.getDatasource(id);
    if (!existing) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` },
      });
      return;
    }
    const body = req.body as DatasourceBody;
    const patch: InstanceDatasourcePatch = {};
    if (body.type !== undefined) patch.type = body.type;
    if (body.name !== undefined) patch.name = body.name;
    if (body.url !== undefined) patch.url = body.url;
    if (body.environment !== undefined) patch.environment = body.environment;
    if (body.cluster !== undefined) patch.cluster = body.cluster;
    if (body.label !== undefined) patch.label = body.label;
    if (body.isDefault !== undefined) patch.isDefault = body.isDefault;
    if (body.apiKey !== undefined) patch.apiKey = body.apiKey;
    if (body.username !== undefined) patch.username = body.username;
    if (body.password !== undefined) patch.password = body.password;
    const updated = await setupConfig.updateDatasource(id, patch, actorFromReq(req));
    res.json({ datasource: updated ? maskForWire(updated) : null });
  },
  );

  // DELETE /api/datasources/:id — delete
  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.DatasourcesDelete, `datasources:uid:${req.params['id']}`),
    ),
    async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    const existed = await setupConfig.deleteDatasource(id, actorFromReq(req));
    if (!existed) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` },
      });
      return;
    }
    res.json({ ok: true });
  },
  );

  // POST /api/datasources/:id/test — test a saved datasource
  router.post(
    '/:id/test',
    requirePermission((req) =>
      ac.eval(ACTIONS.DatasourcesRead, `datasources:uid:${req.params['id']}`),
    ),
    async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    const ds = await setupConfig.getDatasource(id);
    if (!ds) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` },
      });
      return;
    }
    const probe = {
      type: ds.type,
      url: ds.url,
      apiKey: ds.apiKey ?? undefined,
      username: ds.username ?? undefined,
      password: ds.password ?? undefined,
    } as Parameters<typeof testDatasourceConnection>[0];
    const result = await testDatasourceConnection(probe);
    res.status(result.ok ? 200 : 400).json(result);
  },
  );

  return router;
}

/**
 * Redact secret values for JSON responses. Matches the mask string the
 * repository layer uses for `{ masked: true }` reads so frontend code
 * sees one shape either way.
 */
function maskForWire(ds: InstanceDatasource): InstanceDatasource {
  return {
    ...ds,
    apiKey: ds.apiKey ? '••••••' + ds.apiKey.slice(-4) : ds.apiKey,
    password: ds.password ? (ds.password.length > 4 ? '••••••' + ds.password.slice(-4) : '••••••') : ds.password,
  };
}
