import { Router } from 'express';
import type { Request, Response } from 'express';
import { ACTIONS, ac } from '@agentic-obs/common';
import type {
  IOpsConnectorRepository,
  NewOpsConnector,
  OpsConnector,
  OpsConnectorConfig,
  OpsConnectorPatch,
} from '@agentic-obs/data-layer';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  LiveKubernetesConnectorRunner,
  validateKubernetesConnector,
  synthesizeKubeconfig,
  synthesizeInClusterKubeconfig,
  inClusterAvailable,
  type KubernetesConnectorRunner,
} from '../services/ops-connector-service.js';

export interface OpsConnectorsRouterDeps {
  connectors: IOpsConnectorRepository;
  ac: AccessControlSurface;
  runner?: KubernetesConnectorRunner;
}

interface OpsConnectorBody {
  id?: string;
  type?: 'kubernetes';
  name?: string;
  environment?: string | null;
  config?: OpsConnectorConfig;
  secretRef?: string | null;
  secret?: string | null;
  allowedNamespaces?: string[];
  capabilities?: string[];
}

function orgIdFromReq(req: Request): string | null {
  return (req as AuthenticatedRequest).auth?.orgId ?? null;
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

function validateBody(body: OpsConnectorBody): string | null {
  if (body.type !== undefined && body.type !== 'kubernetes') {
    return 'type must be kubernetes';
  }
  if (body.allowedNamespaces !== undefined && !Array.isArray(body.allowedNamespaces)) {
    return 'allowedNamespaces must be an array';
  }
  if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
    return 'capabilities must be an array';
  }
  return validateKubernetesConnector((body.config ?? {}) as OpsConnectorConfig);
}

function maskForWire(connector: OpsConnector): OpsConnector {
  return {
    ...connector,
    secret: connector.secret ? '••••••' : null,
  };
}

export function createOpsConnectorsRouter(deps: OpsConnectorsRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const requireRead = requirePermission(() =>
    ac.any(
      ac.eval(ACTIONS.OpsConnectorsRead, 'ops.connectors:*'),
      ac.eval(ACTIONS.InstanceConfigRead),
    ),
  );
  const requireWrite = requirePermission(() =>
    ac.any(
      ac.eval(ACTIONS.OpsConnectorsWrite, 'ops.connectors:*'),
      ac.eval(ACTIONS.InstanceConfigWrite),
    ),
  );
  const runner = deps.runner ?? new LiveKubernetesConnectorRunner();

  router.get('/', requireRead, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const connectors = await deps.connectors.listByOrg(orgId, { masked: true });
    res.json({ connectors });
  });

  router.post('/', requireWrite, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;

    const body = req.body as OpsConnectorBody;
    if (!body?.name) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'name is required' },
      });
      return;
    }
    const validation = validateBody(body);
    if (validation) {
      res.status(400).json({ error: { code: 'VALIDATION', message: validation } });
      return;
    }
    if (body.id && (await deps.connectors.findByIdInOrg(orgId, body.id))) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: `Ops connector "${body.id}" already exists` },
      });
      return;
    }

    // Mode-aware secret synthesis (T8 — Ops connector setup refactor).
    //
    //   in-cluster: read SA token + CA from /var/run/secrets/... and build a
    //               kubeconfig server-side. Reject if the gateway isn't
    //               running with a service-account mount.
    //   manual:     {server, token, caData?, insecureSkipTlsVerify?} →
    //               synthesize a kubeconfig YAML server-side. The frontend
    //               sends these in `body.manual` since they don't fit
    //               cleanly into the legacy {secret} field.
    //   kubeconfig: caller hands us a YAML string in `body.secret` — same
    //               path as before.
    //   secretRef:  unchanged.
    let resolvedSecret = body.secret ?? null;
    const cfg = (body.config ?? {}) as OpsConnectorConfig & {
      mode?: 'in-cluster' | 'kubeconfig' | 'manual';
    };
    const manual = (body as OpsConnectorBody & {
      manual?: {
        server?: string;
        token?: string;
        caData?: string;
        insecureSkipTlsVerify?: boolean;
      };
    }).manual;

    if (cfg.mode === 'in-cluster') {
      if (!inClusterAvailable()) {
        res.status(400).json({
          error: { code: 'VALIDATION', message: 'in-cluster mode requires the gateway to run with a Kubernetes service-account mount' },
        });
        return;
      }
      try {
        resolvedSecret = synthesizeInClusterKubeconfig();
      } catch (err) {
        res.status(400).json({
          error: { code: 'VALIDATION', message: err instanceof Error ? err.message : 'failed to synthesize in-cluster kubeconfig' },
        });
        return;
      }
    } else if (cfg.mode === 'manual' && manual) {
      if (!manual.server || !manual.token) {
        res.status(400).json({
          error: { code: 'VALIDATION', message: 'manual mode requires server and token' },
        });
        return;
      }
      resolvedSecret = synthesizeKubeconfig({
        server: manual.server,
        token: manual.token,
        caData: manual.caData,
        insecureSkipTlsVerify: manual.insecureSkipTlsVerify,
      });
    }

    const input: NewOpsConnector = {
      id: body.id,
      orgId,
      type: 'kubernetes',
      name: body.name,
      environment: body.environment ?? null,
      config: cfg,
      secretRef: body.secretRef ?? null,
      secret: resolvedSecret,
      allowedNamespaces: body.allowedNamespaces ?? [],
      capabilities: body.capabilities ?? [],
    };
    const created = await deps.connectors.create(input);
    res.status(201).json({ connector: maskForWire(created) });
  });

  router.get('/:id', requireRead, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const id = req.params['id'] ?? '';
    const connector = await deps.connectors.findByIdInOrg(orgId, id, { masked: true });
    if (!connector) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Ops connector "${id}" not found` },
      });
      return;
    }
    res.json({ connector });
  });

  router.delete('/:id', requireWrite, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const id = req.params['id'] ?? '';
    const deleted = await deps.connectors.delete(orgId, id);
    if (!deleted) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Ops connector "${id}" not found` },
      });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/:id/test', requireRead, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const id = req.params['id'] ?? '';
    const connector = await deps.connectors.findByIdInOrg(orgId, id);
    if (!connector) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Ops connector "${id}" not found` },
      });
      return;
    }
    const result = await runner.test(connector);
    const status = result.status === 'error' ? 400 : 200;
    await deps.connectors.update(orgId, id, {
      status: result.status,
      lastCheckedAt: new Date().toISOString(),
    } satisfies OpsConnectorPatch);
    res.status(status).json(result);
  });

  return router;
}
