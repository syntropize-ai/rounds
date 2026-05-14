import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAlertRuleRepository } from './alert-rule.js';

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

describe('InMemoryAlertRuleRepository', () => {
  let repo: InMemoryAlertRuleRepository;

  beforeEach(() => {
    repo = new InMemoryAlertRuleRepository();
  });

  it('create() and findById()', async () => {
    const rule = await repo.create(makeRuleData());
    expect(rule.id).toBeDefined();
    expect(rule.id).toMatch(/^alert_/);
    expect(rule.name).toBe('High CPU');
    expect(rule.state).toBe('normal');
    expect(rule.fireCount).toBe(0);

    const found = await repo.findById(rule.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(rule.id);
  });

  it('findAll() with state filter', async () => {
    const rule1 = await repo.create(makeRuleData({ name: 'Rule 1' }));
    await repo.create(makeRuleData({ name: 'Rule 2' }));

    const normalRules = await repo.findAll({ state: 'normal' });
    expect(normalRules.list).toHaveLength(2);
    expect(normalRules.total).toBe(2);

    await repo.transition(rule1.id, 'firing', 95);

    const firingRules = await repo.findAll({ state: 'firing' });
    expect(firingRules.list).toHaveLength(1);
    expect(firingRules.list[0]!.name).toBe('Rule 1');

    const stillNormal = await repo.findAll({ state: 'normal' });
    expect(stillNormal.list).toHaveLength(1);
  });

  it('transition() changes state', async () => {
    const rule = await repo.create(makeRuleData());
    expect(rule.state).toBe('normal');

    const pending = await repo.transition(rule.id, 'pending', 91);
    expect(pending).toBeDefined();
    expect(pending!.state).toBe('pending');
    expect(pending!.pendingSince).toBeDefined();

    const firing = await repo.transition(rule.id, 'firing', 95);
    expect(firing).toBeDefined();
    expect(firing!.state).toBe('firing');
    expect(firing!.fireCount).toBe(1);
    expect(firing!.lastFiredAt).toBeDefined();
    expect(firing!.pendingSince).toBeUndefined();
  });

  it('transition() to same state is a no-op', async () => {
    const rule = await repo.create(makeRuleData());
    const same = await repo.transition(rule.id, 'normal');
    expect(same).toBeDefined();
    expect(same!.state).toBe('normal');
  });

  it('getFolderUid() reads folderUid label fallback for agent-created rules', async () => {
    const rule = await repo.create(
      makeRuleData({ labels: { folderUid: 'team-a' } }),
    );
    expect(await repo.getFolderUid('org_main', rule.id)).toBe('team-a');
    expect(await repo.getFolderUid('org_main', 'unknown')).toBeNull();
  });
});
