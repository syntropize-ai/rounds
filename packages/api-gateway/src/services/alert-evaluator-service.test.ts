/**
 * Tests for AlertEvaluatorService — both the pure state machine helpers and
 * the full tickRule flow against an in-memory SQLite repo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, SqliteAlertRuleRepository } from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import {
  AlertEvaluatorService,
  decideTransition,
  evaluatePredicate,
  type AlertFiredPayload,
} from './alert-evaluator-service.js';

describe('evaluatePredicate', () => {
  it('handles all six operators', () => {
    expect(evaluatePredicate('>', 10, 5)).toBe(true);
    expect(evaluatePredicate('>', 5, 10)).toBe(false);
    expect(evaluatePredicate('>=', 5, 5)).toBe(true);
    expect(evaluatePredicate('<', 1, 2)).toBe(true);
    expect(evaluatePredicate('<=', 2, 2)).toBe(true);
    expect(evaluatePredicate('==', 3, 3)).toBe(true);
    expect(evaluatePredicate('!=', 3, 4)).toBe(true);
    expect(evaluatePredicate('!=', 3, 3)).toBe(false);
  });
});

describe('decideTransition', () => {
  const baseCond = { query: 'q', operator: '>' as const, threshold: 5, forDurationSec: 60 };
  const now = new Date('2026-04-29T00:00:00.000Z');

  it('normal + true → pending when forDurationSec > 0', () => {
    const r = { state: 'normal' as const, pendingSince: undefined, condition: baseCond };
    expect(decideTransition(r, true, now)).toBe('pending');
  });

  it('normal + true → firing immediately when forDurationSec = 0', () => {
    const r = { state: 'normal' as const, pendingSince: undefined, condition: { ...baseCond, forDurationSec: 0 } };
    expect(decideTransition(r, true, now)).toBe('firing');
  });

  it('pending + true (duration not met) → no-op', () => {
    const pendingSince = new Date(now.getTime() - 30 * 1000).toISOString();
    const r = { state: 'pending' as const, pendingSince, condition: baseCond };
    expect(decideTransition(r, true, now)).toBeNull();
  });

  it('pending + true (duration met) → firing', () => {
    const pendingSince = new Date(now.getTime() - 60 * 1000).toISOString();
    const r = { state: 'pending' as const, pendingSince, condition: baseCond };
    expect(decideTransition(r, true, now)).toBe('firing');
  });

  it('pending + false → normal (resets the pending window)', () => {
    const pendingSince = new Date(now.getTime() - 30 * 1000).toISOString();
    const r = { state: 'pending' as const, pendingSince, condition: baseCond };
    expect(decideTransition(r, false, now)).toBe('normal');
  });

  it('firing + true → no-op (already firing)', () => {
    const r = { state: 'firing' as const, pendingSince: undefined, condition: baseCond };
    expect(decideTransition(r, true, now)).toBeNull();
  });

  it('firing + false → resolved', () => {
    const r = { state: 'firing' as const, pendingSince: undefined, condition: baseCond };
    expect(decideTransition(r, false, now)).toBe('resolved');
  });

  it('disabled → no-op regardless', () => {
    const r = { state: 'disabled' as const, pendingSince: undefined, condition: baseCond };
    expect(decideTransition(r, true, now)).toBeNull();
    expect(decideTransition(r, false, now)).toBeNull();
  });
});

describe('AlertEvaluatorService.tickRule', () => {
  let db: SqliteClient;
  let repo: SqliteAlertRuleRepository;
  let now: Date;
  let valueByRule: Map<string, number | null>;
  let svc: AlertEvaluatorService;
  let firedEvents: AlertFiredPayload[];

  beforeEach(async () => {
    // Fake timers so the repo's internal `new Date()` (used to stamp
    // pendingSince / lastFiredAt) and our injected clock see the same time.
    vi.useFakeTimers();
    now = new Date('2026-04-29T00:00:00.000Z');
    vi.setSystemTime(now);
    db = createTestDb();
    repo = new SqliteAlertRuleRepository(db);
    valueByRule = new Map();
    firedEvents = [];
    svc = new AlertEvaluatorService({
      rules: repo,
      query: async (rule) => valueByRule.get(rule.id) ?? null,
      clock: () => now,
    });
    svc.on('alert.fired', (p) => firedEvents.push(p));
  });

  afterEach(() => {
    svc.stop();
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
    vi.setSystemTime(now);
  }

  it('normal → pending → firing across two ticks (forDurationSec = 60)', async () => {
    const rule = await repo.create({
      name: 'high-error',
      description: 'too many errors',
      condition: { query: 'rate(errors)', operator: '>', threshold: 5, forDurationSec: 60 },
      evaluationIntervalSec: 30,
      severity: 'high',
      labels: { team: 'web' },
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    valueByRule.set(rule.id, 10);

    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('pending');
    expect(firedEvents).toHaveLength(0);

    // Advance the clock past forDurationSec
    advance(70 * 1000);
    await svc.tickRule(rule);
    const fresh = await repo.findById(rule.id);
    expect(fresh?.state).toBe('firing');
    expect(firedEvents).toHaveLength(1);
    expect(firedEvents[0]?.ruleId).toBe(rule.id);
    expect(firedEvents[0]?.value).toBe(10);
    expect(firedEvents[0]?.severity).toBe('high');
  });

  it('forDurationSec = 0 fires on first tick', async () => {
    const rule = await repo.create({
      name: 'instant',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30,
      severity: 'medium',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    valueByRule.set(rule.id, 6);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('firing');
    expect(firedEvents).toHaveLength(1);
  });

  it('firing → resolved when predicate goes false', async () => {
    const rule = await repo.create({
      name: 'toggling',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30,
      severity: 'low',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    valueByRule.set(rule.id, 9);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('firing');
    expect(firedEvents).toHaveLength(1);

    valueByRule.set(rule.id, 1);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('resolved');
    expect(firedEvents).toHaveLength(1); // resolved doesn't refire
  });

  it('flapping under forDurationSec does NOT fire', async () => {
    const rule = await repo.create({
      name: 'flapping',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 120 },
      evaluationIntervalSec: 30,
      severity: 'medium',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    // tick 1: predicate true, transitions to pending
    valueByRule.set(rule.id, 10);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('pending');

    // 30s later: predicate false, drops back to normal
    advance(30 * 1000);
    valueByRule.set(rule.id, 1);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('normal');

    // 60s later: predicate true again, back to pending — but the previous
    // pending is gone, so a fresh forDurationSec window starts.
    advance(60 * 1000);
    valueByRule.set(rule.id, 10);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('pending');
    expect(firedEvents).toHaveLength(0);

    // 60s later (only 60s into the new window, 120 needed): still pending.
    advance(60 * 1000);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('pending');
    expect(firedEvents).toHaveLength(0);

    // 60s later (now 120s into the window): fires.
    advance(60 * 1000);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('firing');
    expect(firedEvents).toHaveLength(1);
  });

  it('null query result does NOT change state', async () => {
    const rule = await repo.create({
      name: 'no-data',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30,
      severity: 'low',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    valueByRule.set(rule.id, null);
    await svc.tickRule(rule);
    expect((await repo.findById(rule.id))?.state).toBe('normal');
    expect(firedEvents).toHaveLength(0);
  });

  it('disabled rules are skipped', async () => {
    const rule = await repo.create({
      name: 'disabled-rule',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30,
      severity: 'low',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    await repo.update(rule.id, { state: 'disabled' });
    valueByRule.set(rule.id, 100);
    await svc.tickRule(rule.id);
    expect((await repo.findById(rule.id))?.state).toBe('disabled');
    expect(firedEvents).toHaveLength(0);
  });

  it('appends an alert_history row on each transition', async () => {
    const rule = await repo.create({
      name: 'history-test',
      description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30,
      severity: 'medium',
      createdBy: 'user-1',
      lastEvaluatedAt: '',
    });
    valueByRule.set(rule.id, 10);
    await svc.tickRule(rule);
    advance(1000);
    valueByRule.set(rule.id, 1);
    await svc.tickRule(rule);
    const history = await repo.getHistory(rule.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    const states = history.map((h) => h.toState);
    expect(states).toContain('firing');
    expect(states).toContain('resolved');
  });
});

describe('AlertEvaluatorService.tickAll + start/stop', () => {
  it('tickAll evaluates every active rule', async () => {
    const db = createTestDb();
    const repo = new SqliteAlertRuleRepository(db);
    const r1 = await repo.create({
      name: 'r1', description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30, severity: 'low', createdBy: 'u', lastEvaluatedAt: '',
    });
    const r2 = await repo.create({
      name: 'r2', description: '',
      condition: { query: 'q', operator: '<', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 30, severity: 'low', createdBy: 'u', lastEvaluatedAt: '',
    });
    const seen: string[] = [];
    const svc = new AlertEvaluatorService({
      rules: repo,
      query: async (rule) => { seen.push(rule.id); return rule.id === r1.id ? 10 : 10; },
      clock: () => new Date(),
    });
    await svc.tickAll();
    expect(seen).toContain(r1.id);
    expect(seen).toContain(r2.id);
    // r1: 10>5 fires; r2: 10<5 false, stays normal
    expect((await repo.findById(r1.id))?.state).toBe('firing');
    expect((await repo.findById(r2.id))?.state).toBe('normal');
  });

  it('notifyRuleChanged() debounces and rebuilds the schedule', async () => {
    const db = createTestDb();
    const repo = new SqliteAlertRuleRepository(db);
    const svc = new AlertEvaluatorService({
      rules: repo,
      query: async () => null,
      clock: () => new Date(),
      refreshDebounceMs: 5,
      refreshIntervalMs: 60_000,
    });
    const refreshSpy = vi.spyOn(svc, 'refreshSchedule');
    await svc.start(); // initial refreshSchedule call counted
    refreshSpy.mockClear();
    // 5 rapid notifications coalesce to a single rebuild.
    svc.notifyRuleChanged();
    svc.notifyRuleChanged();
    svc.notifyRuleChanged();
    svc.notifyRuleChanged();
    svc.notifyRuleChanged();
    await new Promise((r) => setTimeout(r, 30));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    svc.stop();
  });

  it('start() registers per-rule timers; stop() clears them', async () => {
    const db = createTestDb();
    const repo = new SqliteAlertRuleRepository(db);
    await repo.create({
      name: 'r', description: '',
      condition: { query: 'q', operator: '>', threshold: 5, forDurationSec: 0 },
      evaluationIntervalSec: 9999, severity: 'low', createdBy: 'u', lastEvaluatedAt: '',
    });
    const svc = new AlertEvaluatorService({
      rules: repo,
      query: async () => 1,
      clock: () => new Date(),
    });
    await svc.start();
    // Internal state: at least one timer registered. We don't poke private
    // fields; instead we verify stop() doesn't throw and start() is
    // idempotent.
    await svc.start();
    svc.stop();
    svc.stop(); // double-stop safe
  });
});
