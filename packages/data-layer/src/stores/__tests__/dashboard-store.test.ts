import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardStore } from '../dashboard-store.js';

describe('DashboardStore', () => {
  let store: DashboardStore;

  const makeParams = (overrides: Record<string, unknown> = {}) => ({
    title: 'Test Dashboard',
    description: 'A test dashboard',
    prompt: 'Show me CPU usage',
    userId: 'user-1',
    datasourceIds: ['ds-1'],
    ...overrides,
  });

  beforeEach(() => {
    store = new DashboardStore();
  });

  it('create() returns dashboard with id', () => {
    const dashboard = store.create(makeParams());
    expect(dashboard.id).toBeDefined();
    expect(typeof dashboard.id).toBe('string');
    expect(dashboard.title).toBe('Test Dashboard');
    expect(dashboard.description).toBe('A test dashboard');
    expect(dashboard.status).toBe('generating');
    expect(dashboard.createdAt).toBeDefined();
    expect(dashboard.updatedAt).toBeDefined();
  });

  it('findById() returns dashboard', () => {
    const created = store.create(makeParams());
    const found = store.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe('Test Dashboard');
  });

  it('findById() returns undefined for unknown id', () => {
    const found = store.findById('nonexistent-id');
    expect(found).toBeUndefined();
  });

  it('update() modifies dashboard', () => {
    const created = store.create(makeParams());
    const updated = store.update(created.id, { title: 'Updated Title' });
    expect(updated).toBeDefined();
    expect(updated!.title).toBe('Updated Title');
    expect(updated!.description).toBe('A test dashboard');

    const found = store.findById(created.id);
    expect(found!.title).toBe('Updated Title');
  });

  it('delete() removes dashboard', () => {
    const created = store.create(makeParams());
    const deleted = store.delete(created.id);
    expect(deleted).toBe(true);
    expect(store.findById(created.id)).toBeUndefined();
  });

  it('delete() returns false for unknown id', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('findAll() returns all dashboards', () => {
    store.create(makeParams({ title: 'Dashboard 1' }));
    store.create(makeParams({ title: 'Dashboard 2' }));
    store.create(makeParams({ title: 'Dashboard 3', userId: 'user-2' }));

    const all = store.findAll();
    expect(all).toHaveLength(3);
  });

  it('findAll() filters by userId', () => {
    store.create(makeParams({ title: 'Dashboard 1', userId: 'user-1' }));
    store.create(makeParams({ title: 'Dashboard 2', userId: 'user-2' }));

    const user1 = store.findAll('user-1');
    expect(user1).toHaveLength(1);
    expect(user1[0]!.userId).toBe('user-1');
  });
});
