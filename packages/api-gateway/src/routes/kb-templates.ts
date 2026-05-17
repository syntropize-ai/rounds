/**
 * Knowledge-base templates HTTP surface.
 *
 *   POST /api/kb/templates   — capture a live dashboard as a template by
 *                              replacing literal values with `${VAR}`
 *                              placeholders, then storing in the KB.
 *   GET  /api/kb/templates   — list KB entries with kind=template.
 *
 * The permission gate uses existing RBAC actions as placeholders until B1
 * lands the dedicated `kb:read` / `kb:write` actions; one-line swap when
 * those merge.
 */

import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import {
  ac,
  ACTIONS,
  type Dashboard,
  type DashboardVariable,
  type IKnowledgeRepository,
  type KnowledgeInsertInput,
  type PanelConfig,
  type TemplateContent,
  type TemplateVariable,
} from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '@agentic-obs/data-layer';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { getOrgId } from '../middleware/workspace-context.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

export interface KbTemplateParamSpec {
  key: string;
  label: string;
  literalValue: string;
  defaultValue?: string;
}

export interface CreateKbTemplateBody {
  dashboardId: string;
  paramSpec: KbTemplateParamSpec[];
  intentTags?: string[];
  notes?: string;
}

export interface KbTemplateRouterDeps {
  knowledge: IKnowledgeRepository;
  dashboards: IGatewayDashboardStore;
  accessControl: AccessControlSurface;
}

function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

function validateBody(raw: unknown): { ok: true; body: CreateKbTemplateBody } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b['dashboardId'] !== 'string' || !b['dashboardId'].trim()) {
    return { ok: false, message: 'dashboardId is required' };
  }
  if (!Array.isArray(b['paramSpec'])) {
    return { ok: false, message: 'paramSpec must be an array' };
  }
  const paramSpec: KbTemplateParamSpec[] = [];
  for (const item of b['paramSpec'] as unknown[]) {
    if (!item || typeof item !== 'object') {
      return { ok: false, message: 'paramSpec items must be objects' };
    }
    const p = item as Record<string, unknown>;
    if (typeof p['key'] !== 'string' || !p['key'].trim()) {
      return { ok: false, message: 'paramSpec[].key is required' };
    }
    if (typeof p['label'] !== 'string') {
      return { ok: false, message: 'paramSpec[].label is required' };
    }
    if (typeof p['literalValue'] !== 'string' || p['literalValue'].length === 0) {
      return { ok: false, message: 'paramSpec[].literalValue is required (non-empty)' };
    }
    paramSpec.push({
      key: p['key'],
      label: p['label'],
      literalValue: p['literalValue'],
      ...(typeof p['defaultValue'] === 'string' ? { defaultValue: p['defaultValue'] } : {}),
    });
  }
  return {
    ok: true,
    body: {
      dashboardId: (b['dashboardId'] as string).trim(),
      paramSpec,
      ...(Array.isArray(b['intentTags']) ? { intentTags: (b['intentTags'] as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
      ...(typeof b['notes'] === 'string' ? { notes: b['notes'] } : {}),
    },
  };
}

/** Replace every occurrence of `literal` in `s` with `${KEY}`. */
function substitute(s: string, literal: string, key: string): string {
  if (!s || !literal) return s;
  // Plain string replaceAll — KB params can hold regex metacharacters.
  return s.split(literal).join('\${' + key + '}');
}

function rewritePanel(panel: PanelConfig, paramSpec: KbTemplateParamSpec[]): PanelConfig {
  const queries = (panel.queries ?? []).map((q) => {
    let expr = q.expr;
    let legendFormat = q.legendFormat ?? '';
    for (const p of paramSpec) {
      expr = substitute(expr, p.literalValue, p.key);
      legendFormat = substitute(legendFormat, p.literalValue, p.key);
    }
    return {
      ...q,
      expr,
      ...(q.legendFormat !== undefined ? { legendFormat } : {}),
    };
  });
  let title = panel.title;
  for (const p of paramSpec) {
    title = substitute(title, p.literalValue, p.key);
  }
  return { ...panel, title, queries };
}

function buildTemplateContent(
  dashboard: Dashboard,
  paramSpec: KbTemplateParamSpec[],
  notes: string,
): TemplateContent {
  const panels = (dashboard.panels ?? []).map((p) => rewritePanel(p, paramSpec));
  const variables: TemplateVariable[] = paramSpec.map((p) => ({
    key: p.key,
    label: p.label,
    defaultValue: p.defaultValue ?? '',
  }));
  // Deep-clone existing dashboard variables forward — they may carry $vars
  // the agent still expects. They appear AFTER the new template variables
  // so substitution variables are surfaced first in the UI.
  for (const v of (dashboard.variables ?? []) as DashboardVariable[]) {
    variables.push({ key: v.name, label: v.label ?? v.name, defaultValue: v.current ?? '' });
  }
  return { panels: panels as unknown as TemplateContent['panels'], variables, notes };
}

export function createKbTemplatesRouter(deps: KbTemplateRouterDeps): ExpressRouter {
  const router = Router();
  const requirePermission = createRequirePermission(deps.accessControl);

  router.use(authMiddleware);

  // GET /api/kb/templates — list KB entries (kind=template) for the org.
  router.get(
    '/',
    // Placeholder gate: `kb:read` is landing in B1's RBAC change. `chat:use`
    // is the lowest existing read scope every authenticated agent caller has.
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const entries = await deps.knowledge.list(orgId, { kind: 'template' });
        res.json({ entries });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/kb/templates — save dashboard as template.
  router.post(
    '/',
    // Placeholder gate: `kb:write` is landing in B1's RBAC change. Until
    // then we gate on `dashboards:create` — saving a template is closely
    // tied to dashboard authoring, so the role set already lines up.
    requirePermission(() => ac.eval(ACTIONS.DashboardsCreate, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = validateBody(req.body);
        if (!parsed.ok) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: parsed.message } });
          return;
        }
        const orgId = resolveOrgId(req);
        const dashboard = await deps.dashboards.findById(parsed.body.dashboardId);
        if (!dashboard || dashboard.workspaceId !== orgId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Dashboard not found' } });
          return;
        }
        // Per-row read gate on the source dashboard. Folder-RBAC would 403
        // here for a caller without read on the source's folder.
        const canRead = await deps.accessControl.evaluate(
          (req as AuthenticatedRequest).auth!,
          ac.eval(ACTIONS.DashboardsRead, `dashboards:uid:${dashboard.id}`),
        );
        if (!canRead) {
          res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'no permission to read source dashboard' },
          });
          return;
        }

        const content = buildTemplateContent(
          dashboard,
          parsed.body.paramSpec,
          parsed.body.notes ?? '',
        );
        const userId = (req as AuthenticatedRequest).auth?.userId ?? null;
        const id = `tpl-${dashboard.id}-${Date.now().toString(36)}`;
        const insertInput: KnowledgeInsertInput = {
          id,
          orgId,
          source: 'saved',
          sourceRef: dashboard.id,
          kind: 'template',
          title: `${dashboard.title} (template)`,
          intentTags: parsed.body.intentTags ?? [],
          content,
          createdBy: userId,
        };
        const entry = await deps.knowledge.insert(insertInput);
        res.status(201).json({ id: entry.id });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
