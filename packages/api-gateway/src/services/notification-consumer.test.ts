import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ContactPoint,
  ContactPointIntegration,
  NotificationPolicyNode,
} from '@agentic-obs/common';
import { InMemoryEventBus, type AlertFiredEventPayload } from '@agentic-obs/common/events';
import type {
  INotificationRepository,
  INotificationDispatchRepository,
  NotificationDispatchRow,
  UpsertDispatchInput,
} from '@agentic-obs/data-layer';
import {
  NotificationConsumer,
  collectMatchingRoutes,
  computeGroupKey,
  decideDispatch,
} from './notification-consumer.js';
import type { Sender } from './notification-senders/index.js';

function nodeOf(partial: Partial<NotificationPolicyNode>): NotificationPolicyNode {
  return {
    id: partial.id ?? 'n',
    matchers: partial.matchers ?? [],
    contactPointId: partial.contactPointId ?? '',
    groupBy: partial.groupBy ?? [],
    groupWaitSec: partial.groupWaitSec ?? 30,
    groupIntervalSec: partial.groupIntervalSec ?? 300,
    repeatIntervalSec: partial.repeatIntervalSec ?? 3600,
    continueMatching: partial.continueMatching ?? false,
    muteTimingIds: partial.muteTimingIds ?? [],
    children: partial.children ?? [],
    isDefault: partial.isDefault ?? false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function basePayload(overrides: Partial<AlertFiredEventPayload> = {}): AlertFiredEventPayload {
  return {
    ruleId: 'r1',
    ruleName: 'high-error-rate',
    orgId: 'org_main',
    severity: 'high',
    value: 0.12,
    threshold: 0.05,
    operator: '>',
    labels: { team: 'web' },
    firedAt: '2026-05-03T00:00:00.000Z',
    fingerprint: 'fp-1',
    ...overrides,
  };
}

class FakeNotifRepo implements Partial<INotificationRepository> {
  constructor(private tree: NotificationPolicyNode, private cps: ContactPoint[]) {}
  async getPolicyTree() { return this.tree; }
  async findContactPointById(id: string) { return this.cps.find((c) => c.id === id); }
}

class FakeDispatchRepo implements INotificationDispatchRepository {
  rows: NotificationDispatchRow[] = [];
  async findByKey(orgId: string, fingerprint: string, contactPointId: string, groupKey: string) {
    return this.rows.find(
      (r) => r.orgId === orgId
        && r.fingerprint === fingerprint
        && r.contactPointId === contactPointId
        && r.groupKey === groupKey,
    );
  }
  async upsertSent(input: UpsertDispatchInput): Promise<NotificationDispatchRow> {
    const idx = this.rows.findIndex(
      (r) => r.fingerprint === input.fingerprint
        && r.contactPointId === input.contactPointId
        && r.groupKey === input.groupKey,
    );
    if (idx >= 0) {
      const cur = this.rows[idx]!;
      const updated: NotificationDispatchRow = {
        ...cur,
        lastSentAt: input.sentAt,
        sentCount: cur.sentCount + 1,
      };
      this.rows[idx] = updated;
      return updated;
    }
    const row: NotificationDispatchRow = {
      id: `nd_${this.rows.length}`,
      orgId: input.orgId,
      fingerprint: input.fingerprint,
      contactPointId: input.contactPointId,
      groupKey: input.groupKey,
      lastSentAt: input.sentAt,
      sentCount: 1,
    };
    this.rows.push(row);
    return row;
  }
}

function cpWith(id: string, integrations: ContactPointIntegration[]): ContactPoint {
  return {
    id,
    name: id,
    integrations,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('collectMatchingRoutes', () => {
  it('matches a child whose label matcher equals the alert label', () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: 'cp-default',
      children: [
        nodeOf({ id: 'c1', matchers: [{ label: 'team', operator: '=', value: 'web' }], contactPointId: 'cp-web' }),
      ],
    });
    expect(collectMatchingRoutes(tree, { team: 'web' }).map((r) => r.contactPointId)).toEqual(['cp-web']);
  });

  it('falls through to the default policy when no child matches', () => {
    const tree = nodeOf({
      id: 'root',
      isDefault: true,
      contactPointId: 'cp-default',
      children: [
        nodeOf({ id: 'c1', matchers: [{ label: 'team', operator: '=', value: 'web' }], contactPointId: 'cp-web' }),
      ],
    });
    expect(collectMatchingRoutes(tree, { team: 'data' }).map((r) => r.contactPointId)).toEqual(['cp-default']);
  });

  it('does NOT fall through when the root is not flagged as default', () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: 'cp-default',
      children: [
        nodeOf({ id: 'c1', matchers: [{ label: 'team', operator: '=', value: 'web' }], contactPointId: 'cp-web' }),
      ],
    });
    expect(collectMatchingRoutes(tree, { team: 'data' })).toEqual([]);
  });

  it('walks into nested children and returns the deepest match', () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: 'cp-default',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-web',
          children: [
            nodeOf({
              id: 'c2',
              matchers: [{ label: 'severity', operator: '=', value: 'critical' }],
              contactPointId: 'cp-web-critical',
            }),
          ],
        }),
      ],
    });
    const routes = collectMatchingRoutes(tree, { team: 'web', severity: 'critical' });
    expect(routes.map((r) => r.contactPointId)).toContain('cp-web-critical');
  });

  it('continueMatching: true returns both parent and sibling matches', () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-a',
          continueMatching: true,
        }),
        nodeOf({
          id: 'c2',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-b',
        }),
      ],
    });
    const ids = collectMatchingRoutes(tree, { team: 'web' }).map((r) => r.contactPointId);
    expect(ids).toContain('cp-a');
    expect(ids).toContain('cp-b');
  });
});

describe('computeGroupKey', () => {
  it('joins groupBy values with "|" and uses empty string for missing labels', () => {
    expect(computeGroupKey(['team', 'env'], { team: 'web' })).toBe('web|');
  });
  it('returns empty string when groupBy is empty', () => {
    expect(computeGroupKey([], { team: 'web' })).toBe('');
  });
});

describe('decideDispatch', () => {
  const route = { groupIntervalSec: 300, repeatIntervalSec: 3600 };
  it('first send fires immediately (no group-wait delay in v1)', () => {
    const d = decideDispatch(undefined, route, new Date('2026-05-03T00:00:00Z'));
    expect(d).toEqual({ kind: 'send-now' });
  });
  it('skips when within groupInterval since last send', () => {
    const existing = { lastSentAt: '2026-05-03T00:00:00Z', sentCount: 1 };
    const d = decideDispatch(existing, route, new Date('2026-05-03T00:01:00Z')); // +60s
    expect(d.kind).toBe('skip-group-window');
  });
  it('allows resend after repeatInterval has elapsed', () => {
    const existing = { lastSentAt: '2026-05-03T00:00:00Z', sentCount: 1 };
    const d = decideDispatch(existing, route, new Date('2026-05-03T01:00:00Z')); // +3600s
    expect(d.kind).toBe('send-now');
  });
});

describe('NotificationConsumer', () => {
  let bus: InMemoryEventBus;
  let dispatchRepo: FakeDispatchRepo;
  let calls: Array<{ integrationId: string; payload: AlertFiredEventPayload }>;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    dispatchRepo = new FakeDispatchRepo();
    calls = [];
  });

  function makeConsumer(opts: {
    tree: NotificationPolicyNode;
    cps: ContactPoint[];
    senderImpl?: Sender;
    clock?: () => Date;
  }) {
    const sender: Sender = opts.senderImpl ?? (async (integration, payload) => {
      calls.push({ integrationId: integration.id, payload });
      return { ok: true, message: 'ok' };
    });
    return new NotificationConsumer({
      bus,
      notifications: new FakeNotifRepo(opts.tree, opts.cps) as unknown as INotificationRepository,
      notificationDispatch: dispatchRepo,
      senders: () => sender,
      clock: opts.clock ?? (() => new Date('2026-05-03T00:00:00Z')),
    });
  }

  it('routes to the contact point matched by the policy tree and invokes the sender', async () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-web',
        }),
      ],
    });
    const integration: ContactPointIntegration = { id: 'i1', type: 'slack', name: 's', settings: { url: 'https://hooks/abc' } };
    const consumer = makeConsumer({ tree, cps: [cpWith('cp-web', [integration])] });

    await consumer.handle({
      id: 'e1',
      type: 'alert.fired',
      timestamp: '2026-05-03T00:00:00Z',
      payload: basePayload(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.integrationId).toBe('i1');
    expect(calls[0]!.payload.fingerprint).toBe('fp-1');
    expect(dispatchRepo.rows).toHaveLength(1);
    expect(dispatchRepo.rows[0]!.sentCount).toBe(1);
  });

  it('dedups subsequent sends within the groupInterval window', async () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-web',
          groupBy: ['team'],
        }),
      ],
    });
    const integration: ContactPointIntegration = { id: 'i1', type: 'slack', name: 's', settings: { url: 'https://hooks/abc' } };
    let now = new Date('2026-05-03T00:00:00Z');
    const consumer = makeConsumer({ tree, cps: [cpWith('cp-web', [integration])], clock: () => now });

    await consumer.handle({ id: 'e1', type: 'alert.fired', timestamp: '', payload: basePayload() });
    expect(calls).toHaveLength(1);

    // Second event 60s later — within groupInterval (300s), should skip.
    now = new Date('2026-05-03T00:01:00Z');
    await consumer.handle({ id: 'e2', type: 'alert.fired', timestamp: '', payload: basePayload() });
    expect(calls).toHaveLength(1);
    expect(dispatchRepo.rows[0]!.sentCount).toBe(1);
  });

  it('allows a resend after repeatInterval has elapsed', async () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-web',
          repeatIntervalSec: 3600,
        }),
      ],
    });
    const integration: ContactPointIntegration = { id: 'i1', type: 'slack', name: 's', settings: { url: 'https://hooks/abc' } };
    let now = new Date('2026-05-03T00:00:00Z');
    const consumer = makeConsumer({ tree, cps: [cpWith('cp-web', [integration])], clock: () => now });

    await consumer.handle({ id: 'e1', type: 'alert.fired', timestamp: '', payload: basePayload() });
    expect(calls).toHaveLength(1);

    // 70 minutes later — past repeatInterval.
    now = new Date('2026-05-03T01:10:00Z');
    await consumer.handle({ id: 'e2', type: 'alert.fired', timestamp: '', payload: basePayload() });
    expect(calls).toHaveLength(2);
  });

  it('logs and continues to next integration when one sender throws', async () => {
    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({
          id: 'c1',
          matchers: [{ label: 'team', operator: '=', value: 'web' }],
          contactPointId: 'cp-web',
        }),
      ],
    });
    const i1: ContactPointIntegration = { id: 'broken', type: 'slack', name: 's', settings: { url: 'https://hooks/abc' } };
    const i2: ContactPointIntegration = { id: 'ok', type: 'webhook', name: 'w', settings: { url: 'https://hooks/abc' } };

    const senderImpl: Sender = vi.fn(async (integration) => {
      if (integration.id === 'broken') throw new Error('boom');
      calls.push({ integrationId: integration.id, payload: basePayload() });
      return { ok: true, message: 'ok' };
    });

    const consumer = makeConsumer({ tree, cps: [cpWith('cp-web', [i1, i2])], senderImpl });
    await consumer.handle({ id: 'e1', type: 'alert.fired', timestamp: '', payload: basePayload() });

    expect(senderImpl).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.integrationId)).toEqual(['ok']);
    expect(dispatchRepo.rows).toHaveLength(1);
  });

  it('start/stop subscribes and unsubscribes from the bus', () => {
    // Use the bus's underlying EventEmitter listenerCount as ground truth.
    // The consumer's subscribe handler wraps handle() in `void` (fire-and-
    // forget), so going through bus.publish + waiting on async would race;
    // checking listener registration is the same contract without timing.
    const emitter = (bus as unknown as { emitter: { listenerCount: (t: string) => number } }).emitter;

    const tree = nodeOf({
      id: 'root',
      contactPointId: '',
      children: [
        nodeOf({ id: 'c1', matchers: [{ label: 'team', operator: '=', value: 'web' }], contactPointId: 'cp-web' }),
      ],
    });
    const integration: ContactPointIntegration = { id: 'i1', type: 'slack', name: 's', settings: { url: 'https://hooks/abc' } };
    const consumer = makeConsumer({ tree, cps: [cpWith('cp-web', [integration])] });

    expect(emitter.listenerCount('alert.fired')).toBe(0);

    consumer.start();
    expect(emitter.listenerCount('alert.fired')).toBe(1);

    consumer.start(); // idempotent — no double-subscribe
    expect(emitter.listenerCount('alert.fired')).toBe(1);

    consumer.stop();
    expect(emitter.listenerCount('alert.fired')).toBe(0);

    consumer.stop(); // idempotent
    expect(emitter.listenerCount('alert.fired')).toBe(0);
  });
});
