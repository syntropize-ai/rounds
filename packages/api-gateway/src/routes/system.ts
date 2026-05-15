/**
 * System-level config writes (W2 / T2.5).
 *
 * Routes under `/api/system/*` are the post-bootstrap, authenticated
 * home for LLM + notification config save operations. The setup wizard
 * also hits these endpoints — the bootstrap-aware middleware lets
 * unauthenticated requests through until the instance is bootstrapped,
 * at which point auth + permission become mandatory.
 *
 * Read operations for the same data live on `/api/setup/config` (kept
 * there because the wizard UI already consumes it), and in the future
 * on a dedicated `/api/system/config`.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  ac,
  ACTIONS,
  type ContactPoint,
  type ContactPointIntegration,
  type NewInstanceLlmConfig,
  type NotificationChannelConfig,
  type NotificationPolicyNode,
  type NewNotificationChannel,
  type LlmConfigWire,
  type NotificationsWire,
} from '@agentic-obs/common';
import type { INotificationRepository } from '@agentic-obs/data-layer';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

export interface SystemRouterDeps {
  setupConfig: SetupConfigService;
  /**
   * RBAC surface. Mounted outside the async auth IIFE via the holder so we
   * accept the surface rather than the concrete service.
   */
  ac: AccessControlSurface;
  /**
   * Alerting notification store. `/api/system/notifications` is the wizard /
   * settings entrypoint, while alert dispatch reads contact points and the
   * policy tree. Supplying this store keeps those two surfaces in sync.
   */
  notificationStore?: INotificationRepository;
}

const MANAGED_SLACK_INTEGRATION_ID = 'system-slack';
const MANAGED_SLACK_CONTACT_POINT_NAME = 'Slack';

function actorFromReq(req: Request): { userId: string | null } {
  const ar = req as AuthenticatedRequest;
  return { userId: ar.auth?.userId ?? null };
}

function inClusterAvailable(): boolean {
  return Boolean(
    process.env['KUBERNETES_SERVICE_HOST'] &&
    process.env['KUBERNETES_SERVICE_PORT'],
  );
}

function findManagedSlackContactPoint(contactPoints: ContactPoint[]): ContactPoint | undefined {
  return contactPoints.find((cp) =>
    cp.integrations.some((integration) => integration.id === MANAGED_SLACK_INTEGRATION_ID),
  );
}

function contactPointIsReferenced(node: NotificationPolicyNode, contactPointId: string): boolean {
  if (node.contactPointId === contactPointId) return true;
  return node.children.some((child) => contactPointIsReferenced(child, contactPointId));
}

async function syncSlackNotificationRouting(
  notificationStore: INotificationRepository | undefined,
  webhookUrl: string | undefined,
): Promise<void> {
  if (!notificationStore) return;

  const contactPoints = await notificationStore.findAllContactPoints();
  const existing = findManagedSlackContactPoint(contactPoints);

  if (!webhookUrl) {
    if (!existing) return;
    const tree = await notificationStore.getPolicyTree();
    const updatedTree =
      tree.contactPointId === existing.id
        ? { ...tree, contactPointId: '' }
        : tree;
    if (updatedTree !== tree) {
      await notificationStore.updatePolicyTree(updatedTree);
    }
    if (!contactPointIsReferenced(updatedTree, existing.id)) {
      await notificationStore.deleteContactPoint(existing.id);
    }
    return;
  }

  const integration: ContactPointIntegration = {
    id: MANAGED_SLACK_INTEGRATION_ID,
    type: 'slack',
    name: MANAGED_SLACK_CONTACT_POINT_NAME,
    settings: { webhookUrl },
  };

  const contactPoint = existing
    ? await notificationStore.updateContactPoint(existing.id, {
        name: existing.name || MANAGED_SLACK_CONTACT_POINT_NAME,
        integrations: existing.integrations.some((item) => item.id === MANAGED_SLACK_INTEGRATION_ID)
          ? existing.integrations.map((item) =>
              item.id === MANAGED_SLACK_INTEGRATION_ID ? integration : item,
            )
          : [...existing.integrations, integration],
      })
    : await notificationStore.createContactPoint({
        name: MANAGED_SLACK_CONTACT_POINT_NAME,
        integrations: [integration],
      });

  if (!contactPoint) return;

  const tree = await notificationStore.getPolicyTree();
  const rootContactPointMissing =
    tree.contactPointId !== ''
      && !contactPoints.some((cp) => cp.id === tree.contactPointId)
      && tree.contactPointId !== contactPoint.id;
  if (
    tree.contactPointId === ''
    || tree.contactPointId === contactPoint.id
    || rootContactPointMissing
  ) {
    await notificationStore.updatePolicyTree({
      ...tree,
      contactPointId: contactPoint.id,
      isDefault: true,
    });
  }
}

export function createSystemRouter(deps: SystemRouterDeps): Router {
  const router = Router();
  const { setupConfig } = deps;
  const requirePermission = createRequirePermission(deps.ac);
  // Instance-wide config writes (LLM, notifications). Granted to Admin+ via
  // ADMIN_ONLY_PERMISSIONS in roles-def.ts.
  const requireConfigWrite = requirePermission(() =>
    ac.eval(ACTIONS.InstanceConfigWrite),
  );

  // GET /api/system/info — runtime details the UI needs to adapt its forms.
  // Currently surfaces whether the gateway is running with a Kubernetes
  // service-account mount (so the Ops connector form can offer "in-cluster"
  // mode without the user having to paste a kubeconfig).
  router.get('/info', (_req: Request, res: Response) => {
    res.json({ inClusterAvailable: inClusterAvailable() });
  });

  // PUT /api/system/llm — save LLM config.
  router.put('/llm', requireConfigWrite, async (req: Request, res: Response) => {
    const body = req.body as LlmConfigWire | { config: LlmConfigWire };
    const cfg = 'config' in (body as { config?: LlmConfigWire })
      ? (body as { config: LlmConfigWire }).config
      : (body as LlmConfigWire);
    if (!cfg?.provider || !cfg?.model) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'provider and model are required' },
      });
      return;
    }
    // Providers that authenticate without a static `apiKey`:
    //  - ollama / aws-bedrock: no key concept (Bedrock uses SigV4)
    //  - corporate-gateway: typically authed at the network edge
    //    (mTLS / sidecar) or via a rotating helper command
    // For everyone else, accept either a static key OR an apiKeyHelper.
    const keylessProviders = new Set(['ollama', 'aws-bedrock', 'corporate-gateway']);
    if (!cfg.apiKey && !cfg.apiKeyHelper && !keylessProviders.has(cfg.provider)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'apiKey or apiKeyHelper is required for this provider',
        },
      });
      return;
    }
    const input: NewInstanceLlmConfig = {
      provider: cfg.provider,
      apiKey: cfg.apiKey ?? null,
      model: cfg.model,
      baseUrl: cfg.baseUrl ?? null,
      authType: cfg.authType ?? null,
      region: cfg.region ?? null,
      apiKeyHelper: cfg.apiKeyHelper ?? null,
      apiFormat: cfg.apiFormat ?? null,
    };
    const saved = await setupConfig.setLlm(input, actorFromReq(req));
    res.json({ ok: true, llm: { ...saved, apiKey: saved.apiKey ? '••••••' + (saved.apiKey.slice(-4)) : null } });
  });

  // DELETE /api/system/llm — clear the LLM config (dev / reset).
  router.delete('/llm', requireConfigWrite, async (req: Request, res: Response) => {
    const removed = await setupConfig.clearLlm(actorFromReq(req));
    res.json({ ok: true, cleared: removed });
  });

  // PUT /api/system/notifications — replace the full set of notification
  // channels (slack/pagerduty/email). Mirrors the legacy wizard payload shape.
  router.put('/notifications', requireConfigWrite, async (req: Request, res: Response) => {
    const body = req.body as NotificationsWire | { notifications: NotificationsWire };
    const dto =
      'notifications' in (body as { notifications?: NotificationsWire })
        ? (body as { notifications: NotificationsWire }).notifications
        : (body as NotificationsWire);
    const actor = actorFromReq(req);
    const existing = await setupConfig.listNotificationChannels();
    const byType = new Map(existing.map((c) => [c.type, c]));
    const wanted: Array<{
      type: 'slack' | 'pagerduty' | 'email';
      config: NotificationChannelConfig;
    }> = [];
    if (dto.slack) {
      wanted.push({
        type: 'slack',
        config: { kind: 'slack', webhookUrl: dto.slack.webhookUrl },
      });
    }
    if (dto.pagerduty) {
      wanted.push({
        type: 'pagerduty',
        config: { kind: 'pagerduty', integrationKey: dto.pagerduty.integrationKey },
      });
    }
    if (dto.email) {
      wanted.push({
        type: 'email',
        config: {
          kind: 'email',
          host: dto.email.host,
          port: dto.email.port,
          username: dto.email.username,
          password: dto.email.password,
          from: dto.email.from,
        },
      });
    }
    const wantedTypes = new Set(wanted.map((w) => w.type));
    for (const w of wanted) {
      const prior = byType.get(w.type);
      if (prior) {
        await setupConfig.updateNotificationChannel(prior.id, { config: w.config }, actor);
      } else {
        const newRecord: NewNotificationChannel = {
          type: w.type,
          name: w.type,
          config: w.config,
        };
        await setupConfig.createNotificationChannel(newRecord, actor);
      }
    }
    for (const c of existing) {
      if (!wantedTypes.has(c.type)) {
        await setupConfig.deleteNotificationChannel(c.id, actor);
      }
    }
    await syncSlackNotificationRouting(deps.notificationStore, dto.slack?.webhookUrl);
    res.json({ ok: true });
  });

  return router;
}
