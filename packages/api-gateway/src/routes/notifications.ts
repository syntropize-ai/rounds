import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  ContactPoint,
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
  AlertGroup,
} from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { INotificationRepository, IAlertRuleRepository } from '@agentic-obs/data-layer';
import { defaultNotificationStore, defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { postWebhook, buildTestWebhookBody } from '../services/notification-senders/index.js';

export interface NotificationsRouterDeps {
  notificationStore?: INotificationRepository;
  alertRuleStore?: IAlertRuleRepository;
  /**
   * RBAC surface. Contact points / policies / mute timings / alert groups all
   * gate on `alert.notifications:read` (Viewer) and `alert.notifications:write`
   * (Editor+) — matching Grafana's stock alerting role grants. The holder
   * forwards to the real service once the auth subsystem finishes wiring.
   */
  ac: AccessControlSurface;
}

export function createNotificationsRouter(deps: NotificationsRouterDeps): Router {
  const notifStore = deps.notificationStore ?? defaultNotificationStore;
  const alertStore = deps.alertRuleStore ?? defaultAlertRuleStore;
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const requireDashboardRead = requirePermission(() => ac.eval(ACTIONS.AlertNotificationsRead));
  const requireDashboardWrite = requirePermission(() => ac.eval(ACTIONS.AlertNotificationsWrite));

  router.use((req: Request, res: Response, next: NextFunction) => {
    authMiddleware(req as AuthenticatedRequest, res, next);
  });

  // -- Contact Points

  // GET /api/notifications/contact-points
  router.get('/contact-points', requireDashboardRead, async (_req: Request, res: Response) => {
    res.json(await notifStore.findAllContactPoints());
  });

  // GET /api/notifications/contact-points/:id
  router.get('/contact-points/:id', requireDashboardRead, async (req: Request, res: Response) => {
    const cp = await notifStore.findContactPointById(req.params['id'] ?? '');
    if (!cp) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact point not found' } });
      return;
    }
    res.json(cp);
  });

  // POST /api/notifications/contact-points
  router.post('/contact-points', requireDashboardWrite, async (req: Request, res: Response) => {
    const body = req.body as Partial<ContactPoint>;
    if (!body?.name) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } });
      return;
    }

    const cp = await notifStore.createContactPoint({
      name: body.name,
      integrations: body.integrations ?? [],
    });
    res.status(201).json(cp);
  });

  // PUT /api/notifications/contact-points/:id
  router.put('/contact-points/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const updated = await notifStore.updateContactPoint(
      req.params['id'] ?? '',
      req.body as Partial<Omit<ContactPoint, 'id' | 'createdAt'>>,
    );
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact point not found' } });
      return;
    }
    res.json(updated);
  });

  // DELETE /api/notifications/contact-points/:id
  router.delete('/contact-points/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const deleted = await notifStore.deleteContactPoint(req.params['id'] ?? '');
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact point not found' } });
      return;
    }
    res.status(204).end();
  });

  // POST /api/notifications/contact-points/:id/test
  router.post('/contact-points/:id/test', requireDashboardWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cp = await notifStore.findContactPointById(req.params['id'] ?? '');
      if (!cp) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact point not found' } });
        return;
      }

      const results: Array<{ integrationUid: string; type: string; success: boolean; message: string }> = [];

      for (const integration of cp.integrations) {
        if (
          integration.type === 'slack'
          || integration.type === 'webhook'
          || integration.type === 'discord'
          || integration.type === 'teams'
        ) {
          const result = await postWebhook(integration, buildTestWebhookBody(cp.name));
          results.push({
            integrationUid: integration.id,
            type: integration.type,
            success: result.ok,
            message: result.ok ? 'Test notification sent successfully' : result.message,
          });
        } else if (integration.type === 'email' || integration.type === 'pagerduty' || integration.type === 'opsgenie' || integration.type === 'telegram') {
          results.push({
            integrationUid: integration.id,
            type: integration.type,
            success: true,
            message: `Mock test for ${integration.type} - configure credentials for live testing`,
          });
        } else {
          results.push({
            integrationUid: integration.id,
            type: integration.type,
            success: false,
            message: 'No webhook URL configured',
          });
        }
      }

      res.json({ contactPointId: cp.id, results });
    } catch (err) {
      next(err);
    }
  });

  // -- Policy Tree

  // GET /api/notifications/policies
  router.get('/policies', requireDashboardRead, async (_req: Request, res: Response) => {
    res.json(await notifStore.getPolicyTree());
  });

  // PUT /api/notifications/policies - replace entire tree
  router.put('/policies', requireDashboardWrite, async (req: Request, res: Response) => {
    const body = req.body as NotificationPolicyNode;
    if (!body || !body.id) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Valid policy tree with id is required' } });
      return;
    }

    await notifStore.updatePolicyTree(body);
    res.json(await notifStore.getPolicyTree());
  });

  // POST /api/notifications/policies/:parentId/children
  router.post('/policies/:parentId/children', requireDashboardWrite, async (req: Request, res: Response) => {
    const body = req.body as Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>>;
    if (!body?.contactPointId) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'contactPointId is required' } });
      return;
    }

    const newNode = await notifStore.addChildPolicy(req.params['parentId'] ?? '', {
      matchers: body.matchers ?? [],
      contactPointId: body.contactPointId,
      groupBy: body.groupBy ?? ['alertname'],
      groupWaitSec: body.groupWaitSec ?? 30,
      groupIntervalSec: body.groupIntervalSec ?? 300,
      repeatIntervalSec: body.repeatIntervalSec ?? 3600,
      continueMatching: body.continueMatching ?? false,
      muteTimingIds: body.muteTimingIds ?? [],
      isDefault: false,
    } as Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>);

    if (!newNode) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Parent policy not found' } });
      return;
    }

    res.status(201).json(newNode);
  });

  // PUT /api/notifications/policies/:id
  router.put('/policies/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const updated = await notifStore.updatePolicy(
      req.params['id'] ?? '',
      req.body as Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt'>>,
    );
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Policy node not found' } });
      return;
    }
    res.json(updated);
  });

  // DELETE /api/notifications/policies/:id
  router.delete('/policies/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const id = req.params['id'] ?? '';
    if (id === 'root') {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Cannot delete root policy' } });
      return;
    }
    const deleted = await notifStore.deletePolicy(id);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Policy node not found' } });
      return;
    }
    res.status(204).end();
  });

  // -- Mute Timings

  // GET /api/notifications/mute-timings
  router.get('/mute-timings', requireDashboardRead, async (_req: Request, res: Response) => {
    res.json(await notifStore.findAllMuteTimings());
  });

  // POST /api/notifications/mute-timings
  router.post('/mute-timings', requireDashboardWrite, async (req: Request, res: Response) => {
    const body = req.body as Partial<MuteTiming>;
    if (!body?.name) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'name is required' } });
      return;
    }

    const mt = await notifStore.createMuteTiming({
      name: body.name,
      timeIntervals: (body.timeIntervals ?? []) as TimeInterval[],
    });

    res.status(201).json(mt);
  });

  // PUT /api/notifications/mute-timings/:id
  router.put('/mute-timings/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const updated = await notifStore.updateMuteTiming(
      req.params['id'] ?? '',
      req.body as Partial<Omit<MuteTiming, 'id' | 'createdAt'>>,
    );
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mute timing not found' } });
      return;
    }
    res.json(updated);
  });

  // DELETE /api/notifications/mute-timings/:id
  router.delete('/mute-timings/:id', requireDashboardWrite, async (req: Request, res: Response) => {
    const deleted = await notifStore.deleteMuteTiming(req.params['id'] ?? '');
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mute timing not found' } });
      return;
    }

    res.status(204).end();
  });

  // -- Alert Groups

  // GET /api/notifications/alert-groups
  router.get('/alert-groups', requireDashboardRead, async (_req: Request, res: Response) => {
    const rules = await alertStore.findAll({ state: undefined });
    const activeRules = rules.list.filter((r) => r.state === 'firing' || r.state === 'pending');

    const policyTree = await notifStore.getPolicyTree();
    const groupBy = (policyTree.groupBy?.length ?? 0) > 0 ? policyTree.groupBy! : ['alertname'];

    // Group alerts by the root group's label values
    const groupMap = new Map<string, AlertGroup>();

    for (const rule of activeRules) {
      const groupLabels: Record<string, string> = {};
      for (const label of groupBy) {
        groupLabels[label] = rule.labels?.[label] ?? (label === 'alertname' ? rule.name : '');
      }

      const key = groupBy.map((l) => `${l}=${groupLabels[l]}`).join(',');

      if (!groupMap.has(key)) {
        groupMap.set(key, { labels: groupLabels, alerts: [] });
      }

      groupMap.get(key)!.alerts.push({
        ruleId: rule.id,
        ruleName: rule.name,
        state: rule.state,
        severity: rule.severity,
        labels: rule.labels ?? {},
        startsAt: rule.lastFiredAt ?? rule.stateChangedAt,
      });
    }

    res.json([...groupMap.values()]);
  });

  return router;
}
