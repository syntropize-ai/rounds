import { describe, it, expect, beforeEach } from 'vitest';
import { InvestigationStore } from '../investigation-store.js';

describe('InvestigationStore', () => {
  let store: InvestigationStore;

  const makeParams = (overrides: Record<string, unknown> = {}) => ({
    question: 'Why is latency high?',
    sessionId: 'session-1',
    userId: 'user-1',
    ...overrides,
  });

  beforeEach(() => {
    store = new InvestigationStore();
  });

  it('create() and findById()', () => {
    const inv = store.create(makeParams());
    expect(inv.id).toBeDefined();
    expect(inv.id).toMatch(/^inv_/);
    expect(inv.intent).toBe('Why is latency high?');
    expect(inv.status).toBe('planning');

    const found = store.findById(inv.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inv.id);
  });

  it('findById() returns undefined for unknown id', () => {
    expect(store.findById('nonexistent')).toBeUndefined();
  });

  it('updateStatus() changes status', () => {
    const inv = store.create(makeParams());
    const updated = store.updateStatus(inv.id, 'investigating');
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('investigating');

    const found = store.findById(inv.id);
    expect(found!.status).toBe('investigating');
  });

  it('updateStatus() returns undefined for unknown id', () => {
    expect(store.updateStatus('nonexistent', 'completed')).toBeUndefined();
  });

  it('updatePlan() updates plan', () => {
    const inv = store.create(makeParams());
    const newPlan = {
      entity: 'api-server',
      objective: 'Find root cause of latency',
      steps: [{ id: 'step-1', type: 'metrics' as const, description: 'Check metrics', status: 'pending' as const }],
      stopConditions: [{ type: 'high_confidence_hypothesis' as const, params: { threshold: 0.8 } }],
    };

    const updated = store.updatePlan(inv.id, newPlan);
    expect(updated).toBeDefined();
    expect(updated!.plan.entity).toBe('api-server');
    expect(updated!.plan.objective).toBe('Find root cause of latency');
    expect(updated!.plan.steps).toHaveLength(1);
  });

  it('findAll() returns investigations', () => {
    store.create(makeParams({ question: 'Question 1' }));
    store.create(makeParams({ question: 'Question 2' }));
    store.create(makeParams({ question: 'Question 3' }));

    const all = store.findAll();
    expect(all).toHaveLength(3);
  });

  it('findAll() filters by tenantId', () => {
    store.create(makeParams({ question: 'Q1', tenantId: 'tenant-a' }));
    store.create(makeParams({ question: 'Q2', tenantId: 'tenant-b' }));

    const tenantA = store.findAll('tenant-a');
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]!.intent).toBe('Q1');
  });
});
