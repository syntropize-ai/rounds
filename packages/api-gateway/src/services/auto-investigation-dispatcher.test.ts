import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  AutoInvestigationDispatcher,
  buildAlertQuestion,
  buildSaIdentityResolverFromRepos,
} from './auto-investigation-dispatcher.js';
import type { AlertFiredPayload } from './alert-evaluator-service.js';

function basePayload(overrides: Partial<AlertFiredPayload> = {}): AlertFiredPayload {
  return {
    ruleId: 'rule-1',
    ruleName: 'high-error-rate',
    severity: 'high',
    value: 0.12,
    threshold: 0.05,
    operator: '>',
    labels: { team: 'web' },
    firedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildAlertQuestion', () => {
  it('includes rule name, severity, condition, current value, and labels', () => {
    const q = buildAlertQuestion(basePayload());
    expect(q).toMatch(/Alert "high-error-rate"/);
    expect(q).toMatch(/high/);
    expect(q).toMatch(/value > 0.05/);
    expect(q).toMatch(/current 0.12/);
    expect(q).toMatch(/team=web/);
    expect(q).toMatch(/Investigate the root cause/);
  });
  it('omits labels block when none are present', () => {
    const q = buildAlertQuestion(basePayload({ labels: {} }));
    expect(q).not.toMatch(/labels:/);
  });
});

describe('AutoInvestigationDispatcher', () => {
  let alertEvents: EventEmitter;
  let now: Date;

  beforeEach(() => {
    alertEvents = new EventEmitter();
    now = new Date('2026-04-29T00:00:00.000Z');
  });

  const fakeIdentity = {
    userId: 'sa-1',
    orgId: 'org_main',
    orgRole: 'Editor' as const,
    isServerAdmin: false,
    authenticatedBy: 'api_key' as const,
    serviceAccountId: 'sa-1',
  };

  function mkDispatcher(
    spawn: ReturnType<typeof vi.fn>,
    resolveSaIdentity: () => Promise<typeof fakeIdentity | null> = async () => fakeIdentity,
  ) {
    return new AutoInvestigationDispatcher({
      alertEvents,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({} as never),
      },
      resolveSaIdentity,
      dedupMs: 60_000,
      clock: () => now,
      spawnAgent: spawn as unknown as typeof import('@agentic-obs/agent-core').runBackgroundAgent,
    });
  }

  it('spawns one investigation per alert.fired', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    d.subscribe();
    alertEvents.emit('alert.fired', basePayload());
    // listener is fire-and-forget; await microtasks
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]?.[1] as { identity: { serviceAccountId: string }; message: string };
    expect(args.identity.serviceAccountId).toBe('sa-1');
    expect(args.message).toMatch(/high-error-rate/);
  });

  it('skips gracefully when no live SA token is available', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn, async () => null);
    await d.onAlertFired(basePayload());
    expect(spawn).not.toHaveBeenCalled();
  });

  it('picks up a token minted mid-session on the next alert', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    let mintedYet = false;
    const d = mkDispatcher(spawn, async () => (mintedYet ? fakeIdentity : null));
    await d.onAlertFired(basePayload());
    expect(spawn).not.toHaveBeenCalled();
    mintedYet = true;
    await d.onAlertFired(basePayload({ ruleId: 'rule-2' }));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('dedups same ruleId within the window', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    await d.onAlertFired(basePayload());
    await d.onAlertFired(basePayload());
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('lets a second firing through after the dedup window expires', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    await d.onAlertFired(basePayload());
    now = new Date(now.getTime() + 61_000);
    await d.onAlertFired(basePayload());
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('treats different ruleIds as independent', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    await d.onAlertFired(basePayload({ ruleId: 'a' }));
    await d.onAlertFired(basePayload({ ruleId: 'b' }));
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps running when one investigation throws', async () => {
    const spawn = vi.fn()
      .mockRejectedValueOnce(new Error('LLM down'))
      .mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    await d.onAlertFired(basePayload({ ruleId: 'a' }));
    await d.onAlertFired(basePayload({ ruleId: 'b' }));
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('subscribe is idempotent and unsubscribe stops further dispatches', async () => {
    const spawn = vi.fn().mockResolvedValue('ok');
    const d = mkDispatcher(spawn);
    d.subscribe();
    d.subscribe();
    alertEvents.emit('alert.fired', basePayload());
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1);

    d.unsubscribe();
    alertEvents.emit('alert.fired', basePayload({ ruleId: 'rule-2' }));
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(1); // still 1, unsubscribe worked
  });

  describe('finalizeInvestigation', () => {
    function mkInv(overrides: Partial<{ id: string; status: string; createdAt: string }> = {}) {
      return {
        id: overrides.id ?? 'inv-1',
        status: overrides.status ?? 'planning',
        createdAt: overrides.createdAt ?? '2026-04-29T00:00:01.000Z',
      } as unknown as import('@agentic-obs/common').Investigation;
    }

    function mkRepos(invs: ReturnType<typeof mkInv>[]) {
      const updateStatus = vi.fn().mockResolvedValue(null);
      const ruleUpdate = vi.fn().mockResolvedValue(null);
      const investigations = {
        findByWorkspace: vi.fn().mockResolvedValue(invs),
        updateStatus,
      } as unknown as import('@agentic-obs/data-layer').IInvestigationRepository;
      const alertRules = {
        update: ruleUpdate,
      } as unknown as import('@agentic-obs/data-layer').IAlertRuleRepository;
      return { investigations, alertRules, updateStatus, ruleUpdate };
    }

    function mkDispatcherWithRepos(
      spawn: ReturnType<typeof vi.fn>,
      repos: ReturnType<typeof mkRepos>,
    ) {
      return new AutoInvestigationDispatcher({
        alertEvents,
        runner: {
          saTokens: { validateAndLookup: async () => null },
          makeOrchestrator: () => ({} as never),
        },
        resolveSaIdentity: async () => fakeIdentity,
        dedupMs: 60_000,
        clock: () => now,
        spawnAgent: spawn as unknown as typeof import('@agentic-obs/agent-core').runBackgroundAgent,
        investigations: repos.investigations,
        alertRules: repos.alertRules,
      });
    }

    it('flips planning → completed when the agent did not call investigation_complete', async () => {
      const spawn = vi.fn().mockResolvedValue('summary text');
      const repos = mkRepos([mkInv({ id: 'inv-A', status: 'planning' })]);
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.updateStatus).toHaveBeenCalledWith('inv-A', 'completed');
    });

    it('flips planning → failed when the agent run threw', async () => {
      const spawn = vi.fn().mockRejectedValue(new Error('LLM 500'));
      const repos = mkRepos([mkInv({ id: 'inv-A', status: 'planning' })]);
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.updateStatus).toHaveBeenCalledWith('inv-A', 'failed');
    });

    it('leaves a terminal status alone (agent already finalized)', async () => {
      const spawn = vi.fn().mockResolvedValue('ok');
      const repos = mkRepos([mkInv({ id: 'inv-A', status: 'completed' })]);
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.updateStatus).not.toHaveBeenCalled();
    });

    it('writes the new investigation id back to the rule so manual Investigate reuses it', async () => {
      const spawn = vi.fn().mockResolvedValue('ok');
      const repos = mkRepos([mkInv({ id: 'inv-A', status: 'planning' })]);
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.ruleUpdate).toHaveBeenCalledWith('rule-A', { investigationId: 'inv-A' });
    });

    it('skips finalize when the agent never created an investigation', async () => {
      const spawn = vi.fn().mockResolvedValue('agent gave up');
      const repos = mkRepos([]); // no investigations created
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.updateStatus).not.toHaveBeenCalled();
      expect(repos.ruleUpdate).not.toHaveBeenCalled();
    });

    it('only considers investigations created at or after the dispatch start time', async () => {
      const spawn = vi.fn().mockResolvedValue('ok');
      // One stale row from before this dispatch, one created during it.
      const stale = mkInv({ id: 'inv-OLD', status: 'planning', createdAt: '2026-04-28T23:00:00.000Z' });
      const fresh = mkInv({ id: 'inv-NEW', status: 'planning', createdAt: '2026-04-29T00:00:01.000Z' });
      const repos = mkRepos([stale, fresh]);
      const d = mkDispatcherWithRepos(spawn, repos);
      await d.onAlertFired(basePayload({ ruleId: 'rule-A' }));
      expect(repos.updateStatus).toHaveBeenCalledWith('inv-NEW', 'completed');
      expect(repos.ruleUpdate).toHaveBeenCalledWith('rule-A', { investigationId: 'inv-NEW' });
    });
  });
});

describe('buildSaIdentityResolverFromRepos', () => {
  // The earlier resolver gated on a live api_key row; users had to mint a
  // token via the UI before any auto-investigation could run, with no error
  // surfacing the requirement. The resolver now runs on the SA user row
  // alone — no token needed. These tests pin that contract.

  function makeRepos(opts: {
    sa: { id: string; isServiceAccount: boolean; isDisabled?: boolean } | null;
    member: { role: 'Editor' | 'Viewer' | 'Admin' } | null;
  }) {
    return {
      users: { findByLogin: vi.fn(async () => opts.sa) },
      orgUsers: { findMembership: vi.fn(async () => opts.member) },
    } as unknown as Parameters<typeof buildSaIdentityResolverFromRepos>[0];
  }

  it('returns identity for an enabled SA without any api_key row', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({
        sa: { id: 'u_sa', isServiceAccount: true },
        member: { role: 'Editor' },
      }),
    );
    const id = await resolver(basePayload());
    expect(id).toEqual({
      userId: 'u_sa',
      orgId: 'org_main',
      orgRole: 'Editor',
      isServerAdmin: false,
      authenticatedBy: 'api_key',
      serviceAccountId: 'u_sa',
    });
  });

  it('returns null when the SA user does not exist (seed has not run)', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({ sa: null, member: null }),
    );
    expect(await resolver(basePayload())).toBeNull();
  });

  it('returns null when the SA user is disabled', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({
        sa: { id: 'u_sa', isServiceAccount: true, isDisabled: true },
        member: { role: 'Editor' },
      }),
    );
    expect(await resolver(basePayload())).toBeNull();
  });

  it('returns null when the SA has no membership in the target org', async () => {
    const resolver = buildSaIdentityResolverFromRepos(
      makeRepos({
        sa: { id: 'u_sa', isServiceAccount: true },
        member: null,
      }),
    );
    expect(await resolver(basePayload())).toBeNull();
  });
});
