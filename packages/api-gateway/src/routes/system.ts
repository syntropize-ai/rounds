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
  type NewInstanceLlmConfig,
  type NotificationChannelConfig,
  type NewNotificationChannel,
  type LlmConfigWire,
  type NotificationsWire,
} from '@agentic-obs/common';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { inClusterAvailable } from '../services/ops-connector-service.js';

export interface SystemRouterDeps {
  setupConfig: SetupConfigService;
  /**
   * RBAC surface. Mounted outside the async auth IIFE via the holder so we
   * accept the surface rather than the concrete service.
   */
  ac: AccessControlSurface;
}

function actorFromReq(req: Request): { userId: string | null } {
  const ar = req as AuthenticatedRequest;
  return { userId: ar.auth?.userId ?? null };
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
    if (!cfg.apiKey && cfg.provider !== 'ollama' && cfg.provider !== 'aws-bedrock') {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'apiKey is required for this provider' },
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
    res.json({ ok: true });
  });

  return router;
}
