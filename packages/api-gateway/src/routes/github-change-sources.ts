import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw as expressRaw } from 'express';
import type { Request, Response } from 'express';
import { ACTIONS, ac } from '@agentic-obs/common';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { GitHubChangeSourceRegistry } from '../services/github-change-source-service.js';

export interface GithubChangeSourcesRouterDeps {
  registry: GitHubChangeSourceRegistry;
  ac: AccessControlSurface;
}

interface CreateGithubSourceBody {
  name?: string;
  owner?: string;
  repo?: string;
  events?: string[];
  secret?: string;
  active?: boolean;
}

function orgIdFromReq(req: Request): string | null {
  return (req as AuthenticatedRequest).auth?.orgId ?? null;
}

function requireOrg(req: Request, res: Response): string | null {
  const orgId = orgIdFromReq(req);
  if (!orgId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'org context is required' } });
    return null;
  }
  return orgId;
}

function verifyGitHubSignature(payload: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const actual = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function createGithubChangeSourcesRouter(deps: GithubChangeSourcesRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const requireRead = requirePermission(() =>
    ac.any(
      ac.eval(ACTIONS.DatasourcesRead, 'datasources:*'),
      ac.eval(ACTIONS.InstanceConfigRead),
    ),
  );
  const requireWrite = requirePermission(() =>
    ac.any(
      ac.eval(ACTIONS.DatasourcesWrite, 'datasources:*'),
      ac.eval(ACTIONS.InstanceConfigWrite),
    ),
  );

  router.post(
    '/github/:id/webhook',
    expressRaw({ type: () => true }),
    async (req: Request, res: Response) => {
      const id = req.params['id'] ?? '';
      const secret = await deps.registry.getSecret(id);
      if (!secret) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'GitHub change source not found' } });
        return;
      }
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : ((req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? '')));
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!verifyGitHubSignature(rawBody, signature, secret)) {
        res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature mismatch' } });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Webhook body must be JSON' } });
        return;
      }

      const eventName = req.headers['x-github-event'] as string | undefined;
      if (!eventName) {
        res.status(400).json({ error: { code: 'MISSING_EVENT', message: 'X-GitHub-Event is required' } });
        return;
      }
      const result = await deps.registry.ingestGitHubWebhook(id, eventName, payload);
      if (!result.ok) {
        res.status(result.status).json({ error: { code: 'INGEST_FAILED', message: result.message } });
        return;
      }
      res.json({ received: true, ignored: result.ignored, record: result.record ?? null });
    },
  );

  router.use(authMiddleware);

  router.get('/github', requireRead, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    res.json({ sources: await deps.registry.list(orgId) });
  });

  router.post('/github', requireWrite, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const body = req.body as CreateGithubSourceBody;
    if (!body?.name?.trim()) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required' } });
      return;
    }
    const source = await deps.registry.create({
      orgId,
      name: body.name.trim(),
      owner: body.owner?.trim() || undefined,
      repo: body.repo?.trim() || undefined,
      events: body.events?.filter((event) => typeof event === 'string' && event.trim()).map((event) => event.trim()),
      secret: body.secret?.trim() || undefined,
      active: body.active,
    });
    res.status(201).json({ source });
  });

  router.delete('/github/:id', requireWrite, async (req: Request, res: Response) => {
    const orgId = requireOrg(req, res);
    if (!orgId) return;
    const deleted = await deps.registry.delete(orgId, req.params['id'] ?? '');
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'GitHub change source not found' } });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
