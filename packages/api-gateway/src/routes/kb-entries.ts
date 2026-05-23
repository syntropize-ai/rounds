/**
 * Knowledge-base entries HTTP surface (generic CRUD).
 *
 *   GET    /api/kb/entries          — list (?kind=&source=&limit=)
 *   GET    /api/kb/entries/:id      — get by id
 *   POST   /api/kb/entries          — create (source forced to 'saved')
 *   PUT    /api/kb/entries/:id      — patch title/kind/intentTags/content/sourceRef
 *   DELETE /api/kb/entries/:id      — delete
 *
 * Bundled entries are read-only over HTTP: PUT/DELETE return 403 with
 * code BUNDLED_READONLY. The kb-templates router stays untouched and
 * remains the path for the "save dashboard as template" capture flow.
 *
 * Permission gating mirrors kb-templates.ts: reads use `chat:use` as the
 * lowest read scope every authenticated caller has; writes use
 * `dashboards:create` + `folders:*` to match kb-templates POST. Both
 * swap to `kb:read` / `kb:write` once those RBAC actions land.
 */

import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import {
  ac,
  ACTIONS,
  type IKnowledgeRepository,
  type KnowledgeEntry,
  type KnowledgeInsertInput,
  type KnowledgeKind,
  type KnowledgeListOptions,
  type KnowledgePatch,
  type KnowledgeSource,
} from '@agentic-obs/common';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { getOrgId } from '../middleware/workspace-context.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

export interface KbEntriesRouterDeps {
  knowledge: IKnowledgeRepository;
  accessControl: AccessControlSurface;
}

const VALID_KINDS: readonly KnowledgeKind[] = [
  'pattern',
  'template',
  'metric_doc',
  'system_fact',
];
const VALID_SOURCES: readonly KnowledgeSource[] = ['bundled', 'saved', 'distilled'];

function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

function isKnowledgeKind(v: unknown): v is KnowledgeKind {
  return typeof v === 'string' && (VALID_KINDS as readonly string[]).includes(v);
}

function isKnowledgeSource(v: unknown): v is KnowledgeSource {
  return typeof v === 'string' && (VALID_SOURCES as readonly string[]).includes(v);
}

interface CreateBody {
  id?: string;
  title: string;
  kind: KnowledgeKind;
  intentTags: string[];
  content: Record<string, unknown>;
  sourceRef?: string | null;
}

function validateCreate(raw: unknown): { ok: true; body: CreateBody } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b['title'] !== 'string' || !b['title'].trim()) {
    return { ok: false, message: 'title is required' };
  }
  if (!isKnowledgeKind(b['kind'])) {
    return { ok: false, message: `kind must be one of: ${VALID_KINDS.join(', ')}` };
  }
  if (!Array.isArray(b['intentTags']) || !b['intentTags'].every((t) => typeof t === 'string')) {
    return { ok: false, message: 'intentTags must be an array of strings' };
  }
  if (!b['content'] || typeof b['content'] !== 'object' || Array.isArray(b['content'])) {
    return { ok: false, message: 'content must be an object' };
  }
  const out: CreateBody = {
    title: b['title'].trim(),
    kind: b['kind'],
    intentTags: b['intentTags'] as string[],
    content: b['content'] as Record<string, unknown>,
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
  const patch: KnowledgePatch = {};
  if ('title' in b) {
    if (typeof b['title'] !== 'string' || !b['title'].trim()) {
      return { ok: false, message: 'title must be a non-empty string' };
    }
    patch.title = b['title'].trim();
  }
  if ('kind' in b) {
    if (!isKnowledgeKind(b['kind'])) {
      return { ok: false, message: `kind must be one of: ${VALID_KINDS.join(', ')}` };
    }
    patch.kind = b['kind'];
  }
  if ('intentTags' in b) {
    if (!Array.isArray(b['intentTags']) || !b['intentTags'].every((t) => typeof t === 'string')) {
      return { ok: false, message: 'intentTags must be an array of strings' };
    }
    patch.intentTags = b['intentTags'] as string[];
  }
  if ('content' in b) {
    if (!b['content'] || typeof b['content'] !== 'object' || Array.isArray(b['content'])) {
      return { ok: false, message: 'content must be an object' };
    }
    patch.content = b['content'];
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
  if (typeof q['kind'] === 'string') {
    if (!isKnowledgeKind(q['kind'])) {
      return { ok: false, message: `kind must be one of: ${VALID_KINDS.join(', ')}` };
    }
    opts.kind = q['kind'];
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
    async (req: Request, res: Response, next: NextFunction) => {
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
    },
  );

  // GET /api/kb/entries/:id — get
  router.get(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
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
    },
  );

  // POST /api/kb/entries — create (source forced to 'saved')
  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
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
          kind: parsed.body.kind,
          title: parsed.body.title,
          intentTags: parsed.body.intentTags,
          content: parsed.body.content,
          createdBy: userId,
        };
        const entry = await deps.knowledge.insert(input);
        res.status(201).json({ entry });
      } catch (err) {
        next(err);
      }
    },
  );

  // PUT /api/kb/entries/:id — update
  router.put(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
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
    },
  );

  // DELETE /api/kb/entries/:id
  router.delete(
    '/:id',
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
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
    },
  );

  return router;
}
