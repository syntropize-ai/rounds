/**
 * Knowledge-base entries HTTP surface (skill-style unified CRUD).
 *
 *   GET    /api/kb/entries          — list (?source=&limit=)
 *   GET    /api/kb/entries/:id      — get by id
 *   POST   /api/kb/entries          — create (source forced to 'saved')
 *   PUT    /api/kb/entries/:id      — patch title/description/body/intentTags/sourceRef
 *   DELETE /api/kb/entries/:id      — delete
 *
 * Entries no longer carry a `kind` — every entry is a unified skill-style
 * record (title + description + markdown body + tags). The old `?kind=`
 * filter / `kind` field returns 400 so stale clients see the break.
 *
 * Bundled entries are read-only over HTTP: PUT/DELETE return 403 with
 * code BUNDLED_READONLY. POST with id starting `bundled-` returns 409.
 */

import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import {
  ac,
  ACTIONS,
  type IKnowledgeRepository,
  type KnowledgeEntry,
  type KnowledgeInsertInput,
  type KnowledgeListOptions,
  type KnowledgePatch,
  type KnowledgeSource,
} from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { getOrgId } from '../middleware/workspace-context.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { asyncHandler } from '../middleware/async-handler.js';

export interface KbEntriesRouterDeps {
  knowledge: IKnowledgeRepository;
  accessControl: AccessControlSurface;
}

const VALID_SOURCES: readonly KnowledgeSource[] = ['bundled', 'saved', 'distilled'];

const KIND_REMOVED_MSG = 'kind is no longer supported; entries are unified';

function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

function isKnowledgeSource(v: unknown): v is KnowledgeSource {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v);
}

interface CreateBody {
  id?: string;
  title: string;
  description: string;
  body: string;
  intentTags: string[];
  sourceRef?: string | null;
}

function validateCreate(raw: unknown): { ok: true; body: CreateBody } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if ('kind' in b) {
    return { ok: false, message: KIND_REMOVED_MSG };
  }
  if (typeof b['title'] !== 'string' || !b['title'].trim()) {
    return { ok: false, message: 'title is required' };
  }
  if (typeof b['description'] !== 'string' || !b['description'].trim()) {
    return { ok: false, message: 'description is required' };
  }
  if ('body' in b && typeof b['body'] !== 'string') {
    return { ok: false, message: 'body must be a string' };
  }
  if ('intentTags' in b) {
    if (!Array.isArray(b['intentTags']) || !b['intentTags'].every((t) => typeof t === 'string')) {
      return { ok: false, message: 'intentTags must be an array of strings' };
    }
  }
  const out: CreateBody = {
    title: b['title'].trim(),
    description: b['description'].trim(),
    body: typeof b['body'] === 'string' ? b['body'] : '',
    intentTags: Array.isArray(b['intentTags']) ? (b['intentTags'] as string[]) : [],
  };
  if (typeof b['id'] === 'string' && b['id'].trim()) out.id = b['id'].trim();
  if (b['sourceRef'] === null || typeof b['sourceRef'] === 'string') {
    out.sourceRef = b['sourceRef'] as string | null;
  }
  return { ok: true, body: out };
}

function validatePatch(raw: unknown): { ok: true; patch: KnowledgePatch } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if ('kind' in b) {
    return { ok: false, message: KIND_REMOVED_MSG };
  }
  const patch: KnowledgePatch = {};
  if ('title' in b) {
    if (typeof b['title'] !== 'string' || !b['title'].trim()) {
      return { ok: false, message: 'title must be a non-empty string' };
    }
    patch.title = b['title'].trim();
  }
  if ('description' in b) {
    if (typeof b['description'] !== 'string' || !b['description'].trim()) {
      return { ok: false, message: 'description must be a non-empty string' };
    }
    patch.description = b['description'].trim();
  }
  if ('body' in b) {
    if (typeof b['body'] !== 'string') {
      return { ok: false, message: 'body must be a string' };
    }
    patch.body = b['body'];
  }
  if ('intentTags' in b) {
    if (!Array.isArray(b['intentTags']) || !b['intentTags'].every((t) => typeof t === 'string')) {
      return { ok: false, message: 'intentTags must be an array of strings' };
    }
    patch.intentTags = b['intentTags'] as string[];
  }
  if ('sourceRef' in b) {
    if (b['sourceRef'] !== null && typeof b['sourceRef'] !== 'string') {
      return { ok: false, message: 'sourceRef must be a string or null' };
    }
    patch.sourceRef = b['sourceRef'] as string | null;
  }
  return { ok: true, patch };
}

function parseListQuery(req: Request): { ok: true; opts: KnowledgeListOptions } | { ok: false; message: string } {
  const opts: KnowledgeListOptions = {};
  const q = req.query as Record<string, unknown>;
  if ('kind' in q) {
    return { ok: false, message: KIND_REMOVED_MSG };
  }
  if (typeof q['source'] === 'string') {
    if (!isKnowledgeSource(q['source'])) {
      return { ok: false, message: `source must be one of: ${VALID_SOURCES.join(', ')}` };
    }
    opts.source = q['source'];
  }
  if (typeof q['limit'] === 'string') {
    const n = Number.parseInt(q['limit'], 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: 'limit must be a positive integer' };
    }
    opts.limit = n;
  }
  return { ok: true, opts };
}

const BUNDLED_READONLY_MSG =
  "Bundled knowledge entries cannot be modified. Create a new entry with source='saved' instead.";

export function createKbEntriesRouter(deps: KbEntriesRouterDeps): ExpressRouter {
  const router = Router();
  const requirePermission = createRequirePermission(deps.accessControl);

  router.use(authMiddleware);

  // GET /api/kb/entries — list
  router.get(
    '/',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseListQuery(req);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.message } });
          return;
        }
        const orgId = resolveOrgId(req);
        const entries = await deps.knowledge.list(orgId, parsed.opts);
        res.json({ entries });
      } catch (err) {
        next(err);
      }
    }),
  );

  // GET /api/kb/entries/:id — get
  router.get(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const entry = await deps.knowledge.getById(orgId, req.params['id']!);
        if (!entry) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge entry not found' } });
          return;
        }
        res.json({ entry });
      } catch (err) {
        next(err);
      }
    }),
  );

  // POST /api/kb/entries — create (source forced to 'saved')
  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = validateCreate(req.body);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.message } });
          return;
        }
        const orgId = resolveOrgId(req);
        const userId = (req as AuthenticatedRequest).auth?.userId ?? null;
        const id = parsed.body.id ?? `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        if (id.startsWith('bundled-')) {
          res.status(409).json({
            error: {
              code: 'BUNDLED_NAMESPACE',
              message: "entry id cannot start with 'bundled-' (reserved for seed namespace)",
            },
          });
          return;
        }
        const input: KnowledgeInsertInput = {
          id,
          orgId,
          source: 'saved', // server-controlled — never trust the client.
          sourceRef: parsed.body.sourceRef ?? null,
          title: parsed.body.title,
          description: parsed.body.description,
          body: parsed.body.body,
          intentTags: parsed.body.intentTags,
          createdBy: userId,
        };
        const entry = await deps.knowledge.insert(input);
        res.status(201).json({ entry });
      } catch (err) {
        next(err);
      }
    }),
  );

  // PUT /api/kb/entries/:id — update
  router.put(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = validatePatch(req.body);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.message } });
          return;
        }
        const orgId = resolveOrgId(req);
        const existing = await deps.knowledge.getById(orgId, req.params['id']!);
        if (!existing) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge entry not found' } });
          return;
        }
        if (existing.source === 'bundled') {
          res.status(403).json({
            error: { code: 'BUNDLED_READONLY', message: BUNDLED_READONLY_MSG },
          });
          return;
        }
        const updated = await deps.knowledge.update(orgId, existing.id, parsed.patch);
        if (!updated) {
          // Race: row went away between getById and update.
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge entry not found' } });
          return;
        }
        res.json({ entry: updated });
      } catch (err) {
        next(err);
      }
    }),
  );

  // DELETE /api/kb/entries/:id
  router.delete(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const existing: KnowledgeEntry | null = await deps.knowledge.getById(orgId, req.params['id']!);
        if (!existing) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Knowledge entry not found' } });
          return;
        }
        if (existing.source === 'bundled') {
          res.status(403).json({
            error: { code: 'BUNDLED_READONLY', message: BUNDLED_READONLY_MSG },
          });
          return;
        }
        await deps.knowledge.delete(orgId, existing.id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    }),
  );

  return router;
}
