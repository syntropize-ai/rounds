import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ApiError } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import { defaultWorkspaceStore, WorkspaceStore } from '@agentic-obs/data-layer';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createWorkspaceRouter(store: WorkspaceStore = defaultWorkspaceStore): Router {
  const router = Router();
  router.use(authMiddleware);

  // GET /api/workspaces - list workspaces for current user
  router.get('/', (req: Request, res: Response): void => {
    const userId = (req as any).userId as string | undefined;
    if (!userId) {
      const err: ApiError = { code: 'UNAUTHORIZED', message: 'authentication required' };
      res.status(401).json(err);
      return;
    }
    const workspaces = store.findByMember(userId);
    res.json({ list: workspaces });
  });

  // POST /api/workspaces - create workspace
  router.post('/', (req: Request, res: Response): void => {
    const userId = (req as any).userId as string | undefined;
    if (!userId) {
      const err: ApiError = { code: 'UNAUTHORIZED', message: 'authentication required' };
      res.status(401).json(err);
      return;
    }

    const { name, slug, settings } = req.body as {
      name?: string;
      slug?: string;
      settings?: Record<string, unknown>;
    };

    if (typeof name !== 'string' || !name.trim()) {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'name is required and must be a non-empty string' };
      res.status(400).json(err);
      return;
    }

    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      const err: ApiError = {
        code: 'INVALID_INPUT',
        message: 'slug is required and must be a lowercase alphanumeric string with hyphens (e.g. "my-workspace")',
      };
      res.status(400).json(err);
      return;
    }

    // Check slug uniqueness
    if (store.findBySlug(slug)) {
      const err: ApiError = { code: 'CONFLICT', message: `a workspace with slug "${slug}" already exists` };
      res.status(409).json(err);
      return;
    }

    const workspace = store.create({
      name: name.trim(),
      slug,
      ownerId: userId,
      settings: settings as any,
    });

    res.status(201).json(workspace);
  });

  // GET /api/workspaces/:id - get workspace
  router.get('/:id', (req: Request, res: Response): void => {
    const workspace = store.findById(req.params['id']!);
    if (!workspace) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }
    res.json(workspace);
  });

  // PUT /api/workspaces/:id - update workspace
  router.put('/:id', (req: Request, res: Response): void => {
    const { name, slug, settings } = req.body as {
      name?: string;
      slug?: string;
      settings?: Record<string, unknown>;
    };

    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        const err: ApiError = { code: 'INVALID_INPUT', message: 'name must be a non-empty string' };
        res.status(400).json(err);
        return;
      }
      patch.name = name.trim();
    }
    if (slug !== undefined) {
      if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
        const err: ApiError = { code: 'INVALID_INPUT', message: 'slug must be a lowercase alphanumeric string with hyphens' };
        res.status(400).json(err);
        return;
      }
      const existing = store.findBySlug(slug);
      if (existing && existing.id !== req.params['id']) {
        const err: ApiError = { code: 'CONFLICT', message: `a workspace with slug "${slug}" already exists` };
        res.status(409).json(err);
        return;
      }
      patch.slug = slug;
    }
    if (settings !== undefined) {
      patch.settings = settings;
    }

    const updated = store.update(req.params['id']!, patch as any);
    if (!updated) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }
    res.json(updated);
  });

  // DELETE /api/workspaces/:id - delete workspace
  router.delete('/:id', (req: Request, res: Response): void => {
    const deleted = store.delete(req.params['id']!);
    if (!deleted) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }
    res.status(204).end();
  });

  // POST /api/workspaces/:id/members - add member
  router.post('/:id/members', (req: Request, res: Response): void => {
    const { userId, role } = req.body as { userId?: string; role?: string };

    if (typeof userId !== 'string' || !userId.trim()) {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'userId is required' };
      res.status(400).json(err);
      return;
    }

    const validRoles = ['admin', 'editor', 'viewer'] as const;
    if (!role || !validRoles.includes(role as any)) {
      const err: ApiError = { code: 'INVALID_INPUT', message: `role must be one of: ${validRoles.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    const updated = store.addMember(req.params['id']!, {
      userId: userId.trim(),
      role: role as 'admin' | 'editor' | 'viewer',
    });

    if (!updated) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }

    res.json(updated);
  });

  // DELETE /api/workspaces/:id/members/:userId - remove member
  router.delete('/:id/members/:userId', (req: Request, res: Response): void => {
    const workspace = store.findById(req.params['id']!);
    if (!workspace) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }

    if (workspace.ownerId === req.params['userId']) {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'cannot remove the workspace owner' };
      res.status(400).json(err);
      return;
    }

    const updated = store.removeMember(req.params['id']!, req.params['userId']!);
    if (!updated) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'workspace not found' };
      res.status(404).json(err);
      return;
    }

    res.json(updated);
  });

  return router;
}
