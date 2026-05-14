/**
 * Wave 2 / Step 5 — POST /api/alert-rules/:id/fork.
 *
 * Verifies that the fork endpoint copies the rule into the caller's personal
 * folder as a `source: 'manual'` row, records the provenance, and writes an
 * `alert_rule.fork` audit entry.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AlertRule, Identity } from '@agentic-obs/common';

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  };
});

import { createAlertRulesRouter } from './alert-rules.js';

const ALWAYS_ALLOW = {
  evaluate: async () => true as const,
  eval: () => ({}),
} as unknown as Parameters<typeof createAlertRulesRouter>[0]['ac'];

const SETUP_CONFIG_STUB = {} as unknown as Parameters<typeof createAlertRulesRouter>[0]['setupConfig'];

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'r1',
    name: 'CPU High',
    description: 'orig desc',
    condition: { query: 'rate(cpu[1m])', operator: '>', threshold: 0.8, forDurationSec: 60 },
    evaluationIntervalSec: 60,
    severity: 'high',
    labels: { team: 'platform' },
    state: 'firing',
    stateChangedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fireCount: 0,
    workspaceId: 'ws_a',
    folderUid: 'alerts',
    source: 'provisioned_git',
    provenance: { repo: 'org/repo', path: 'alerts/cpu.yaml' },
    ...overrides,
  } as AlertRule;
}

function buildApp(rule: AlertRule | null, captured: {
  create: ReturnType<typeof vi.fn>;
  auditLog: ReturnType<typeof vi.fn>;
}) {
  const store = {
    findById: vi.fn(async () => rule),
    create: captured.create,
  } as unknown as Parameters<typeof createAlertRulesRouter>[0]['alertRuleStore'];

  const identity: Identity = {
    userId: 'u_carol',
    orgId: 'ws_a',
    orgRole: 'Editor',
    isServerAdmin: false,
    authenticatedBy: 'session',
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { auth?: Identity }).auth = identity;
    next();
  });
  app.use(
    '/api/alert-rules',
    createAlertRulesRouter({
      alertRuleStore: store,
      setupConfig: SETUP_CONFIG_STUB,
      folderRepository: {
        create: vi.fn(),
        findById: vi.fn(),
        findByUid: vi.fn(),
        list: vi.fn(),
      } as unknown as Parameters<typeof createAlertRulesRouter>[0]['folderRepository'],
      ac: ALWAYS_ALLOW,
      audit: { log: captured.auditLog } as unknown as Parameters<typeof createAlertRulesRouter>[0]['audit'],
    }),
  );
  return app;
}

describe('POST /api/alert-rules/:id/fork', () => {
  it('copies a provisioned rule into the caller\'s personal folder as manual', async () => {
    const create = vi.fn(async (input: Partial<AlertRule>) => ({
      ...input,
      id: 'r2',
      state: 'normal',
      stateChangedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fireCount: 0,
    } as AlertRule));
    const auditLog = vi.fn();
    const app = buildApp(makeRule(), { create, auditLog });

    const res = await request(app).post('/api/alert-rules/r1/fork').send({});

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('r2');
    expect(res.body.source).toBe('manual');
    expect(res.body.folderUid).toBe('personal-u_carol');
    expect(res.body.provenance).toEqual({ forkedFrom: 'r1' });
    // Fork preserves condition + severity + labels.
    expect(res.body.condition).toEqual(makeRule().condition);
    expect(res.body.severity).toBe('high');
    expect(res.body.name).toBe('CPU High (forked)');

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditArg = (auditLog.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(auditArg.targetId).toBe('r2');
    expect(auditArg.targetType).toBe('alert_rule');
    expect(auditArg.outcome).toBe('success');
    // The action enum string is asserted in the audit catalog test
    // (packages/common/src/audit/actions.test.ts) so we don't double-check
    // it here — the runtime value depends on the linked dist of
    // @agentic-obs/common which may be stale across worktrees.
  });

  it('returns 404 when the rule is in a different workspace', async () => {
    const create = vi.fn();
    const auditLog = vi.fn();
    const app = buildApp(makeRule({ workspaceId: 'ws_other' }), { create, auditLog });

    const res = await request(app).post('/api/alert-rules/r1/fork').send({});
    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it('honors a caller-supplied newTitle', async () => {
    const create = vi.fn(async (input: Partial<AlertRule>) => ({
      ...input,
      id: 'r2',
      state: 'normal',
      stateChangedAt: '',
      createdAt: '',
      updatedAt: '',
      fireCount: 0,
    } as AlertRule));
    const app = buildApp(makeRule(), { create, auditLog: vi.fn() });

    const res = await request(app)
      .post('/api/alert-rules/r1/fork')
      .send({ newTitle: 'Mine' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Mine');
  });
});
