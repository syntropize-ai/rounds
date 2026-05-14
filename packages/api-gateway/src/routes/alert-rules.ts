import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AlertRule, AlertSilence, NotificationPolicy, IFolderRepository } from '@agentic-obs/common';
import {
  ACTIONS,
  ac,
  AuditAction,
  assertWritable,
  ProvisionedResourceError,
} from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import { defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { runBackgroundAgent, type BackgroundRunnerDeps } from '@agentic-obs/agent-core';
import { createLogger } from '@agentic-obs/common/logging';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { AlertRuleService } from '../services/alert-rule-service.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { getOrgId } from '../middleware/workspace-context.js';

const log = createLogger('alert-rules-route');
const DEFAULT_ALERT_RULE_FOLDER_UID = 'alerts';
const DEFAULT_ALERT_RULE_FOLDER_TITLE = 'Alerts';

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
  /** Required for preview/backtest to resolve configured metrics datasources. */
  setupConfig: SetupConfigService;
  folderRepository: IFolderRepository;
  /**
   * RBAC surface. `AccessControlSurface` is used (not the concrete service)
   * because this router is mounted outside the async auth IIFE in server.ts
   * — the holder forwards to the real service once it's built.
   */
  ac: AccessControlSurface;
  /**
   * Background agent runner. When provided, the manual `/:id/investigate`
   * route spawns an orchestrator run as the logged-in user after creating
   * the investigation row, mirroring the auto-investigation dispatcher's
   * flow. Without it the route still creates the row but no agent runs
   * (the legacy half-finished behavior).
   */
  runner?: BackgroundRunnerDeps;
  /**
   * Audit writer — records alert_rule.create/update/delete and
   * investigation.create events for manual investigate flows.
   */
  audit?: AuditWriter;
}

export function createAlertRulesRouter(deps: AlertRulesRouterDeps): Router {
  const store = deps.alertRuleStore ?? defaultAlertRuleStore;
  const router = Router();
  const alertRuleService = new AlertRuleService(store, deps.setupConfig);
  const audit = deps.audit;
  const requirePermission = createRequirePermission(deps.ac);

  async function resolveAlertRuleFolderUid(
    workspaceId: string,
    userId: string | undefined,
    requested?: string,
  ): Promise<string> {
    const folderUid = requested?.trim();
    if (folderUid) return folderUid;

    const existing = await deps.folderRepository.findByUid(workspaceId, DEFAULT_ALERT_RULE_FOLDER_UID);
    if (existing) return existing.uid;

    const created = await deps.folderRepository.create({
      uid: DEFAULT_ALERT_RULE_FOLDER_UID,
      orgId: workspaceId,
      title: DEFAULT_ALERT_RULE_FOLDER_TITLE,
      description: 'Default folder for alert rules created without an explicit folder.',
      parentUid: null,
      createdBy: userId ?? null,
      updatedBy: userId ?? null,
      source: 'api',
    });
    return created.uid;
  }

  function requestFolderUid(req: Request): string {
    const raw = (req.body as { folderUid?: unknown } | undefined)?.folderUid;
    return typeof raw === 'string' ? raw.trim() : '';
  }

  /**
   * Refuse the request when the rule is provisioned (file/git). Returns true
   * after writing the 409 response — caller should `return` immediately.
   */
  function refuseIfProvisioned(res: Response, rule: AlertRule): boolean {
    try {
      assertWritable({ kind: 'alert_rule', id: rule.id, source: rule.source ?? 'manual' });
      return false;
    } catch (err) {
      if (err instanceof ProvisionedResourceError) {
        res.status(409).json({
          error: {
            code: 'PROVISIONED_RESOURCE',
            message: err.message,
            source: err.resource.source,
          },
        });
        return true;
      }
      throw err;
    }
  }

  async function loadOwnedRule(req: Request, res: Response): Promise<AlertRule | null> {
    const rule = await store.findById(req.params['id'] ?? '');
    if (!rule || rule.workspaceId !== resolveOrgId(req)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
      return null;
    }
    return rule;
  }

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

  // -- POST /api/alert-rules/preview - backtest a candidate condition
  // IMPORTANT: must be before /:id routes
  router.post(
    '/preview',
    requirePermission(() => ac.eval(ACTIONS.AlertRulesRead, 'folders:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as {
          query?: unknown;
          threshold?: unknown;
          comparator?: unknown;
          operator?: unknown;
          lookbackHours?: unknown;
          datasourceId?: unknown;
        };
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        const operatorRaw = typeof body.comparator === 'string'
          ? body.comparator
          : typeof body.operator === 'string' ? body.operator : '';
        const threshold = typeof body.threshold === 'number' ? body.threshold : Number(body.threshold);
        const lookbackHours = typeof body.lookbackHours === 'number' ? body.lookbackHours : undefined;
        const datasourceId = typeof body.datasourceId === 'string' ? body.datasourceId : undefined;

        if (!query) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'query is required' } });
          return;
        }
        if (!Number.isFinite(threshold)) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'threshold must be a number' } });
          return;
        }
        if (!['>', '>=', '<', '<=', '==', '!='].includes(operatorRaw)) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'comparator must be one of >, >=, <, <=, ==, !=' } });
          return;
        }

        const orgId = resolveOrgId(req);
        const result = await alertRuleService.previewCondition(
          {
            query,
            operator: operatorRaw as Parameters<typeof alertRuleService.previewCondition>[0]['operator'],
            threshold,
            ...(lookbackHours !== undefined ? { lookbackHours } : {}),
            ...(datasourceId !== undefined ? { datasourceId } : {}),
          },
          orgId,
        );
        // Structured error (HTTP 200) on missing capability — caller renders an
        // explainer rather than a 500.
        res.status(200).json(result);
      } catch (err) {
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
      results.list = results.list.filter((r) => r.workspaceId === workspaceId);
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
      const rule = await loadOwnedRule(req, res);
      if (!rule) return;
      res.json(rule);
    },
  );

  router.post(
    '/',
    requirePermission((req) => {
      const folderUid = requestFolderUid(req) || DEFAULT_ALERT_RULE_FOLDER_UID;
      return ac.eval(ACTIONS.AlertRulesCreate, `folders:uid:${folderUid}`);
    }),
    async (req: Request, res: Response) => {
      const body = req.body as Partial<AlertRule>;
      if (!body?.name || !body.condition) {
        res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name and condition are required' } });
        return;
      }

      const workspaceId = resolveOrgId(req);
      const folderUid = await resolveAlertRuleFolderUid(
        workspaceId,
        (req as AuthenticatedRequest).auth?.userId,
        typeof body.folderUid === 'string' ? body.folderUid : undefined,
      );
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
        folderUid,
        // REST API created — see writable-gate.ts for the source taxonomy.
        source: 'api',
      };
      const rule = await store.create(createInput);

      void audit?.log({
        action: AuditAction.AlertRuleCreate,
        actorType: 'user',
        actorId: (req as AuthenticatedRequest).auth?.userId ?? null,
        orgId: workspaceId,
        targetType: 'alert_rule',
        targetId: rule.id,
        targetName: rule.name,
        outcome: 'success',
        metadata: { folderUid: rule.folderUid, severity: rule.severity },
      });

      res.status(201).json(rule);
    },
  );

  router.put(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const existing = await loadOwnedRule(req, res);
      if (!existing) return;
      if (refuseIfProvisioned(res, existing)) return;
      const updated = await store.update(req.params['id'] ?? '', req.body as Partial<AlertRule>);
      if (!updated) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      void audit?.log({
        action: AuditAction.AlertRuleUpdate,
        actorType: 'user',
        actorId: (req as AuthenticatedRequest).auth?.userId ?? null,
        orgId: resolveOrgId(req),
        targetType: 'alert_rule',
        targetId: updated.id,
        targetName: updated.name,
        outcome: 'success',
        metadata: {
          before: { severity: existing.severity, state: existing.state, condition: existing.condition },
          after: { severity: updated.severity, state: updated.state, condition: updated.condition },
        },
      });
      res.json(updated);
    },
  );

  router.delete(
    '/:id',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesDelete, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const existing = await loadOwnedRule(req, res);
      if (!existing) return;
      if (refuseIfProvisioned(res, existing)) return;
      if (!(await store.delete(req.params['id'] ?? ''))) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert rule not found' } });
        return;
      }
      void audit?.log({
        action: AuditAction.AlertRuleDelete,
        actorType: 'user',
        actorId: (req as AuthenticatedRequest).auth?.userId ?? null,
        orgId: resolveOrgId(req),
        targetType: 'alert_rule',
        targetId: existing.id,
        targetName: existing.name,
        outcome: 'success',
      });
      res.status(204).end();
    },
  );

  router.post(
    '/:id/disable',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response) => {
      const existing = await loadOwnedRule(req, res);
      if (!existing) return;
      if (refuseIfProvisioned(res, existing)) return;
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
      const existing = await loadOwnedRule(req, res);
      if (!existing) return;
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
      const rule = await loadOwnedRule(req, res);
      if (!rule) return;
      res.json(await store.getHistory(rule.id, limit));
    },
  );

  router.post(
    '/:id/test',
    requirePermission((req) =>
      ac.eval(ACTIONS.AlertRulesWrite, `alert.rules:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rule = await loadOwnedRule(req, res);
        if (!rule) return;

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
        const rule = await loadOwnedRule(req, res);
        if (!rule) return;

        const body = req.body as { force?: boolean } | undefined;

        if (rule.investigationId && !body?.force) {
          res.json({ investigationId: rule.investigationId, existing: true });
          return;
        }

        if (!deps.investigationStore) {
          res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Investigation stores not configured' } });
          return;
        }

        const identity = (req as AuthenticatedRequest).auth;
        if (!identity) {
          res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
          return;
        }

        const question = `Investigate alert "${rule.name}": ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`;
        // Scope the investigation to the rule's workspace so the operator
        // viewing it from the same workspace can read it back. Falling back
        // to the requester's workspace covers older rules without an
        // explicit workspaceId.
        const workspaceId = rule.workspaceId ?? resolveOrgId(req);
        const investigation = await deps.investigationStore.create({
          question,
          sessionId: `inv_alert_${Date.now()}`,
          // Run as the user who clicked Investigate so audit + tool
          // permissions match what they can do anywhere else.
          userId: identity.userId,
          workspaceId,
        });

        await store.update(rule.id, { investigationId: investigation.id });

        void audit?.log({
          action: AuditAction.InvestigationCreate,
          actorType: 'user',
          actorId: identity.userId,
          orgId: workspaceId,
          targetType: 'investigation',
          targetId: investigation.id,
          targetName: question,
          outcome: 'success',
          metadata: { alertRuleId: rule.id, manual: true },
        });

        // Spawn the orchestrator in the background under the clicker's
        // identity. We respond immediately so the UI can subscribe to the
        // investigation SSE stream; the agent advances status as it runs.
        // Errors are isolated — they're logged but don't fail the HTTP
        // response (Task C handles forced terminal-status fallback).
        if (deps.runner) {
          const runner = deps.runner;
          void (async () => {
            try {
              await runBackgroundAgent(runner, { identity, message: question });
            } catch (err) {
              log.error(
                { err: err instanceof Error ? err.message : String(err), ruleId: rule.id, investigationId: investigation.id },
                'manual investigate: background agent failed',
              );
            }
          })();
        } else {
          log.warn(
            { ruleId: rule.id, investigationId: investigation.id },
            'manual investigate: no background runner wired — investigation row created but no agent will run',
          );
        }

        res.json({ investigationId: investigation.id, existing: false });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// NOTE: `alertRulesRouter` used to be a module-scoped instance built without
// any deps. It now requires setupConfig for alert preview/backtest datasource
// resolution, so callers must construct via `createAlertRulesRouter(deps)`.
