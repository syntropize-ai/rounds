import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AssetType, Evaluator, IDashboardRepository } from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import type {
  IAlertRuleRepository,
  IInvestigationReportRepository,
  IVersionRepository,
} from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

const VALID_ASSET_TYPES: AssetType[] = ['dashboard', 'alert_rule', 'investigation_report'];

function isValidAssetType(value: string): value is AssetType {
  return (VALID_ASSET_TYPES as string[]).includes(value);
}

export interface VersionRouterDeps {
  store: IVersionRepository;
  dashboards: IDashboardRepository;
  alertRules: IAlertRuleRepository;
  investigationReports: IInvestigationReportRepository;
  /**
   * RBAC surface. Version history is the asset's audit trail, so route
   * handlers gate on each asset type's own read/write action after confirming
   * the asset belongs to the authenticated org.
   */
  ac: AccessControlSurface;
}

type VersionMode = 'read' | 'write';

function currentOrgId(req: Request): string {
  return (req as AuthenticatedRequest).auth!.orgId;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found' } });
}

function forbidden(res: Response, evaluator: Evaluator): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: `User has no permission to ${evaluator.string()}`,
    },
  });
}

async function assetExistsInOrg(
  deps: VersionRouterDeps,
  assetType: AssetType,
  assetId: string,
  orgId: string,
): Promise<boolean> {
  if (assetType === 'dashboard') {
    const dashboard = await deps.dashboards.findById(assetId);
    return !!dashboard && dashboard.workspaceId === orgId;
  }

  if (assetType === 'alert_rule') {
    const rule = await deps.alertRules.findById(assetId);
    return !!rule && rule.workspaceId === orgId;
  }

  const report = await deps.investigationReports.findById(assetId);
  if (!report) return false;
  const dashboard = await deps.dashboards.findById(report.dashboardId);
  return !!dashboard && dashboard.workspaceId === orgId;
}

function evaluatorFor(assetType: AssetType, assetId: string, mode: VersionMode): Evaluator {
  if (assetType === 'dashboard') {
    return ac.eval(
      mode === 'read' ? ACTIONS.DashboardsRead : ACTIONS.DashboardsWrite,
      `dashboards:uid:${assetId}`,
    );
  }

  if (assetType === 'alert_rule') {
    return ac.eval(
      mode === 'read' ? ACTIONS.AlertRulesRead : ACTIONS.AlertRulesWrite,
      `alert.rules:uid:${assetId}`,
    );
  }

  return ac.eval(
    mode === 'read' ? ACTIONS.InvestigationsRead : ACTIONS.InvestigationsWrite,
    'investigations:*',
  );
}

async function authorizeAsset(
  deps: VersionRouterDeps,
  req: Request,
  res: Response,
  assetType: AssetType,
  assetId: string,
  mode: VersionMode,
): Promise<boolean> {
  const orgId = currentOrgId(req);
  if (!await assetExistsInOrg(deps, assetType, assetId, orgId)) {
    notFound(res);
    return false;
  }

  const evaluator = evaluatorFor(assetType, assetId, mode);
  const allowed = await deps.ac.evaluate((req as AuthenticatedRequest).auth!, evaluator);
  if (!allowed) {
    forbidden(res, evaluator);
    return false;
  }
  return true;
}

export function createVersionRouter(deps: VersionRouterDeps): Router {
  const store = deps.store;
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    authMiddleware(req as AuthenticatedRequest, res, next);
  });

  // GET /api/versions/:assetType/:assetId - list version history
  router.get('/:assetType/:assetId', async (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ error: { code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` } });
      return;
    }
    if (!await authorizeAsset(deps, req, res, assetType, assetId, 'read')) {
      return;
    }
    const history = await store.getHistory(assetType, assetId);
    res.json({ versions: history });
  });

  // POST /api/versions/:assetType/:assetId/rollback - rollback to a version
  router.post('/:assetType/:assetId/rollback', async (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ error: { code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` } });
      return;
    }
    const body = req.body as { version?: number };
    if (typeof body?.version !== 'number' || body.version < 1) {
      res.status(400).json({ error: { code: 'INVALID_VERSION', message: 'body.version must be a positive integer' } });
      return;
    }
    if (!await authorizeAsset(deps, req, res, assetType, assetId, 'write')) {
      return;
    }
    const snapshot = await store.rollback(assetType, assetId, body.version);
    if (snapshot === undefined) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } });
      return;
    }
    res.json({ snapshot });
  });

  // GET /api/versions/:assetType/:assetId/:version - get specific version
  router.get('/:assetType/:assetId/:version', async (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    const versionStr = req.params['version'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ error: { code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` } });
      return;
    }
    const version = parseInt(versionStr, 10);
    if (isNaN(version) || version < 1) {
      res.status(400).json({ error: { code: 'INVALID_VERSION', message: 'version must be a positive integer' } });
      return;
    }
    if (!await authorizeAsset(deps, req, res, assetType, assetId, 'read')) {
      return;
    }
    const entry = await store.getVersion(assetType, assetId, version);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } });
      return;
    }
    res.json(entry);
  });

  return router;
}
