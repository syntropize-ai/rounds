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
  type ApprovalCreatedEventPayload,
} from '@agentic-obs/common/events';
import type {
  INotificationRepository,
  INotificationDispatchRepository,
} from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/server-utils/logging';
import { senderFor } from './notification-senders/index.js';
import type { Sender } from './notification-senders/index.js';
import type { ApprovalRouter, ApprovalRow } from './approval-router.js';
import type { ITeamMemberRepository } from '@agentic-obs/common';

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
  /**
   * Optional approval-routing surface. When wired, the consumer also
   * subscribes to `approval.created` and fans out to users whose
   * `approvals:approve` grant covers the approval's scope. Without it,
   * approval routing is silently disabled (alert.fired path unaffected).
   * See approvals-multi-team-scope §3.7.
   */
  approvalRouter?: ApprovalRouter;
  /**
   * Required when `approvalRouter` is set — used to resolve a recipient
   * user's teams so the policy tree (which keys on `team` labels) can
   * locate their contact points.
   */
  teamMembers?: ITeamMemberRepository;
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
  private unsubscribeAlert: (() => void) | null = null;
  private unsubscribeApproval: (() => void) | null = null;
  private readonly clock: () => Date;
  private readonly senders: (type: ContactPointIntegration['type']) => Sender | null;
  private readonly topic: string;

  constructor(private readonly opts: NotificationConsumerOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.senders = opts.senders ?? senderFor;
    this.topic = opts.topic ?? EventTypes.ALERT_FIRED;
  }

  start(): void {
    if (!this.unsubscribeAlert) {
      this.unsubscribeAlert = this.opts.bus.subscribe<AlertFiredEventPayload>(
        this.topic,
        (env) => {
          void this.handle(env);
        },
      );
    }
    if (!this.unsubscribeApproval && this.opts.approvalRouter) {
      this.unsubscribeApproval = this.opts.bus.subscribe<ApprovalCreatedEventPayload>(
        EventTypes.APPROVAL_CREATED,
        (env) => {
          void this.handleApprovalCreated(env);
        },
      );
    }
  }

  stop(): void {
    if (this.unsubscribeAlert) {
      this.unsubscribeAlert();
      this.unsubscribeAlert = null;
    }
    if (this.unsubscribeApproval) {
      this.unsubscribeApproval();
      this.unsubscribeApproval = null;
    }
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
        // warn, not info: an operator configured this contact point and is
        // expecting to hear from it. Silently dropping the notification at
        // info level is how "we never got paged" becomes a surprise.
        log.warn(
          { type: integration.type, contactPointId: cp.id },
          'no sender implemented for this integration type — notification dropped',
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

  /**
   * Handle an `approval.created` event: find users whose `approvals:approve`
   * grant covers the row, look up each user's teams, walk the policy tree
   * keyed on `team` labels to find their contact points, and fan out.
   *
   * Idempotency: uses the approvalId as the dispatch fingerprint, so a
   * duplicate publish (e.g. retry) does not re-notify (T3.1 acceptance #7).
   *
   * Fail-closed: callers MUST NOT fall back to broader scopes — the router
   * already enforces this; here we just trust the recipient list it returns.
   */
  async handleApprovalCreated(
    env: EventEnvelope<ApprovalCreatedEventPayload>,
  ): Promise<void> {
    if (!this.opts.approvalRouter || !this.opts.teamMembers) {
      log.warn({ approvalId: env.payload.approvalId }, 'approval router not wired; skipping');
      return;
    }
    const payload = env.payload;
    const row: ApprovalRow = {
      id: payload.approvalId,
      opsConnectorId: payload.opsConnectorId,
      targetNamespace: payload.targetNamespace,
      requesterTeamId: payload.requesterTeamId,
    };

    let userIds: string[];
    try {
      userIds = await this.opts.approvalRouter.findApprovers(payload.orgId, row);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), approvalId: payload.approvalId },
        'failed to resolve approvers for approval.created',
      );
      return;
    }

    if (userIds.length === 0) {
      log.info({ approvalId: payload.approvalId }, 'no users matched approval scope; skipping');
      return;
    }

    let tree: NotificationPolicyNode;
    try {
      tree = await this.opts.notifications.getPolicyTree();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), approvalId: payload.approvalId },
        'failed to load notification policy tree',
      );
      return;
    }

    // For each user: find their teams, ask the policy tree for routes
    // matching `{ team: <teamId> }` per team. Dedup contact points across
    // users so two recipients sharing a team channel only get one send.
    const seenContactPoints = new Set<string>();
    const routes: MatchedRoute[] = [];
    for (const userId of userIds) {
      let memberships;
      try {
        memberships = await this.opts.teamMembers.listTeamsForUser(userId, payload.orgId);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), userId },
          'failed to list teams for user; skipping',
        );
        continue;
      }
      for (const m of memberships) {
        const matched = collectMatchingRoutes(tree, { team: m.teamId });
        for (const r of matched) {
          if (!r.contactPointId) continue;
          if (seenContactPoints.has(r.contactPointId)) continue;
          seenContactPoints.add(r.contactPointId);
          routes.push(r);
        }
      }
    }

    if (routes.length === 0) {
      log.info(
        { approvalId: payload.approvalId, userCount: userIds.length },
        'no contact points reachable for matched approvers; skipping',
      );
      return;
    }

    // Adapt the approval payload to the existing Sender shape (which takes
    // an AlertFiredEventPayload). Senders use `ruleName`/`severity`/`labels`
    // for body text — synthesize equivalents from the approval row.
    const adapted: AlertFiredEventPayload = {
      ruleId: payload.approvalId,
      ruleName: `Approval pending: ${payload.summary}`,
      orgId: payload.orgId,
      severity: payload.severity ?? 'medium',
      value: 0,
      threshold: 0,
      operator: 'pending',
      labels: {
        approvalId: payload.approvalId,
        ...(payload.opsConnectorId ? { connector: payload.opsConnectorId } : {}),
        ...(payload.targetNamespace ? { namespace: payload.targetNamespace } : {}),
        ...(payload.requesterTeamId ? { team: payload.requesterTeamId } : {}),
      },
      firedAt: payload.createdAt,
      fingerprint: payload.approvalId,
    };

    for (const route of routes) {
      await this.dispatchToContactPoint(adapted, route);
    }
  }
}

