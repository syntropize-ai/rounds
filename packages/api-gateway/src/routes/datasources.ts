// Dedicated CRUD + connection-test API for datasource management.
// Reads/writes to the same inMemoryConfig used by setup.ts.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getSetupConfig, updateDatasources } from './setup.js';
import type { DatasourceConfig } from './setup.js';
import { testDatasourceConnection } from '../utils/datasource.js';

// -- Router

export const datasourcesRouter = Router();

// GET /api/datasources - list all
datasourcesRouter.get('/', authMiddleware, (_req: Request, res: Response) => {
  const config = getSetupConfig();
  res.json({ datasources: config.datasources });
});

// POST /api/datasources/test - test connection without saving
// Registered BEFORE /:id route so the literal path "test" is not consumed by /:id.
datasourcesRouter.post('/test', authMiddleware, async (req: Request, res: Response) => {
  const body = req.body as Partial<DatasourceConfig>;
  if (!body?.type || !body.url) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'type and url are required' } });
    return;
  }

  const ds = body as DatasourceConfig;
  const result = await testDatasourceConnection(ds);
  res.status(result.ok ? 200 : 400).json(result);
});

// POST /api/datasources - create
datasourcesRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  const body = req.body as Partial<DatasourceConfig>;
  if (!body?.type || !body.url || !body.name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'type, name, and url are required' } });
    return;
  }

  const config = getSetupConfig();
  const ds = { ...body, id: `${body.type}-${Date.now()}` } as DatasourceConfig;
  if (config.datasources.find((d) => d.id === ds.id)) {
    res.status(409).json({ error: { code: 'CONFLICT', message: `Datasource with id "${ds.id}" already exists` } });
    return;
  }

  const datasources = [...config.datasources, ds];
  await updateDatasources(datasources);
  res.status(201).json({ datasource: ds });
});

// GET /api/datasources/:id - get one
datasourcesRouter.get('/:id', authMiddleware, (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const config = getSetupConfig();
  const ds = config.datasources.find((d) => d.id === id);
  if (!ds) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` } });
    return;
  }
  res.json({ datasource: ds });
});

// PUT /api/datasources/:id - update
datasourcesRouter.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const config = getSetupConfig();
  const idx = config.datasources.findIndex((d) => d.id === id);
  if (idx < 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` } });
    return;
  }

  const updated: DatasourceConfig = { ...(config.datasources[idx] as DatasourceConfig), ...(req.body as Partial<DatasourceConfig>), id };
  const datasources = [...config.datasources];
  datasources[idx] = updated;
  await updateDatasources(datasources);
  res.json({ datasource: updated });
});

// DELETE /api/datasources/:id - delete
datasourcesRouter.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const config = getSetupConfig();
  const exists = config.datasources.find((d) => d.id === id);
  if (!exists) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` } });
    return;
  }

  await updateDatasources(config.datasources.filter((d) => d.id !== id));
  res.json({ ok: true });
});

// POST /api/datasources/:id/test - test a saved datasource by id
datasourcesRouter.post('/:id/test', authMiddleware, async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const config = getSetupConfig();
  const ds = config.datasources.find((d) => d.id === id);
  if (!ds) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Datasource "${id}" not found` } });
    return;
  }

  const result = await testDatasourceConnection(ds);
  res.status(result.ok ? 200 : 400).json(result);
});
