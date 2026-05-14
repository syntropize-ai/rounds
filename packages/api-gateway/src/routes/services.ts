/**
 * Services router (Wave 2 / Step 2).
 *
 * Service is the primary organizing concept for Rounds — derived from the
 * `resource_service_attribution` table. Resources without a high-confidence
 * (or user-confirmed) attribution row are surfaced in the Unassigned bucket
 * so the user can bulk-assign.
 */

import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import type {
  IServiceAttributionRepository,
  IAlertRuleRepository,
  AttributionResourceKind,
} from '@agentic-obs/data-layer';
import type { IInvestigationRepository } from '@agentic-obs/data-layer';
import { ac, ACTIONS, AuditAction } from '@agentic-obs/common';
import type { IDashboardRepository } from '@agentic-obs/common';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getOrgId } from '../middleware/workspace-context.js';
import type { AuditWriter } from '../auth/audit-writer.js';

export interface ServicesRouterDeps {
  serviceAttribution: IServiceAttributionRepository;
  dashboards: IDashboardRepository;
  alertRules: IAlertRuleRepository;
  // Only uses findAll — kept narrow so RepositoryBundle.investigations (which
  // intersects with IGatewayInvestigationStore) satisfies it structurally.
  investigations: Pick<IInvestigationRepository, 'findAll'>;
  accessControl: AccessControlSurface;
  audit?: AuditWriter;
}

function resolveOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  return getOrgId(req);
}

export function createServicesRouter(deps: ServicesRouterDeps): ExpressRouter {
  const router = Router();
  const requirePermission = createRequirePermission(deps.accessControl);

  router.use(authMiddleware);

  /**
   * GET /api/services
   * → { services: [{ name, resourceCount }], unassignedCount }
   *
   * `unassignedCount` is computed across the three attributable resource
   * kinds (dashboards, alert rules, investigations) — the union of resource
   * ids belonging to this org minus those with a visible attribution row.
   */
  router.get(
    '/',
    requirePermission(() => ac.eval(ACTIONS.DashboardsRead, 'dashboards:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const services = await deps.serviceAttribution.listServices(orgId);

        const [dashIds, ruleIds, invIds] = await Promise.all([
          listDashboardIds(deps.dashboards, orgId),
          listAlertRuleIds(deps.alertRules, orgId),
          listInvestigationIds(deps.investigations, orgId),
        ]);

        const [dashUn, ruleUn, invUn] = await Promise.all([
          deps.serviceAttribution.listUnassigned(orgId, 'dashboard', dashIds),
          deps.serviceAttribution.listUnassigned(orgId, 'alert_rule', ruleIds),
          deps.serviceAttribution.listUnassigned(orgId, 'investigation', invIds),
        ]);
        const unassignedCount = dashUn.length + ruleUn.length + invUn.length;

        res.json({ services, unassignedCount });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * GET /api/services/unassigned
   * → { resources: [{ kind, id, title }] }
   *
   * Lists each resource of every kind with no visible attribution. `title`
   * is whatever the underlying resource exposes (dashboard.title,
   * alert_rule.name, investigation.intent).
   */
  router.get(
    '/unassigned',
    requirePermission(() => ac.eval(ACTIONS.DashboardsRead, 'dashboards:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const out: Array<{ kind: AttributionResourceKind; id: string; title: string }> = [];

        const dashboards = await deps.dashboards.findAll();
        const ownedDashboards = dashboards.filter((d) => d.workspaceId === orgId);
        const dashUn = await deps.serviceAttribution.listUnassigned(
          orgId,
          'dashboard',
          ownedDashboards.map((d) => d.id),
        );
        const dashByIdTitle = new Map(ownedDashboards.map((d) => [d.id, d.title]));
        for (const id of dashUn) {
          out.push({ kind: 'dashboard', id, title: dashByIdTitle.get(id) ?? id });
        }

        const rulesPage = await deps.alertRules.findAll();
        const ownedRules = rulesPage.list.filter((r) => r.workspaceId === orgId);
        const ruleUn = await deps.serviceAttribution.listUnassigned(
          orgId,
          'alert_rule',
          ownedRules.map((r) => r.id),
        );
        const ruleByIdName = new Map(ownedRules.map((r) => [r.id, r.name]));
        for (const id of ruleUn) {
          out.push({ kind: 'alert_rule', id, title: ruleByIdName.get(id) ?? id });
        }

        const invs = await deps.investigations.findAll({ tenantId: orgId });
        const invUn = await deps.serviceAttribution.listUnassigned(
          orgId,
          'investigation',
          invs.map((i) => i.id),
        );
        const invByIdIntent = new Map(invs.map((i) => [i.id, i.intent]));
        for (const id of invUn) {
          out.push({ kind: 'investigation', id, title: invByIdIntent.get(id) ?? id });
        }

        res.json({ resources: out });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * GET /api/services/:name
   * → { name, dashboards, alertRules, investigations, owner?, deploys? }
   *
   * owner/deploys are stubbed null in this PR; the UI shows them when
   * present. Filling them is a follow-up (k8s reconciler / change-event
   * cross-link).
   */
  router.get(
    '/:name',
    requirePermission(() => ac.eval(ACTIONS.DashboardsRead, 'dashboards:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const name = decodeURIComponent(req.params['name'] ?? '');
        if (!name) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'service name required' } });
          return;
        }
        const refs = await deps.serviceAttribution.listResourcesForService(orgId, name);
        const dashboardIds = refs.filter((r) => r.kind === 'dashboard').map((r) => r.id);
        const alertIds = refs.filter((r) => r.kind === 'alert_rule').map((r) => r.id);
        const invIds = refs.filter((r) => r.kind === 'investigation').map((r) => r.id);

        const [allDashboards, allRulesPage, allInvs] = await Promise.all([
          deps.dashboards.findAll(),
          deps.alertRules.findAll(),
          deps.investigations.findAll({ tenantId: orgId }),
        ]);
        const dashSet = new Set(dashboardIds);
        const ruleSet = new Set(alertIds);
        const invSet = new Set(invIds);

        res.json({
          name,
          dashboards: allDashboards
            .filter((d) => dashSet.has(d.id) && d.workspaceId === orgId)
            .map((d) => ({ id: d.id, title: d.title })),
          alertRules: allRulesPage.list
            .filter((r) => ruleSet.has(r.id) && r.workspaceId === orgId)
            .map((r) => ({ id: r.id, name: r.name, state: r.state, severity: r.severity })),
          investigations: allInvs
            .filter((i) => invSet.has(i.id))
            .map((i) => ({ id: i.id, intent: i.intent, status: i.status })),
          owner: null,
          deploys: [],
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /api/services/:name/assign
   * body: { resourceKind, resourceId }
   *
   * Writes a manual attribution row (tier 4, user_confirmed=1) and an
   * audit entry. Idempotent: a second call with the same payload updates
   * the existing row's service_name.
   */
  router.post(
    '/:name/assign',
    requirePermission(() => ac.eval(ACTIONS.DashboardsWrite, 'dashboards:*')),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const orgId = resolveOrgId(req);
        const userId = (req as AuthenticatedRequest).auth?.userId ?? 'anonymous';
        const name = decodeURIComponent(req.params['name'] ?? '');
        const body = req.body as { resourceKind?: unknown; resourceId?: unknown };
        const kind = body.resourceKind;
        const id = body.resourceId;
        if (
          !name ||
          (kind !== 'dashboard' && kind !== 'alert_rule' && kind !== 'investigation') ||
          typeof id !== 'string' ||
          !id
        ) {
          res.status(400).json({
            error: {
              code: 'INVALID_INPUT',
              message: 'name (path) and { resourceKind, resourceId } body are required',
            },
          });
          return;
        }
        const row = await deps.serviceAttribution.confirmAttribution(
          orgId,
          kind,
          id,
          name,
          userId,
        );
        void deps.audit?.log({
          action: AuditAction.ServiceAttributionConfirm,
          actorType: 'user',
          actorId: userId,
          orgId,
          targetType: kind,
          targetId: id,
          targetName: name,
          outcome: 'success',
          metadata: { sourceTier: 4, sourceKind: 'manual', confidence: 1 },
        });
        res.status(200).json(row);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

async function listDashboardIds(repo: IDashboardRepository, orgId: string): Promise<string[]> {
  const all = await repo.findAll();
  return all.filter((d) => d.workspaceId === orgId).map((d) => d.id);
}

async function listAlertRuleIds(repo: IAlertRuleRepository, orgId: string): Promise<string[]> {
  const page = await repo.findAll();
  return page.list.filter((r) => r.workspaceId === orgId).map((r) => r.id);
}

async function listInvestigationIds(
  repo: Pick<IInvestigationRepository, 'findAll'>,
  orgId: string,
): Promise<string[]> {
  const all = await repo.findAll({ tenantId: orgId });
  return all.map((i) => i.id);
}
