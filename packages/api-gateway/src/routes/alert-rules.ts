import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AlertRule, AlertSilence, NotificationPolicy } from '@agentic-obs/common';
import { getErrorMessage, ac, ACTIONS } from '@agentic-obs/common';
import type { IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import { defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { AlertRuleService } from '../services/alert-rule-service.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { getOrgId } from '../middleware/workspace-context.js';

/**
 * Resolve the current request's org id. Prefers `req.auth.orgId` populated by
 * the auth middleware (post-T9 cutover); falls back to the header/query
 * helper for test harnesses that bypass auth. The result is passed as
 * `workspaceId` into the alert-rule store until the store's internal column
 * rename lands (tracked separately).
 */
function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

export interface AlertRulesRouterDeps {
  alertRuleStore?: IAlertRuleRepository;
  investigationStore?: IGatewayInvestigationStore;
  feedStore?: IGatewayFeedStore;
  reportStore?: IInvestigationReportRepository;
  /** W2 / T2.4 — required for the `/generate` endpoint to reach the LLM config. */
  setupConfig: SetupConfigService;
  /**
   * RBAC surface. `AccessControlSurface` is used (not the concrete service)
   * because this router is mounted outside the async auth IIFE in server.ts
   * — the holder forwards to the real service once it's built.
   */
  ac: AccessControlSurface;
}

export function createAlertRulesRouter(deps: AlertRulesRouterDeps): Router {
  const store = deps.alertRuleStore ?? defaultAlertRuleStore;
  const router = Router();
  const alertRuleService = new AlertRuleService(store, deps.setupConfig);
  const requirePermission = createRequirePermission(deps.ac);

  // Scope note: Editor's built-in grants for alert-rule CRUD are keyed on
  // `folders:*` (see roles-def.ts — matching Grafana's "alerts live in
  // folders" model). For per-rule reads / writes we use
  // `alert.rules:uid:<id>`; the alert.rules resolver expands that to the
  // owning folder's scope so a folder-scoped grant still wins.
  //
  // Per-rule endpoints could additionally look up the folder and check
  // against `folders:uid:<folderUid>` explicitly, but the resolver layer
  // already does that cascade, so checking against the rule uid keeps the
  // route signature simple.

  router.use((req: Request, res: Response, next: NextFunction) => {
    authMiddleware(req as AuthenticatedRequest, res, next);
  });

  // -- POST /api/alert-rules/generate - NL -> alert rule (no dashboard needed)
  // IMPORTANT: must be before /:id routes

  router.post(
    '/generate',
    requirePermission(() => ac.eval(ACTIONS.AlertRulesCreate, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as { prompt?: string };
        if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'prompt is required' } });
          return;
        }

        const { rule } = await alertRuleService.generateFromPrompt(body.prompt.trim());
        // Stamp workspace on generated rule
        const workspaceId = resolveOrgId(req);
        if (workspaceId !== 'default') {
          await store.update(rule.id, { workspaceId, labels: { ...rule.labels, workspaceId } });
        }
        res.status(201).json(rule);
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        if (message.includes('LLM not configured')) {
          res.status(503).json({ error: { code: 'LLM_NOT_CONFIGURED', message } });
          return;
        }
        next(err);
      }
    },
  );

  // -- Alert Rules CRUD

  router.get(
    '/',
    requirePermission(() => ac.eval(ACTIONS.AlertRulesRead, 'folders:*')),
    async (req: Request, res: Response) => {
      const state = req.query['state'] as string | undefined;
      const severity = req.query['severity'] as string | undefined;
      const search = req.query['search'] as string | undefined;
      const limit = req.query['limit'] ? parseInt(req.query['limit'] as string) : undefined;
      const offset = req.query['offset'] ? parseInt(req.query['offset'] as string) : undefined;
      const workspaceId = resolveOrgId(req);

      const results = await store.findAll({
        state: state as AlertRule['state'] | undefined,
        severity,
        search,
        limit,
        offset,
      });

      // Filter by workspace
      results.list = results.list.filter((r) => (r.workspaceId ?? 'default') === workspaceId);
      results.total = results.list.length;

      res.json(results);
    },
  );

  router.get(
    '/silences/all',
    requirePermission(() => ac.eval(ACTIONS.AlertSilencesRead)),
    async (_req: Request, res: Response) => {
      res.json(await store.findAllSilencesIncludingExpired());
    },
  );

  router.get(
    '/silences',
    requirePermission(() => ac.eval(ACTIONS.AlertSilencesRead)),
    async (_req: Request, res: Response) => {
      res.json(await store.findSilences());
    },
  );

  router.post(
    '/silences',
    requirePermission(() => ac.eval(ACTIONS.AlertSilencesCreate)),
    async (req: Request, res: Response) => {
      const body = req.body as Partial<AlertSilence>;
      if (!body?.matchers || !body?.startsAt || !body?.endsAt) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'matchers, startsAt, endsAt are required' } });
        return;
      }

      const silence = await store.createSilence({
        matchers: body.matchers,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        comment: body.comment ?? '',
        createdBy: body.createdBy ?? 'user',
      } as Omit<AlertSilence, 'id' | 'createdAt'>);

      res.status(201).json(silence);
    },
  );

  router.put(
    '/silences/:id',
    requirePermission(() => ac.eval(ACTIONS.AlertSilencesWrite)),
    async (req: Request, res: Response) => {
      const updated = await store.updateSilence(req.params['id'] ?? '', req.body as Partial<AlertSilence>);
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Silence not found' } });
        return;
      }
      res.json(updated);
    },
  );

  router.delete(
    '/silences/:id',
    requirePermission(() => ac.eval(ACTIONS.AlertSilencesWrite)),
    async (req: Request, res: Response) => {
      if (!(await store.deleteSilence(req.params['id'] ?? ''))) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Silence not found' } });
        return;
      }
      res.status(204).end();
    },
  );

  // -- Notification Policies

  router.get(
    '/notification-policies',
    requirePermission(() => ac.eval(ACTIONS.AlertNotificationsRead)),
    async (_req: Request, res: Response) => {
      res.json(await store.findAllPolicies());
    },
  );

  router.post(
    '/notification-policies',
    requirePermission(() => ac.eval(ACTIONS.AlertNotificationsWrite)),
    async (req: Request, res: Response) => {
      const body = req.body as Partial<NotificationPolicy>;
      if (!body?.name || !body?.channels) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name and channels are required' } });
        return;
      }

      const policy = await store.createPolicy({
        name: body.name,
        matchers: body.matchers ?? [],
        channels: body.channels,
        groupBy: body.groupBy ?? [],
        groupWaitSec: body.groupWaitSec ?? 30,
        groupIntervalSec: body.groupIntervalSec ?? 300,
        repeatIntervalSec: body.repeatIntervalSec ?? 3600,
      } as Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>);

      res.status(201).json(policy);
    },
  );

  router.put(
    '/notification-policies/:id',
    requirePermission(() => ac.eval(ACTIONS.AlertNotificationsWrite)),
    async (req: Request, res: Response) => {
      const updated = await store.updatePolicy(req.params['id'] ?? '', req.body as Partial<NotificationPolicy>);
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification policy not found' } });
        return;
      }
      res.json(updated);
    },
  );

  router.delete(
    '/notification-policies/:id',
    requirePermission(() => ac.eval(ACTIONS.AlertNotificationsWrite)),
    async (req: Request, res: Response) => {
      if (!(await store.deletePolicy(req.params['id'] ?? ''))) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification policy not found' } });
        return;
      }
      res.status(204).end();
    },
  );

  router.get(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesRead, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const rule = await store.findById(req.params['id'] ?? '');
      if (!rule) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      res.json(rule);
    },
  );

  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.AlertRulesCreate, 'folders:*')),
    async (req: Request, res: Response) => {
      const body = req.body as Partial<AlertRule>;
      if (!body?.name || !body.condition) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name and condition are required' } });
        return;
      }

      const workspaceId = resolveOrgId(req);
      type AlertRuleCreateInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>;
      const createInput: AlertRuleCreateInput = {
        name: body.name,
        description: body.description ?? '',
        originalPrompt: body.originalPrompt,
        condition: body.condition!,
        evaluationIntervalSec: body.evaluationIntervalSec ?? 60,
        severity: body.severity ?? 'medium',
        labels: { ...body.labels, workspaceId },
        createdBy: body.createdBy ?? 'user',
        notificationPolicyId: body.notificationPolicyId,
        workspaceId,
      };
      const rule = await store.create(createInput);

      res.status(201).json(rule);
    },
  );

  router.put(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const updated = await store.update(req.params['id'] ?? '', req.body as Partial<AlertRule>);
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      res.json(updated);
    },
  );

  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesDelete, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      if (!(await store.delete(req.params['id'] ?? ''))) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      res.status(204).end();
    },
  );

  router.post(
    '/:id/disable',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const rule = await store.update(req.params['id'] ?? '', { state: 'disabled' as const });
      if (!rule) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      res.json(rule);
    },
  );

  router.post(
    '/:id/enable',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const rule = await store.update(req.params['id'] ?? '', { state: 'normal' as const });
      if (!rule) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      res.json(rule);
    },
  );

  router.get(
    '/:id/history',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesRead, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const limit = parseInt((req.query['limit'] as string | undefined) ?? '50', 10);
      res.json(await store.getHistory(req.params['id'] ?? '', limit));
    },
  );

  router.post(
    '/:id/test',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rule = await store.findById(req.params['id'] ?? '');
        if (!rule) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
          return;
        }

        res.json({ ok: true, testResult: { message: 'Test endpoint ready - evaluator will be wired in pipeline' } });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/investigate',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rule = await store.findById(req.params['id'] ?? '');
        if (!rule) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
          return;
        }

        const body = req.body as { force?: boolean } | undefined;

        if (rule.investigationId && !body?.force) {
          res.json({ investigationId: rule.investigationId, existing: true });
          return;
        }

        if (!deps.investigationStore) {
          res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Investigation stores not configured' } });
          return;
        }

        const question = `Investigate alert "${rule.name}": ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`;
        const investigation = await deps.investigationStore.create({
          question,
          sessionId: `ses_alert_${Date.now()}`,
          userId: 'alert-system',
        });

        // Investigation orchestration now handled by the dashboard agent via chat
        await store.update(rule.id, { investigationId: investigation.id });

        res.json({ investigationId: investigation.id, existing: false });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// NOTE: `alertRulesRouter` used to be a module-scoped instance built without
// any deps. W2 / T2.4 made `setupConfig` required for the `/generate` endpoint
// (it needs the LLM config), so callers must construct via
// `createAlertRulesRouter(deps)` now. No default export.
