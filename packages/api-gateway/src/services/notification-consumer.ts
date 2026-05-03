/**
 * NotificationConsumer — subscribes to `alert.fired` on the IEventBus and
 * fans out to configured contact-point integrations (slack/webhook/discord/
 * teams) according to the org's NotificationPolicy tree.
 *
 * Routing is a label-matcher walk over the NotificationPolicyNode tree.
 * The repeat / group window is tracked in `notification_dispatch` keyed by
 * (fingerprint, contactPointId, groupKey) where groupKey is the policy's
 * `groupBy` labels joined.
 *
 * v1 scope:
 *   - First-send fires immediately. `groupWaitSec` is intentionally not
 *     honored: implementing it correctly requires a persisted scheduler
 *     so a gateway restart inside the wait window doesn't drop the send.
 *     Until that scheduler exists, "send right now" beats "maybe wait,
 *     maybe lose it on restart."
 *   - Mute timings are not consulted yet.
 *   - Pagerduty / email / opsgenie / telegram senders are not implemented
 *     (`senderFor` returns null; consumer logs + skips).
 */

import type {
  ContactPointIntegration,
  IEventBus,
  EventEnvelope,
  NotificationPolicyNode,
} from '@agentic-obs/common';
import {
  EventTypes,
  type AlertFiredEventPayload,
} from '@agentic-obs/common/events';
import type {
  INotificationRepository,
  INotificationDispatchRepository,
} from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/common/logging';
import { senderFor } from './notification-senders/index.js';
import type { Sender } from './notification-senders/index.js';

const log = createLogger('notification-consumer');

const DEFAULT_GROUP_INTERVAL_SEC = 300;
const DEFAULT_REPEAT_INTERVAL_SEC = 3600;

export interface NotificationConsumerOptions {
  bus: IEventBus;
  notifications: INotificationRepository;
  notificationDispatch: INotificationDispatchRepository;
  /** Override per integration type — for tests. Falls back to senderFor(). */
  senders?: (type: ContactPointIntegration['type']) => Sender | null;
  /** Test clock. */
  clock?: () => Date;
  /** Topic name; defaults to EventTypes.ALERT_FIRED. */
  topic?: string;
}

interface MatchedRoute {
  contactPointId: string;
  groupBy: string[];
  groupIntervalSec: number;
  repeatIntervalSec: number;
}

/**
 * Walk the NotificationPolicy tree and collect contact-point routes
 * matching the given alert labels. Honors `continueMatching`.
 *
 * Each child is a candidate; root is the fallback when no child matches
 * (identified by `isDefault === true`, the canonical flag from
 * NotificationPolicyNode).
 */
export function collectMatchingRoutes(
  tree: NotificationPolicyNode,
  labels: Record<string, string>,
): MatchedRoute[] {
  const out: MatchedRoute[] = [];
  walk(tree, labels, out);
  return out;
}

function walk(
  node: NotificationPolicyNode,
  labels: Record<string, string>,
  out: MatchedRoute[],
): boolean {
  let anyChildMatched = false;
  for (const child of node.children) {
    if (!matchersMatch(child.matchers, labels)) continue;
    anyChildMatched = true;
    out.push(toRoute(child));
    walk(child, labels, out);
    if (!child.continueMatching) {
      return true;
    }
  }
  // Default policy fallback when nothing else matched.
  if (!anyChildMatched && node.isDefault === true && node.contactPointId) {
    out.push(toRoute(node));
  }
  return anyChildMatched;
}

function toRoute(node: NotificationPolicyNode): MatchedRoute {
  return {
    contactPointId: node.contactPointId,
    groupBy: node.groupBy ?? [],
    groupIntervalSec: node.groupIntervalSec ?? DEFAULT_GROUP_INTERVAL_SEC,
    repeatIntervalSec: node.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC,
  };
}

function matchersMatch(
  matchers: NotificationPolicyNode['matchers'],
  labels: Record<string, string>,
): boolean {
  if (matchers.length === 0) return true;
  for (const m of matchers) {
    const v = labels[m.label] ?? '';
    switch (m.operator) {
      case '=':
        if (v !== m.value) return false;
        break;
      case '!=':
        if (v === m.value) return false;
        break;
      case '=~':
        if (!new RegExp(m.value).test(v)) return false;
        break;
      case '!~':
        if (new RegExp(m.value).test(v)) return false;
        break;
    }
  }
  return true;
}

export function computeGroupKey(
  groupBy: string[],
  labels: Record<string, string>,
): string {
  if (groupBy.length === 0) return '';
  return groupBy.map((label) => labels[label] ?? '').join('|');
}

/**
 * Whether to send right now, given an existing dispatch record (or its
 * absence) and the route's timing config.
 *
 *   - No prior dispatch → send.
 *   - Prior dispatch within `groupIntervalSec` → skip (still in the
 *     same notification group).
 *   - Prior dispatch past `repeatIntervalSec` → send (the alert is
 *     re-firing and we want a reminder).
 *   - In between → send (group continuation).
 */
export type DispatchDecision =
  | { kind: 'send-now' }
  | { kind: 'skip-group-window' };

export function decideDispatch(
  existing: { lastSentAt: string; sentCount: number } | undefined,
  route: { groupIntervalSec: number; repeatIntervalSec: number },
  now: Date,
): DispatchDecision {
  if (!existing) return { kind: 'send-now' };
  const last = new Date(existing.lastSentAt).getTime();
  const elapsedMs = now.getTime() - last;
  if (existing.sentCount > 0 && elapsedMs >= route.repeatIntervalSec * 1000) {
    return { kind: 'send-now' };
  }
  if (elapsedMs < route.groupIntervalSec * 1000) {
    return { kind: 'skip-group-window' };
  }
  return { kind: 'send-now' };
}

export class NotificationConsumer {
  private unsubscribe: (() => void) | null = null;
  private readonly clock: () => Date;
  private readonly senders: (type: ContactPointIntegration['type']) => Sender | null;
  private readonly topic: string;

  constructor(private readonly opts: NotificationConsumerOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.senders = opts.senders ?? senderFor;
    this.topic = opts.topic ?? EventTypes.ALERT_FIRED;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.subscribe<AlertFiredEventPayload>(
      this.topic,
      (env) => {
        void this.handle(env);
      },
    );
  }

  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  /** Public for tests; production callers go via subscribe(). */
  async handle(env: EventEnvelope<AlertFiredEventPayload>): Promise<void> {
    const payload = env.payload;
    let tree: NotificationPolicyNode;
    try {
      tree = await this.opts.notifications.getPolicyTree();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'failed to load notification policy tree',
      );
      return;
    }

    const routes = collectMatchingRoutes(tree, payload.labels);
    if (routes.length === 0) {
      log.warn(
        { ruleId: payload.ruleId, fingerprint: payload.fingerprint },
        'no matching contact point for alert; skipping notification',
      );
      return;
    }

    // Dedup routes pointing at the same contactPointId. The walk emits
    // parent-then-child, so the first instance wins — that's the broader
    // (parent) settings. If the operator wants child-specific timing,
    // they should configure `continueMatching: false` on the parent.
    const seen = new Set<string>();
    const unique = routes.filter((r) => {
      if (!r.contactPointId) return false;
      if (seen.has(r.contactPointId)) return false;
      seen.add(r.contactPointId);
      return true;
    });

    for (const route of unique) {
      await this.dispatchToContactPoint(payload, route);
    }
  }

  private async dispatchToContactPoint(
    payload: AlertFiredEventPayload,
    route: MatchedRoute,
  ): Promise<void> {
    const groupKey = computeGroupKey(route.groupBy, payload.labels);
    const now = this.clock();

    let existing;
    try {
      existing = await this.opts.notificationDispatch.findByKey(
        payload.orgId,
        payload.fingerprint,
        route.contactPointId,
        groupKey,
      );
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'dispatch lookup failed',
      );
      return;
    }

    const decision = decideDispatch(existing, route, now);
    if (decision.kind === 'skip-group-window') {
      log.debug(
        { ruleId: payload.ruleId, contactPointId: route.contactPointId, groupKey },
        'skipped: within groupInterval',
      );
      return;
    }

    await this.sendAndRecord(payload, route, groupKey);
  }

  private async sendAndRecord(
    payload: AlertFiredEventPayload,
    route: MatchedRoute,
    groupKey: string,
  ): Promise<void> {
    const cp = await this.opts.notifications.findContactPointById(route.contactPointId);
    if (!cp) {
      log.warn(
        { contactPointId: route.contactPointId, ruleId: payload.ruleId },
        'contact point not found',
      );
      return;
    }

    let anySent = false;
    for (const integration of cp.integrations) {
      const sender = this.senders(integration.type);
      if (!sender) {
        log.info(
          { type: integration.type, contactPointId: cp.id },
          'sender not implemented for type; skipping',
        );
        continue;
      }
      try {
        const result = await sender(integration, payload);
        if (result.ok) {
          anySent = true;
          log.info(
            {
              ruleId: payload.ruleId,
              contactPointId: cp.id,
              integrationId: integration.id,
              type: integration.type,
            },
            'notification sent',
          );
        } else {
          log.warn(
            {
              ruleId: payload.ruleId,
              contactPointId: cp.id,
              integrationId: integration.id,
              type: integration.type,
              message: result.message,
            },
            'notification send failed',
          );
        }
      } catch (err) {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            ruleId: payload.ruleId,
            contactPointId: cp.id,
            integrationId: integration.id,
          },
          'sender threw — continuing to next integration',
        );
      }
    }

    if (anySent) {
      try {
        await this.opts.notificationDispatch.upsertSent({
          orgId: payload.orgId,
          fingerprint: payload.fingerprint,
          contactPointId: route.contactPointId,
          groupKey,
          sentAt: this.clock().toISOString(),
        });
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
          'failed to persist notification_dispatch row',
        );
      }
    }
  }
}

