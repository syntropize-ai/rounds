import { describe, it, expect, beforeEach } from 'vitest';
import { AlertRuleStore } from '../alert-rule-store.js';
import { AlertRuleStoreProvider } from '../alert-rule-provider-adapter.js';

const makeRuleData = (overrides: Record<string, unknown> = {}) => ({
  name: 'High CPU',
  description: 'CPU usage above 90%',
  condition: {
    query: 'avg(rate(cpu_usage[5m]))',
    operator: '>' as const,
    threshold: 90,
    forDurationSec: 60,
  },
  evaluationIntervalSec: 60,
  severity: 'high' as const,
  createdBy: 'user-1',
  ...overrides,
});

describe('AlertRuleStore', () => {
  let store: AlertRuleStore;

  beforeEach(() => {
    store = new AlertRuleStore();
  });

  it('create() and findById()', () => {
    const rule = store.create(makeRuleData());
    expect(rule.id).toBeDefined();
    expect(rule.id).toMatch(/^alert_/);
    expect(rule.name).toBe('High CPU');
    expect(rule.state).toBe('normal');
    expect(rule.fireCount).toBe(0);

    const found = store.findById(rule.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(rule.id);
  });

  it('findAll() with state filter', () => {
    const rule1 = store.create(makeRuleData({ name: 'Rule 1' }));
    store.create(makeRuleData({ name: 'Rule 2' }));

    // Both start as 'normal'
    const normalRules = store.findAll({ state: 'normal' });
    expect(normalRules.list).toHaveLength(2);
    expect(normalRules.total).toBe(2);

    // Transition one to firing
    store.transition(rule1.id, 'firing', 95);

    const firingRules = store.findAll({ state: 'firing' });
    expect(firingRules.list).toHaveLength(1);
    expect(firingRules.list[0]!.name).toBe('Rule 1');

    const stillNormal = store.findAll({ state: 'normal' });
    expect(stillNormal.list).toHaveLength(1);
  });

  it('transition() changes state', () => {
    const rule = store.create(makeRuleData());
    expect(rule.state).toBe('normal');

    const pending = store.transition(rule.id, 'pending', 91);
    expect(pending).toBeDefined();
    expect(pending!.state).toBe('pending');
    expect(pending!.pendingSince).toBeDefined();

    const firing = store.transition(rule.id, 'firing', 95);
    expect(firing).toBeDefined();
    expect(firing!.state).toBe('firing');
    expect(firing!.fireCount).toBe(1);
    expect(firing!.lastFiredAt).toBeDefined();
    expect(firing!.pendingSince).toBeUndefined();
  });

  it('transition() to same state is a no-op', () => {
    const rule = store.create(makeRuleData());
    const same = store.transition(rule.id, 'normal');
    expect(same).toBeDefined();
    expect(same!.state).toBe('normal');
  });

  it('markEvaluated() updates timestamp via provider adapter', () => {
    const rule = store.create(makeRuleData());
    expect(rule.lastEvaluatedAt).toBeUndefined();

    const provider = new AlertRuleStoreProvider(store);
    provider.markEvaluated(rule.id);

    const updated = store.findById(rule.id);
    expect(updated!.lastEvaluatedAt).toBeDefined();
  });
});
