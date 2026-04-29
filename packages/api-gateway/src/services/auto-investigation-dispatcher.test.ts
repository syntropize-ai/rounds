import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  AutoInvestigationDispatcher,
  buildAlertQuestion,
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

  function mkDispatcher(spawn: ReturnType<typeof vi.fn>) {
    return new AutoInvestigationDispatcher({
      alertEvents,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({} as never),
      },
      saToken: 'openobs_sa_test',
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
    const args = spawn.mock.calls[0]?.[1] as { saToken: string; message: string };
    expect(args.saToken).toBe('openobs_sa_test');
    expect(args.message).toMatch(/high-error-rate/);
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
});
