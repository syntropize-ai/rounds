import { Router } from 'express';
import type { Request, Response } from 'express';
import { ac, KUBERNETES_DEFAULT_POLICIES as COMMON_K8S_DEFAULTS } from '@agentic-obs/common';
import type { ConnectorSubjectType } from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  ConnectorService,
  type Connector,
  type ConnectorPatch,
  type ConnectorPolicy,
  type ConnectorRepository,
  type ConnectorSecretStore,
  type ConnectorStatus,
  type ConnectorPolicyRepository,
  type ConnectorTestResult,
} from '../services/connector-service.js';

export const CONNECTOR_ACTIONS = {
  Read: 'connectors:read',
  Create: 'connectors:create',
  Write: 'connectors:write',
  Delete: 'connectors:delete',
  Test: 'connectors:test',
  PermissionsRead: 'connectors.permissions:read',
  PermissionsWrite: 'connectors.permissions:write',
} as const;

export interface ConnectorsRouterDeps {
  connectors: ConnectorRepository;
  secrets?: ConnectorSecretStore;
  policies?: ConnectorPolicyRepository;
  ac: AccessControlSurface;
  /**
   * Wired by domain-routes.ts: probes the backend named by the connector
   * row and (on success) flips status draft→active. Without this dep the
   * service falls back to the old `{ ok: true }` stub.
   */
  testConnector?: (connector: Connector) => Promise<ConnectorTestResult>;
}

interface ConnectorBody {
  id?: string;
  type?: string;
  name?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
}

interface ConnectorPolicyBody {
  subjectType?: ConnectorSubjectType;
  subjectId?: string;
  capability?: string;
  scope?: Record<string, unknown> | null;
  humanPolicy?: ConnectorPolicy['humanPolicy'];
}

const CONNECTOR_STATUSES = new Set<ConnectorStatus>(['draft', 'active', 'failed', 'disabled']);
const HUMAN_POLICIES = new Set<ConnectorPolicy['humanPolicy']>(['allow', 'ask', 'block']);
const SUBJECT_TYPES = new Set<ConnectorSubjectType>(['org', 'team']);

/**
 * Default policy seed for newly-created kubernetes connectors. Seeded at
 * org-level (subjectType='org', subjectId=<connector.orgId>); admins can
 * override per-team via the Policies dialog.
 */
export const KUBERNETES_DEFAULT_POLICIES: ReadonlyArray<{
  capability: string;
  humanPolicy: ConnectorPolicy['humanPolicy'];
}> = COMMON_K8S_DEFAULTS;

function orgIdFromReq(req: Request): string | null {
  return (req as AuthenticatedRequest).auth?.orgId ?? null;
}

function userIdFromReq(req: Request): string {
  return (req as AuthenticatedRequest).auth?.userId ?? 'system';
}

function requireOrg(req: Request, res: Response): string | null {
  const orgId = orgIdFromReq(req);
  if (!orgId) {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'org context is required' },
    });
    return null;
  }
  return orgId;
}

function connectorScope(id = '*'): string {
  return id === '*' ? 'connectors:*' : `connectors:uid:${id}`;
}

function maskForWire(connector: Connector): Connector {
  return {
    ...connector,
    config: { ...connector.config },
  };
}

function readStatus(value: unknown): ConnectorStatus | undefined {
  if (typeof value !== 'string') return undefined;
  return CONNECTOR_STATUSES.has(value as ConnectorStatus) ? value as ConnectorStatus : undefined;
}

export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const service = new ConnectorService(deps);

  router.get(
    '/',
    requirePermission(() => ac.eval(CONNECTOR_ACTIONS.Read, connectorScope())),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const status = readStatus(req.query['status']);
      const connectors = await service.list({
        orgId,
        masked: true,
        ...(typeof req.query['category'] === 'string' ? { category: req.query['category'] } : {}),
        ...(typeof req.query['capability'] === 'string' ? { capability: req.query['capability'] } : {}),
        ...(status ? { status } : {}),
      });
      res.json({ connectors: connectors.map(maskForWire) });
    },
  );

  router.post(
    '/',
    requirePermission(() => ac.eval(CONNECTOR_ACTIONS.Create, connectorScope())),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const body = req.body as ConnectorBody;
      if (!body?.type || !body.name || !body.config || typeof body.config !== 'object') {
        res.status(400).json({
          error: { code: 'VALIDATION', message: 'type, name, and config are required' },
        });
        return;
      }
      if (body.id && (await service.get(orgId, body.id))) {
        res.status(409).json({
          error: { code: 'CONFLICT', message: `Connector "${body.id}" already exists` },
        });
        return;
      }
      const connector = await service.create({
        id: body.id,
        orgId,
        type: body.type,
        name: body.name,
        config: body.config,
        isDefault: body.isDefault ?? false,
        createdBy: userIdFromReq(req),
      });
      // Seed sensible policy defaults for kubernetes connectors so the first
      // read-only kubectl call doesn't get rejected by the policy gate. Seeds
      // are written at org scope (subjectType='org', subjectId=<orgId>); admins
      // can override per-team later via the Policies dialog.
      //
      // Why the swallow: both `deps.policies` and `repo.upsertPolicy` are
      // optional on ConnectorService (see connector-service.ts). A minimal
      // in-memory ConnectorRepository without policy support is a legal
      // configuration (used by some bootstrap/test paths), and in that case
      // `service.upsertPolicy` throws "connector policy repository is not
      // wired". We don't want connector creation to fail just because the
      // deployment opted out of policy storage — runtime gating fails closed
      // anyway, so the worst case is "no pre-seeded allows."
      if (connector.type === 'kubernetes') {
        for (const seed of KUBERNETES_DEFAULT_POLICIES) {
          try {
            await service.upsertPolicy(orgId, {
              connectorId: connector.id,
              subjectType: 'org',
              subjectId: orgId,
              capability: seed.capability,
              scope: null,
              humanPolicy: seed.humanPolicy,
            });
          } catch {
            // Policy repo not wired in this deployment — skip seeding.
          }
        }
      }
      res.status(201).json({ connector: maskForWire(connector) });
    },
  );

  router.get(
    '/:id',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.Read, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const id = req.params['id'] ?? '';
      const connector = await service.get(orgId, id);
      if (!connector) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${id}" not found` } });
        return;
      }
      res.json({ connector: maskForWire(connector) });
    },
  );

  router.put(
    '/:id',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.Write, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const id = req.params['id'] ?? '';
      const body = req.body as ConnectorBody & { status?: ConnectorStatus };
      const patch: ConnectorPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.config !== undefined) patch.config = body.config;
      if (body.status !== undefined) patch.status = body.status;
      if (body.isDefault !== undefined) patch.isDefault = body.isDefault;
      const connector = await service.update(orgId, id, patch);
      if (!connector) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${id}" not found` } });
        return;
      }
      res.json({ connector: maskForWire(connector) });
    },
  );

  router.delete(
    '/:id',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.Delete, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const id = req.params['id'] ?? '';
      const deleted = await service.delete(orgId, id);
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${id}" not found` } });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/test',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.Test, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const id = req.params['id'] ?? '';
      const result = await service.test(orgId, id);
      if (!result) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${id}" not found` } });
        return;
      }
      res.status(result.ok ? 200 : 400).json(result);
    },
  );

  router.post(
    '/:id/secret',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.Write, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const id = req.params['id'] ?? '';
      const body = req.body as { secret?: unknown };
      if (typeof body.secret !== 'string' || body.secret.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'secret is required' } });
        return;
      }
      const ok = await service.putSecret(orgId, id, body.secret);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${id}" not found` } });
        return;
      }
      res.json({ ok: true });
    },
  );

  router.get(
    '/:id/policies',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.PermissionsRead, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const connectorId = req.params['id'] ?? '';
      const subjectTypeRaw = req.query['subjectType'];
      const subjectIdRaw = req.query['subjectId'];
      const filter: { subjectType?: ConnectorSubjectType; subjectId?: string } = {};
      if (subjectTypeRaw !== undefined) {
        if (typeof subjectTypeRaw !== 'string' || !SUBJECT_TYPES.has(subjectTypeRaw as ConnectorSubjectType)) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: `subjectType must be 'org' or 'team'` },
          });
          return;
        }
        filter.subjectType = subjectTypeRaw as ConnectorSubjectType;
      }
      if (subjectIdRaw !== undefined) {
        if (typeof subjectIdRaw !== 'string' || subjectIdRaw.length === 0) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'subjectId must be a non-empty string' },
          });
          return;
        }
        filter.subjectId = subjectIdRaw;
      }
      const policies = await service.listPolicies(orgId, connectorId, filter);
      if (!policies) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${connectorId}" not found` } });
        return;
      }
      res.json({ policies });
    },
  );

  router.put(
    '/:id/policies',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.PermissionsWrite, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const connectorId = req.params['id'] ?? '';
      const body = req.body as ConnectorPolicyBody;
      if (
        !SUBJECT_TYPES.has(body.subjectType as ConnectorSubjectType) ||
        typeof body.subjectId !== 'string' ||
        body.subjectId.length === 0 ||
        typeof body.capability !== 'string' ||
        !HUMAN_POLICIES.has(body.humanPolicy as ConnectorPolicy['humanPolicy'])
      ) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'subjectType, subjectId, capability, and humanPolicy are required',
          },
        });
        return;
      }
      const policy = await service.upsertPolicy(orgId, {
        connectorId,
        subjectType: body.subjectType as ConnectorSubjectType,
        subjectId: body.subjectId,
        capability: body.capability,
        scope: body.scope ?? null,
        humanPolicy: body.humanPolicy as ConnectorPolicy['humanPolicy'],
      });
      if (!policy) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${connectorId}" not found` } });
        return;
      }
      res.json({ policy });
    },
  );

  router.delete(
    '/:id/policies/:subjectType/:subjectId/:capability',
    requirePermission((req) => ac.eval(CONNECTOR_ACTIONS.PermissionsWrite, connectorScope(req.params['id']))),
    async (req: Request, res: Response) => {
      const orgId = requireOrg(req, res);
      if (!orgId) return;
      const connectorId = req.params['id'] ?? '';
      const subjectTypeRaw = req.params['subjectType'] ?? '';
      const subjectId = req.params['subjectId'] ?? '';
      const capability = req.params['capability'] ?? '';
      if (!SUBJECT_TYPES.has(subjectTypeRaw as ConnectorSubjectType)) {
        res.status(400).json({
          error: { code: 'VALIDATION', message: `subjectType must be 'org' or 'team'` },
        });
        return;
      }
      const subjectType = subjectTypeRaw as ConnectorSubjectType;
      const deleted = await service.deletePolicy(orgId, connectorId, subjectType, subjectId, capability);
      if (deleted === null) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Connector "${connectorId}" not found` } });
        return;
      }
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connector policy not found' } });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
