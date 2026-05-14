import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDashboardRepository } from './dashboard.js';

describe('InMemoryDashboardRepository', () => {
  let repo: InMemoryDashboardRepository;

  const makeParams = (overrides: Record<string, unknown> = {}) => ({
    title: 'Test Dashboard',
    description: 'A test dashboard',
    prompt: 'Show me CPU usage',
    userId: 'user-1',
    datasourceIds: ['ds-1'],
    ...overrides,
  });

  beforeEach(() => {
    repo = new InMemoryDashboardRepository();
  });

  it('create() returns dashboard with id', async () => {
    const dashboard = await repo.create(makeParams());
    expect(dashboard.id).toBeDefined();
    expect(typeof dashboard.id).toBe('string');
    expect(dashboard.title).toBe('Test Dashboard');
    expect(dashboard.description).toBe('A test dashboard');
    expect(dashboard.status).toBe('generating');
    expect(dashboard.createdAt).toBeDefined();
    expect(dashboard.updatedAt).toBeDefined();
  });

  it('findById() returns dashboard', async () => {
    const created = await repo.create(makeParams());
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe('Test Dashboard');
  });

  it('findById() returns null for unknown id', async () => {
    const found = await repo.findById('nonexistent-id');
    expect(found).toBeNull();
  });

  it('update() modifies dashboard', async () => {
    const created = await repo.create(makeParams());
    const updated = await repo.update(created.id, { title: 'Updated Title' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Updated Title');
    expect(updated!.description).toBe('A test dashboard');

    const found = await repo.findById(created.id);
    expect(found!.title).toBe('Updated Title');
  });

  it('delete() removes dashboard', async () => {
    const created = await repo.create(makeParams());
    const deleted = await repo.delete(created.id);
    expect(deleted).toBe(true);
    expect(await repo.findById(created.id)).toBeNull();
  });

  it('delete() returns false for unknown id', async () => {
    expect(await repo.delete('nonexistent')).toBe(false);
  });

  it('findAll() returns all dashboards', async () => {
    await repo.create(makeParams({ title: 'Dashboard 1' }));
    await repo.create(makeParams({ title: 'Dashboard 2' }));
    await repo.create(makeParams({ title: 'Dashboard 3', userId: 'user-2' }));

    const all = await repo.findAll();
    expect(all).toHaveLength(3);
  });

  it('findAll() filters by userId', async () => {
    await repo.create(makeParams({ title: 'Dashboard 1', userId: 'user-1' }));
    await repo.create(makeParams({ title: 'Dashboard 2', userId: 'user-2' }));

    const user1 = await repo.findAll('user-1');
    expect(user1).toHaveLength(1);
    expect(user1[0]!.userId).toBe('user-1');
  });

  it('listByWorkspace() filters by workspaceId', async () => {
    await repo.create(makeParams({ workspaceId: 'ws-a' }));
    await repo.create(makeParams({ workspaceId: 'ws-b' }));
    const wsA = await repo.listByWorkspace('ws-a');
    expect(wsA).toHaveLength(1);
    expect(wsA[0]!.workspaceId).toBe('ws-a');
  });
});
