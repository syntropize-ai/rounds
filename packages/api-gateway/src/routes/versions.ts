import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AssetType } from '@agentic-obs/common';
import { defaultVersionStore } from '@agentic-obs/data-layer';

const VALID_ASSET_TYPES: AssetType[] = ['dashboard', 'alert_rule', 'investigation_report'];

function isValidAssetType(value: string): value is AssetType {
  return (VALID_ASSET_TYPES as string[]).includes(value);
}

export function createVersionRouter(): Router {
  const router = Router();

  // GET /api/versions/:assetType/:assetId - list version history
  router.get('/:assetType/:assetId', (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` });
      return;
    }
    const history = defaultVersionStore.getHistory(assetType, assetId);
    res.json({ versions: history });
  });

  // GET /api/versions/:assetType/:assetId/:version - get specific version
  router.get('/:assetType/:assetId/:version', (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    const versionStr = req.params['version'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` });
      return;
    }
    const version = parseInt(versionStr, 10);
    if (isNaN(version) || version < 1) {
      res.status(400).json({ code: 'INVALID_VERSION', message: 'version must be a positive integer' });
      return;
    }
    const entry = defaultVersionStore.getVersion(assetType, assetId, version);
    if (!entry) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Version not found' });
      return;
    }
    res.json(entry);
  });

  // POST /api/versions/:assetType/:assetId/rollback - rollback to a version
  router.post('/:assetType/:assetId/rollback', (req: Request, res: Response) => {
    const assetType = req.params['assetType'] as string;
    const assetId = req.params['assetId'] as string;
    if (!isValidAssetType(assetType)) {
      res.status(400).json({ code: 'INVALID_ASSET_TYPE', message: `Invalid asset type: ${assetType}` });
      return;
    }
    const body = req.body as { version?: number };
    if (typeof body?.version !== 'number' || body.version < 1) {
      res.status(400).json({ code: 'INVALID_VERSION', message: 'body.version must be a positive integer' });
      return;
    }
    const snapshot = defaultVersionStore.rollback(assetType, assetId, body.version);
    if (snapshot === undefined) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Version not found' });
      return;
    }
    res.json({ snapshot });
  });

  return router;
}
