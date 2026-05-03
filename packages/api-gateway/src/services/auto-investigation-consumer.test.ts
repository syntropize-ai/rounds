import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryEventBus, type AlertFiredEventPayload } from '@agentic-obs/common/events';
import {
  AutoInvestigationConsumer,
  ALERT_FIRED_TOPIC,
  buildAlertQuestion,
  buildSaIdentityResolverFromRepos,
  type ConsumerAlertRuleStore,
  type ConsumerInvestigationStore,
} from './auto-investigation-consumer.js';
import type { Investigation, AlertRule } from '@agentic-obs/common';

function basePayload(overrides: Partial<AlertFiredEventPayload> = {}): AlertFiredEventPayload {
  return {
    ruleId: 'rule-1',
    ruleName: 'high-error-rate',
    orgId: 'org_main',
    severity: 'high',
    value: 0.12,
    threshold: 0.05,
    operator: '>',
    labels: { team: 'web' },
    firedAt: '2026-04-29T00:00:00.000Z',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

const fakeIdentity = {
  userId: 'sa-1',
  orgId: 'org_main',
  orgRole: 'Editor' as const,
  isServerAdmin: false,
  authenticatedBy: 'api_key' as const,
  serviceAccountId: 'sa-1',
};

function mkInv(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: 'inv-1',
    sessionId: 's1',
    userId: 'u1',
    intent: '',
    structuredIntent: {} as never,
    plan: { entity: '', objective: '', steps: [], stopConditions: [] },
    status: 'planning',
    hypotheses: [],
    actions: [],
    evidence: [],
    symptoms: [],
    workspaceId: 'org_main',
    createdAt: '2026-04-29T00:00:01.000Z',
    updatedAt: '2026-04-29T00:00:01.000Z',
    ...overrides,
  };
}

function mkRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    name: 'r',
    description: '',
    condition: { query: '', operator: '>', threshold: 0, forDurationSec: 0 },
    evaluationIntervalSec: 60,
    severity: 'high',
    state: 'firing',
    stateChangedAt: '2026-04-29T00:00:00.000Z',
    workspaceId: 'org_main',
    createdBy: 'u1',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    fireCount: 1,
    ...overrides,
  };
}

interface Stores {
  investigations: ConsumerInvestigationStore & {
    findById: ReturnType<typeof vi.fn>;
    findByWorkspace: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
  };
  alertRules: ConsumerAlertRuleStore & {
    findById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function mkStores(opts: {
  rule?: AlertRule | null;
  invById?: Investigation | null;
  invsByWorkspace?: Investigation[];
} = {}): Stores {
  const investigations = {
    findById: vi.fn().mockResolvedValue(opts.invById ?? null),
    findByWorkspace: vi.fn().mockResolvedValue(opts.invsByWorkspace ?? []),
    updateStatus: vi.fn().mockResolvedValue(null),
  };
  const alertRules = {
    findById: vi.fn().mockResolvedValue(opts.rule ?? null),
    update: vi.fn().mockResolvedValue(null),
  };
  return { investigations, alertRules };
}

describe('buildAlertQuestion', () => {
  it('includes rule name, severity, condition, current value, and labels', () => {
    const q = buildAlertQuestion(basePayload());
    expect(q).toMatch(/Alert "high-error-rate"/);
    expect(q).toMatch(/high/);
    expect(q).toMatch(/value > 0.05/);
    expect(q).toMatch(/current 0.12/);
    expect(q).toMatch(/team=web/);
  });
  it('omits labels block when none', () => {
    expect(buildAlertQuestion(basePayload({ labels: {} }))).not.toMatch(/labels:/);
  });
});

describe('AutoInvestigationConsumer', () => {
  let bus: InMemoryEventBus;
  let now: Date;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    now = new Date('2026-04-29T01:00:00.000Z');
  });

  function mkConsumer(
    spawn: ReturnType<typeof vi.fn>,
    stores: Stores,
    resolveSaIdentity: () => Promise<typeof fakeIdentity | null> = async () => fakeIdentity,
    cooldownMs = 60_000,
  ) {
    return new AutoInvestigationConsumer({
      bus,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({} as never),
      },
      resolveSaIdentity,
      alertRules: stores.alertRules,
      investigations: stores.investigations,
      cooldownMs,
      clock: () => now,
      spawnAgent: spawn as unknown as typeof import('@agentic-obs/agent-core').runBackgroundAgent,
    });
  }

  describe('shouldRun (persistent dedup)', () => {
    it('runs when the rule has no investigationId', async () => {
      const stores = mkStores({ rule: mkRule({ investigationId: undefined }) });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(true);
    });

    it('runs when the rule is unknown (findById returns null)', async () => {
      const stores = mkStores({ rule: null });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(true);
    });

    it('runs when the linked investigation no longer exists', async () => {
      const stores = mkStores({
        rule: mkRule({ investigationId: 'inv-old' }),
        invById: null,
      });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(true);
    });

    it('skips when the linked investigation is still running', async () => {
      const stores = mkStores({
        rule: mkRule({ investigationId: 'inv-A' }),
        invById: mkInv({ id: 'inv-A', status: 'investigating' }),
      });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(false);
    });

    it('skips when the linked investigation completed within cooldown', async () => {
      // now=01:00:00, completed at 00:59:30 => 30s ago, cooldown 60s
      const stores = mkStores({
        rule: mkRule({ investigationId: 'inv-A' }),
        invById: mkInv({
          id: 'inv-A',
          status: 'completed',
          updatedAt: '2026-04-29T00:59:30.000Z',
        }),
      });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(false);
    });

    it('runs when the linked investigation completed before the cooldown', async () => {
      // updated at 00:58:00 => 120s ago, cooldown 60s
      const stores = mkStores({
        rule: mkRule({ investigationId: 'inv-A' }),
        invById: mkInv({
          id: 'inv-A',
          status: 'completed',
          updatedAt: '2026-04-29T00:58:00.000Z',
        }),
      });
      const c = mkConsumer(vi.fn().mockResolvedValue('ok'), stores);
      expect(await c.shouldRun(basePayload())).toBe(true);
    });
  });

  it('happy path: bus event spawns agent → finalize completes → rule.investigationId updated', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const fresh = mkInv({ id: 'inv-NEW', status: 'planning', createdAt: '2026-04-29T01:00:00.500Z' });
    const stores = mkStores({
      rule: mkRule({ investigationId: undefined }),
      invsByWorkspace: [fresh],
    });
    const c = mkConsumer(spawn, stores);
    c.start();

    await bus.publish<AlertFiredEventPayload>(ALERT_FIRED_TOPIC, {
      id: 'evt-1',
      type: ALERT_FIRED_TOPIC,
      timestamp: '2026-04-29T01:00:00.000Z',
      payload: basePayload(),
    });
    await new Promise((r) => setImmediate(r));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(stores.investigations.updateStatus).toHaveBeenCalledWith('inv-NEW', 'completed');
    expect(stores.alertRules.update).toHaveBeenCalledWith('rule-1', { investigationId: 'inv-NEW' });

    c.stop();
  });

  it('skips gracefully when no SA identity is available', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const stores = mkStores({ rule: mkRule({ investigationId: undefined }) });
    const c = mkConsumer(spawn, stores, async () => null);
    await c.onAlertFired(basePayload());
    expect(spawn).not.toHaveBeenCalled();
  });

  it('logs and skips when identity resolution throws', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const stores = mkStores({ rule: mkRule({ investigationId: undefined }) });
    const c = mkConsumer(spawn, stores, async () => {
      throw new Error('boom');
    });
    await expect(c.onAlertFired(basePayload())).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still finalizes investigation as failed when the agent throws', async () => {
    const spawn = vi.fn().mockRejectedValue(new Error('LLM 500'));
    const fresh = mkInv({ id: 'inv-NEW', status: 'planning', createdAt: '2026-04-29T01:00:00.500Z' });
    const stores = mkStores({
      rule: mkRule({ investigationId: undefined }),
      invsByWorkspace: [fresh],
    });
    const c = mkConsumer(spawn, stores);
    await c.onAlertFired(basePayload());
    expect(stores.investigations.updateStatus).toHaveBeenCalledWith('inv-NEW', 'failed');
    expect(stores.alertRules.update).toHaveBeenCalledWith('rule-1', { investigationId: 'inv-NEW' });
  });

  it('start is idempotent and stop unsubscribes', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const stores = mkStores({
      rule: mkRule({ investigationId: undefined }),
      invsByWorkspace: [mkInv({ id: 'inv-NEW', createdAt: '2026-04-29T01:00:00.500Z' })],
    });
    const c = mkConsumer(spawn, stores);
    c.start();
    c.start(); // idempotent

    await bus.publish<AlertFiredEventPayload>(ALERT_FIRED_TOPIC, {
      id: 'e', type: ALERT_FIRED_TOPIC, timestamp: '2026-04-29T01:00:00.000Z', payload: basePayload(),
    });
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1);

    c.stop();
    await bus.publish<AlertFiredEventPayload>(ALERT_FIRED_TOPIC, {
      id: 'e2', type: ALERT_FIRED_TOPIC, timestamp: '2026-04-29T01:00:00.000Z', payload: basePayload({ ruleId: 'rule-2' }),
    });
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('buildSaIdentityResolverFromRepos', () => {
  function makeRepos(opts: {
    sa: { id: string; isServiceAccount: boolean; isDisabled?: boolean } | null;
    member: { role: 'Editor' | 'Viewer' | 'Admin' } | null;
  }) {
    return {
      users: { findByLogin: vi.fn(async () => opts.sa) },
      orgUsers: { findMembership: vi.fn(async () => opts.member) },
    } as unknown as Parameters<typeof buildSaIdentityResolverFromRepos>[0];
  }

  it('returns identity for an enabled SA', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({ sa: { id: 'u_sa', isServiceAccount: true }, member: { role: 'Editor' } }),
    );
    expect(await resolver()).toEqual({
      userId: 'u_sa',
      orgId: 'org_main',
      orgRole: 'Editor',
      isServerAdmin: false,
      authenticatedBy: 'api_key',
      serviceAccountId: 'u_sa',
    });
  });

  it('returns null when SA is missing', async () => {
    const resolver = buildSaIdentityResolverFromRepos(makeRepos({ sa: null, member: null }));
    expect(await resolver()).toBeNull();
  });

  it('returns null when SA is disabled', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({ sa: { id: 'u', isServiceAccount: true, isDisabled: true }, member: { role: 'Editor' } }),
    );
    expect(await resolver()).toBeNull();
  });

  it('returns null when SA has no membership', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({ sa: { id: 'u', isServiceAccount: true }, member: null }),
    );
    expect(await resolver()).toBeNull();
  });
});
