/**
 * AutoInvestigationDispatcher — when a rule transitions into `firing`,
 * automatically kick off an investigation that diagnoses why.
 *
 * Phase 8 of `docs/design/auto-remediation.md`. Subscribes to the
 * AlertEvaluatorService's `alert.fired` event and dispatches a background
 * orchestrator run via `runBackgroundAgent`. The agent runs as a
 * service-account identity resolved from a configured SA token; it has
 * no human-side capabilities (cannot approve plans, etc.).
 *
 * Dedup: same ruleId within the dedup window only spawns one
 * investigation. v1 uses an in-memory LRU; multi-replica HA needs a
 * persistent marker on the rule row — tracked as a follow-up.
 *
 * The dispatcher does NOT own the alert event source — it's handed an
 * `AlertEvaluatorService` (or any EventEmitter that emits the
 * `alert.fired` shape). Stop/start is just `subscribe()` + `unsubscribe()`,
 * matching the lifecycle the api-gateway boot sequence expects.
 */

import type { EventEmitter } from 'node:events';
import type { Identity } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import {
  runBackgroundAgent,
  type BackgroundRunnerDeps,
} from '@agentic-obs/agent-core';
import type { AlertFiredPayload } from './alert-evaluator-service.js';

const log = createLogger('auto-investigation');

/** Default dedup window if the caller doesn't supply one. */
const DEFAULT_DEDUP_MS = 5 * 60 * 1000;
/** Cooldown for the "no live SA token" warning so we don't spam the log. */
const NO_TOKEN_WARN_COOLDOWN_MS = 60_000;

/**
 * Resolves the identity to use for an auto-investigation, freshly per
 * alert. Returning `null` means "skip this run gracefully" — typically
 * the operator hasn't minted a service-account token yet. Implementations
 * are expected to consult the live api_key table so a token minted via
 * the UI is picked up without restarting the gateway.
 */
export type SaIdentityResolver = () => Promise<Identity | null>;

export interface AutoInvestigationDispatcherOptions {
  /** Source of `alert.fired` events. AlertEvaluatorService satisfies this. */
  alertEvents: EventEmitter;
  /** Service-account token resolver + orchestrator factory. */
  runner: BackgroundRunnerDeps;
  /**
   * Resolves the SA identity for each fired alert. Called per-event so
   * tokens minted after boot are picked up without a restart. When the
   * resolver returns `null`, the dispatcher logs (rate-limited) and skips
   * the run instead of crashing.
   */
  resolveSaIdentity: SaIdentityResolver;
  /**
   * Same ruleId firing within this window is deduped. Defaults to 5 minutes;
   * pass `forDurationSec * 2 * 1000` for tighter alignment to the rule.
   */
  dedupMs?: number;
  /** Override for tests. */
  clock?: () => Date;
  /**
   * Override the spawned background-agent function — useful in tests so we
   * don't have to stand up a real orchestrator. Defaults to
   * `runBackgroundAgent`.
   */
  spawnAgent?: typeof runBackgroundAgent;
}

/**
 * Build a {@link SaIdentityResolver} backed by the SA user row + the live
 * api_key table. Returns `null` when:
 *   - the SA user doesn't exist (seeding hasn't run)
 *   - the SA has no membership in the target org
 *   - no non-revoked, non-expired api_key row exists for the SA
 *
 * The identity is constructed directly — we never look up plaintext
 * tokens (the column stores SHA-256 only). The presence of a live key
 * row is the operator-consent gate; any caller spawning agent runs with
 * this identity is auditable as the SA.
 */
export function buildSaIdentityResolverFromRepos(deps: {
  users: import('@agentic-obs/common').IUserRepository;
  orgUsers: import('@agentic-obs/common').IOrgUserRepository;
  apiKeys: import('@agentic-obs/common').IApiKeyRepository;
  /** SA login name; defaults to 'openobs' (the seeded auto-investigation SA). */
  saLogin?: string;
  /** Org id to bind the identity to; defaults to 'org_main'. */
  orgId?: string;
  clock?: () => Date;
}): SaIdentityResolver {
  const saLogin = deps.saLogin ?? 'openobs';
  const orgId = deps.orgId ?? 'org_main';
  const clock = deps.clock ?? (() => new Date());
  return async () => {
    const sa = await deps.users.findByLogin(saLogin);
    if (!sa || !sa.isServiceAccount) return null;
    const member = await deps.orgUsers.findMembership(orgId, sa.id);
    if (!member) return null;
    const keys = await deps.apiKeys.list({
      orgId,
      serviceAccountId: sa.id,
      includeRevoked: false,
      includeExpired: false,
    });
    const nowIso = clock().toISOString();
    const live = keys.items.find(
      (k) => !k.isRevoked && (k.expires === null || k.expires > nowIso),
    );
    if (!live) return null;
    return {
      userId: sa.id,
      orgId,
      orgRole: member.role,
      isServerAdmin: false,
      authenticatedBy: 'api_key',
      serviceAccountId: sa.id,
    };
  };
}

/** Compose a question string from an alert payload. */
export function buildAlertQuestion(payload: AlertFiredPayload): string {
  const opPretty = payload.operator;
  const labelsBit = Object.keys(payload.labels).length > 0
    ? ` (labels: ${Object.entries(payload.labels).map(([k, v]) => `${k}=${v}`).join(', ')})`
    : '';
  return [
    `Alert "${payload.ruleName}" (${payload.severity}) is firing${labelsBit}.`,
    `Condition: value ${opPretty} ${payload.threshold}; current ${payload.value}.`,
    'Investigate the root cause and propose a fix if one is in scope.',
  ].join(' ');
}

export class AutoInvestigationDispatcher {
  private readonly listener: (payload: AlertFiredPayload) => void;
  private readonly recent = new Map<string, number>(); // ruleId -> ms timestamp
  private readonly dedupMs: number;
  private readonly clock: () => Date;
  private readonly spawnAgent: typeof runBackgroundAgent;
  private subscribed = false;
  private lastNoTokenWarnAt = 0;

  constructor(private readonly opts: AutoInvestigationDispatcherOptions) {
    this.dedupMs = opts.dedupMs ?? DEFAULT_DEDUP_MS;
    this.clock = opts.clock ?? (() => new Date());
    this.spawnAgent = opts.spawnAgent ?? runBackgroundAgent;
    this.listener = (payload) => { void this.onAlertFired(payload); };
  }

  /** Begin listening. Idempotent — calling twice does not double-subscribe. */
  subscribe(): void {
    if (this.subscribed) return;
    this.opts.alertEvents.on('alert.fired', this.listener);
    this.subscribed = true;
  }

  unsubscribe(): void {
    if (!this.subscribed) return;
    this.opts.alertEvents.off('alert.fired', this.listener);
    this.subscribed = false;
  }

  /**
   * Handle one alert.fired event. Public for tests; production callers go
   * through `subscribe()`.
   */
  async onAlertFired(payload: AlertFiredPayload): Promise<void> {
    const now = this.clock().getTime();
    const last = this.recent.get(payload.ruleId);
    if (last !== undefined && now - last < this.dedupMs) {
      log.debug({ ruleId: payload.ruleId, deltaMs: now - last }, 'auto-investigation deduped');
      return;
    }

    // Resolve identity per-event so tokens minted in the UI after boot are
    // picked up without a restart. A null return (no live SA token) is a
    // configuration state, not a crash — log once per cooldown window and
    // skip.
    let identity: Identity | null;
    try {
      identity = await this.opts.resolveSaIdentity();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'auto-investigation SA identity resolution threw — skipping',
      );
      return;
    }
    if (!identity) {
      if (now - this.lastNoTokenWarnAt >= NO_TOKEN_WARN_COOLDOWN_MS) {
        log.warn(
          { ruleId: payload.ruleId, ruleName: payload.ruleName },
          'no live service-account token found for auto-investigation; skipping. ' +
          'Mint a token under Admin → Service accounts to enable.',
        );
        this.lastNoTokenWarnAt = now;
      }
      return;
    }

    // Only mark as "recently fired" once we know we'll actually run; if
    // we skipped for missing-token, the next firing should retry, not be
    // deduped.
    this.recent.set(payload.ruleId, now);
    this.gcRecent(now);

    try {
      const reply = await this.spawnAgent(this.opts.runner, {
        identity,
        message: buildAlertQuestion(payload),
      });
      log.info(
        { ruleId: payload.ruleId, ruleName: payload.ruleName, replyHead: reply.slice(0, 120) },
        'auto-investigation completed',
      );
    } catch (err) {
      // Crash isolation: one failed investigation must not stop the
      // dispatcher from handling future alerts.
      log.error(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'auto-investigation failed',
      );
    }
  }

  /** Drop dedup entries older than the window so the map doesn't grow unbounded. */
  private gcRecent(now: number): void {
    for (const [k, v] of this.recent) {
      if (now - v >= this.dedupMs) this.recent.delete(k);
    }
  }
}
