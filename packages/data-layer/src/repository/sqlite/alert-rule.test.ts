import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { AlertRuleRepository } from './alert-rule.js';

// A minimal AlertRule input that leaves out the server-filled fields.
function sampleInput(overrides: Partial<Parameters<AlertRuleRepository['create']>[0]> = {}) {
  return {
    name: 'High CPU',
    description: 'CPU too high on web-tier',
    condition: {
      query: 'avg(cpu) by (host)',
      operator: '>' as const,
      threshold: 80,
      forDurationSec: 300,
    },
    evaluationIntervalSec: 60,
    severity: 'high' as const,
    labels: { team: 'web', env: 'prod' },
    createdBy: 'user_1',
    ...overrides,
  };
}

describe('AlertRuleRepository', () => {
  let db: SqliteClient;
  let repo: AlertRuleRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AlertRuleRepository(db);
  });

  describe('rules CRUD', () => {
    it('create() seeds state=normal, fireCount=0, ISO timestamps', async () => {
      const rule = await repo.create(sampleInput());
      expect(rule.id).toMatch(/^alert_/);
      expect(rule.state).toBe('normal');
      expect(rule.fireCount).toBe(0);
      expect(rule.stateChangedAt).toBe(rule.createdAt);
      expect(rule.updatedAt).toBe(rule.createdAt);
      expect(rule.labels).toEqual({ team: 'web', env: 'prod' });
      expect(rule.condition.threshold).toBe(80);
    });

    it('findById() round-trips JSON columns', async () => {
      const created = await repo.create(sampleInput());
      const got = await repo.findById(created.id);
      expect(got).toBeDefined();
      expect(got!.condition).toEqual(created.condition);
      expect(got!.labels).toEqual(created.labels);
    });

    it('findById() returns undefined for unknown id', async () => {
      expect(await repo.findById('alert_missing')).toBeUndefined();
    });

    it('findAll() returns all rules with total, ordered by updatedAt DESC', async () => {
      const a = await repo.create(sampleInput({ name: 'A' }));
      // Force a later updatedAt on the second rule via a tiny sleep.
      await new Promise((r) => setTimeout(r, 10));
      const b = await repo.create(sampleInput({ name: 'B' }));
      const { list, total } = await repo.findAll();
      expect(total).toBe(2);
      expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    });

    it('findAll() filters by state and severity', async () => {
      await repo.create(sampleInput({ name: 'critical-rule', severity: 'critical' }));
      await repo.create(sampleInput({ name: 'low-rule', severity: 'low' }));
      const { list, total } = await repo.findAll({ severity: 'critical' });
      expect(total).toBe(1);
      expect(list[0]!.severity).toBe('critical');
    });

    it('findAll() search matches name, description, and label values', async () => {
      await repo.create(sampleInput({ name: 'Database slow', labels: { team: 'infra' } }));
      await repo.create(sampleInput({ name: 'Webapp 500s', description: 'five hundreds' }));
      await repo.create(sampleInput({ name: 'other', labels: { team: 'needle' } }));
      const { total: t1 } = await repo.findAll({ search: 'database' });
      expect(t1).toBe(1);
      const { total: t2 } = await repo.findAll({ search: 'hundred' });
      expect(t2).toBe(1);
      const { total: t3 } = await repo.findAll({ search: 'needle' });
      expect(t3).toBe(1);
    });

    it('findAll() applies limit/offset after total is computed', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.create(sampleInput({ name: `r${i}` }));
        await new Promise((r) => setTimeout(r, 2));
      }
      const { list, total } = await repo.findAll({ limit: 2, offset: 1 });
      expect(total).toBe(5);
      expect(list).toHaveLength(2);
    });

    it('findByWorkspace() filters on workspace_id', async () => {
      await repo.create(sampleInput({ name: 'ws-a', workspaceId: 'ws_1' }));
      await repo.create(sampleInput({ name: 'ws-b', workspaceId: 'ws_2' }));
      await repo.create(sampleInput({ name: 'no-ws' }));
      const list = await repo.findByWorkspace('ws_1');
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe('ws-a');
    });

    it('update() patches fields and bumps updated_at', async () => {
      const rule = await repo.create(sampleInput());
      await new Promise((r) => setTimeout(r, 5));
      const updated = await repo.update(rule.id, { description: 'new' });
      expect(updated!.description).toBe('new');
      expect(updated!.updatedAt).not.toBe(rule.updatedAt);
    });

    it('update() returns undefined for unknown id', async () => {
      const updated = await repo.update('alert_missing', { description: 'x' });
      expect(updated).toBeUndefined();
    });

    it('delete() removes and cascades history', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'pending');
      expect((await repo.getHistory(rule.id))).toHaveLength(1);
      expect(await repo.delete(rule.id)).toBe(true);
      expect(await repo.findById(rule.id)).toBeUndefined();
      // cascade
      expect(await repo.getHistory(rule.id)).toHaveLength(0);
      expect(await repo.delete(rule.id)).toBe(false);
    });
  });

  describe('transition() — full state machine coverage', () => {
    it('normal → pending sets pendingSince, appends history', async () => {
      const rule = await repo.create(sampleInput());
      const out = await repo.transition(rule.id, 'pending', 90);
      expect(out!.state).toBe('pending');
      expect(out!.pendingSince).toBeDefined();
      expect(out!.lastEvaluatedAt).toBe(out!.stateChangedAt);
      const hist = await repo.getHistory(rule.id);
      expect(hist).toHaveLength(1);
      expect(hist[0]!.fromState).toBe('normal');
      expect(hist[0]!.toState).toBe('pending');
      expect(hist[0]!.value).toBe(90);
      expect(hist[0]!.threshold).toBe(80);
      expect(hist[0]!.labels).toEqual({ team: 'web', env: 'prod' });
    });

    it('pending → firing clears pendingSince, bumps fireCount, sets lastFiredAt', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'pending', 90);
      const firing = await repo.transition(rule.id, 'firing', 95);
      expect(firing!.state).toBe('firing');
      expect(firing!.pendingSince).toBeUndefined();
      expect(firing!.lastFiredAt).toBeDefined();
      expect(firing!.fireCount).toBe(1);
    });

    it('normal → firing (skip pending) bumps fireCount once', async () => {
      const rule = await repo.create(sampleInput());
      const firing = await repo.transition(rule.id, 'firing', 99);
      expect(firing!.state).toBe('firing');
      expect(firing!.fireCount).toBe(1);
      expect(firing!.pendingSince).toBeUndefined();
    });

    it('firing → resolved clears pendingSince', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'firing');
      const resolved = await repo.transition(rule.id, 'resolved');
      expect(resolved!.state).toBe('resolved');
      expect(resolved!.pendingSince).toBeUndefined();
      // fireCount stays at 1 (resolution doesn't increment)
      expect(resolved!.fireCount).toBe(1);
    });

    it('resolved → normal clears pendingSince', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'firing');
      await repo.transition(rule.id, 'resolved');
      const normal = await repo.transition(rule.id, 'normal');
      expect(normal!.state).toBe('normal');
      expect(normal!.pendingSince).toBeUndefined();
    });

    it('firing → firing is a no-op: no history, no fireCount bump', async () => {
      const rule = await repo.create(sampleInput());
      const firing1 = await repo.transition(rule.id, 'firing');
      const firing2 = await repo.transition(rule.id, 'firing');
      // No-op transition returns the same state-changed-at (not refreshed).
      expect(firing2!.state).toBe('firing');
      expect(firing2!.stateChangedAt).toBe(firing1!.stateChangedAt);
      expect(firing2!.fireCount).toBe(1);
      const hist = await repo.getHistory(rule.id);
      expect(hist).toHaveLength(1); // only the normal → firing entry
    });

    it('firing → firing again after a resolution does re-increment fireCount', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'firing'); // fireCount = 1
      await repo.transition(rule.id, 'resolved');
      const fireAgain = await repo.transition(rule.id, 'firing'); // fireCount = 2
      expect(fireAgain!.fireCount).toBe(2);
    });

    it('transition() on unknown rule returns undefined', async () => {
      expect(await repo.transition('alert_missing', 'firing')).toBeUndefined();
    });

    it('disabled state transition is recorded but has no pendingSince effect', async () => {
      const rule = await repo.create(sampleInput());
      const disabled = await repo.transition(rule.id, 'disabled');
      expect(disabled!.state).toBe('disabled');
      // disabled is not one of the 4 explicit branches, so no pending
      // clear / no fireCount bump — matches the in-memory store.
      expect(disabled!.pendingSince).toBeUndefined();
      expect(disabled!.fireCount).toBe(0);
      const hist = await repo.getHistory(rule.id);
      expect(hist).toHaveLength(1);
      expect(hist[0]!.toState).toBe('disabled');
    });
  });

  describe('history', () => {
    it('getHistory() returns rule-scoped entries, most-recent first', async () => {
      const a = await repo.create(sampleInput({ name: 'a' }));
      const b = await repo.create(sampleInput({ name: 'b' }));
      await repo.transition(a.id, 'pending');
      await new Promise((r) => setTimeout(r, 5));
      await repo.transition(a.id, 'firing');
      await new Promise((r) => setTimeout(r, 5));
      await repo.transition(b.id, 'firing');

      const histA = await repo.getHistory(a.id);
      expect(histA).toHaveLength(2);
      expect(histA[0]!.toState).toBe('firing');
      expect(histA[1]!.toState).toBe('pending');

      const histB = await repo.getHistory(b.id);
      expect(histB).toHaveLength(1);
    });

    it('getAllHistory() returns across rules with default limit', async () => {
      const a = await repo.create(sampleInput({ name: 'a' }));
      const b = await repo.create(sampleInput({ name: 'b' }));
      await repo.transition(a.id, 'firing');
      await repo.transition(b.id, 'pending');
      const hist = await repo.getAllHistory();
      expect(hist).toHaveLength(2);
    });

    it('getHistory() respects explicit limit', async () => {
      const rule = await repo.create(sampleInput());
      await repo.transition(rule.id, 'pending');
      await new Promise((r) => setTimeout(r, 5));
      await repo.transition(rule.id, 'firing');
      await new Promise((r) => setTimeout(r, 5));
      await repo.transition(rule.id, 'resolved');
      const hist = await repo.getHistory(rule.id, 2);
      expect(hist).toHaveLength(2);
      expect(hist[0]!.toState).toBe('resolved');
    });
  });

  describe('silences', () => {
    const future = () => new Date(Date.now() + 60_000).toISOString();
    const past = () => new Date(Date.now() - 60_000).toISOString();
    const wayPast = () => new Date(Date.now() - 120_000).toISOString();

    it('createSilence() computes active status when now is inside window', async () => {
      const s = await repo.createSilence({
        matchers: [{ label: 'severity', operator: '=', value: 'critical' }],
        startsAt: past(),
        endsAt: future(),
        comment: 'planned maintenance',
        createdBy: 'ops',
      });
      expect(s.id).toMatch(/^silence_/);
      expect(s.status).toBe('active');
      expect(s.matchers).toHaveLength(1);
    });

    it('findSilences() excludes expired, findAllSilencesIncludingExpired() includes them', async () => {
      await repo.createSilence({
        matchers: [],
        startsAt: past(),
        endsAt: future(),
        comment: 'a',
        createdBy: 'u',
      });
      await repo.createSilence({
        matchers: [],
        startsAt: wayPast(),
        endsAt: past(),
        comment: 'expired',
        createdBy: 'u',
      });
      const active = await repo.findSilences();
      expect(active).toHaveLength(1);
      const all = await repo.findAllSilencesIncludingExpired();
      expect(all).toHaveLength(2);
      expect(all.find((s) => s.comment === 'expired')!.status).toBe('expired');
    });

    it('updateSilence() patches comment and re-computes status', async () => {
      const s = await repo.createSilence({
        matchers: [],
        startsAt: past(),
        endsAt: future(),
        comment: 'initial',
        createdBy: 'u',
      });
      const updated = await repo.updateSilence(s.id, { comment: 'revised' });
      expect(updated!.comment).toBe('revised');
      expect(updated!.status).toBe('active');
    });

    it('updateSilence() on unknown id returns undefined', async () => {
      expect(await repo.updateSilence('silence_missing', { comment: 'x' })).toBeUndefined();
    });

    it('deleteSilence() removes the row', async () => {
      const s = await repo.createSilence({
        matchers: [],
        startsAt: past(),
        endsAt: future(),
        comment: 'c',
        createdBy: 'u',
      });
      expect(await repo.deleteSilence(s.id)).toBe(true);
      expect(await repo.deleteSilence(s.id)).toBe(false);
    });
  });

  describe('notification policies', () => {
    it('createPolicy() / findPolicyById() round-trip', async () => {
      const p = await repo.createPolicy({
        name: 'pager on critical',
        matchers: [{ label: 'severity', operator: '=', value: 'critical' }],
        channels: [{ type: 'pagerduty', config: { integrationKey: 'pd-key' } }],
        groupBy: ['alertname', 'cluster'],
        groupWaitSec: 30,
        groupIntervalSec: 300,
        repeatIntervalSec: 3600,
      });
      expect(p.id).toMatch(/^policy_/);
      const got = await repo.findPolicyById(p.id);
      expect(got!.matchers).toEqual(p.matchers);
      expect(got!.channels).toEqual(p.channels);
      expect(got!.groupBy).toEqual(['alertname', 'cluster']);
      expect(got!.groupWaitSec).toBe(30);
    });

    it('findAllPolicies() returns every policy', async () => {
      await repo.createPolicy({ name: 'p1', matchers: [], channels: [] });
      await repo.createPolicy({ name: 'p2', matchers: [], channels: [] });
      const all = await repo.findAllPolicies();
      expect(all).toHaveLength(2);
    });

    it('updatePolicy() patches name and updated_at', async () => {
      const p = await repo.createPolicy({ name: 'initial', matchers: [], channels: [] });
      await new Promise((r) => setTimeout(r, 5));
      const upd = await repo.updatePolicy(p.id, { name: 'renamed' });
      expect(upd!.name).toBe('renamed');
      expect(upd!.updatedAt).not.toBe(p.updatedAt);
    });

    it('updatePolicy() on unknown id returns undefined', async () => {
      expect(await repo.updatePolicy('policy_missing', { name: 'x' })).toBeUndefined();
    });

    it('deletePolicy() removes the row', async () => {
      const p = await repo.createPolicy({ name: 'tmp', matchers: [], channels: [] });
      expect(await repo.deletePolicy(p.id)).toBe(true);
      expect(await repo.findPolicyById(p.id)).toBeUndefined();
      expect(await repo.deletePolicy(p.id)).toBe(false);
    });
  });

  // P1 — corrupt JSON columns must throw (was silently returning a default
  // condition with threshold=0, which silently disarmed the alert).
  describe('corrupt JSON guard', () => {
    it('findById throws when the condition column is corrupt instead of returning threshold=0', async () => {
      const rule = await repo.create(sampleInput());
      db.run(sql`UPDATE alert_rules SET condition = ${'{not json'} WHERE id = ${rule.id}`);
      await expect(repo.findById(rule.id)).rejects.toThrow(/corrupt JSON in column "condition"/);
    });
  });
});
