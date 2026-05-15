import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  InstanceConfigRepository,
  NotificationChannelRepository,
  SqliteConnectorRepository,
  SqliteNotificationRepository,
  createTestDb,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { createSystemRouter } from './system.js';
import { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';

const allowAc: AccessControlSurface = {
  getUserPermissions: async () => [],
  evaluate: async () => true,
  ensurePermissions: async () => [],
  filterByPermission: async (_id, items) => [...items],
};

const noopAudit = {
  log: async () => undefined,
} as unknown as AuditWriter;

interface Ctx {
  app: Application;
  db: SqliteClient;
  notifications: SqliteNotificationRepository;
}

function buildApp(): Ctx {
  const db = createTestDb();
  const setupConfig = new SetupConfigService({
    instanceConfig: new InstanceConfigRepository(db),
    connectors: new SqliteConnectorRepository(db),
    notificationChannels: new NotificationChannelRepository(db),
    audit: noopAudit,
  });
  const notifications = new SqliteNotificationRepository(db);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals['allowBootstrapUnauthenticated'] = true;
    next();
  });
  app.use(
    '/api/system',
    createSystemRouter({
      setupConfig,
      ac: allowAc,
      notificationStore: notifications,
    }),
  );
  return { app, db, notifications };
}

describe('PUT /api/system/notifications', () => {
  const prevSecret = process.env['SECRET_KEY'];

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-system-notifications-xxxxxxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  let ctx: Ctx;

  beforeEach(() => {
    ctx = buildApp();
  });

  it('syncs the setup Slack webhook into the default alert contact point', async () => {
    const res = await request(ctx.app)
      .put('/api/system/notifications')
      .send({
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/ONE' },
      });

    expect(res.status).toBe(200);
    const contactPoints = await ctx.notifications.findAllContactPoints();
    expect(contactPoints).toHaveLength(1);
    expect(contactPoints[0]!.name).toBe('Slack');
    expect(contactPoints[0]!.integrations).toEqual([
      {
        id: 'system-slack',
        type: 'slack',
        name: 'Slack',
        settings: { webhookUrl: 'https://hooks.slack.com/services/T/B/ONE' },
      },
    ]);
    const policyTree = await ctx.notifications.getPolicyTree();
    expect(policyTree.contactPointId).toBe(contactPoints[0]!.id);
  });

  it('updates the managed Slack contact point without replacing custom routing', async () => {
    const custom = await ctx.notifications.createContactPoint({
      name: 'Custom on-call',
      integrations: [],
    });
    await ctx.notifications.updatePolicyTree({
      ...(await ctx.notifications.getPolicyTree()),
      contactPointId: custom.id,
    });

    await request(ctx.app)
      .put('/api/system/notifications')
      .send({
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/ONE' },
      })
      .expect(200);
    await request(ctx.app)
      .put('/api/system/notifications')
      .send({
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/TWO' },
      })
      .expect(200);

    const contactPoints = await ctx.notifications.findAllContactPoints();
    const managed = contactPoints.find((cp) =>
      cp.integrations.some((integration) => integration.id === 'system-slack'),
    );
    expect(managed?.integrations[0]?.settings).toEqual({
      webhookUrl: 'https://hooks.slack.com/services/T/B/TWO',
    });
    expect((await ctx.notifications.getPolicyTree()).contactPointId).toBe(
      custom.id,
    );
  });

  it('removes the managed Slack routing when Slack is cleared', async () => {
    await request(ctx.app)
      .put('/api/system/notifications')
      .send({
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/ONE' },
      })
      .expect(200);

    await request(ctx.app)
      .put('/api/system/notifications')
      .send({})
      .expect(200);

    expect(await ctx.notifications.findAllContactPoints()).toEqual([]);
    expect((await ctx.notifications.getPolicyTree()).contactPointId).toBe('');
  });
});
