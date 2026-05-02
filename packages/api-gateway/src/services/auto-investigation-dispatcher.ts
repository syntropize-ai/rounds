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
import type { Identity, Investigation, InvestigationStatus } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import {
  runBackgroundAgent,
  type BackgroundRunnerDeps,
} from '@agentic-obs/agent-core';
import type { AlertFiredPayload } from './alert-evaluator-service.js';

/**
 * Minimum surface the dispatcher needs to finalize an investigation
 * row. Wider repository interfaces (sqlite / postgres / gateway-extended)
 * all satisfy this shape; depending on the narrow contract here keeps
 * the dispatcher decoupled from the bundle's exact intersection type.
 */
export interface DispatcherInvestigationStore {
  // Sync-or-async returns — repository signatures use MaybeAsync, which
  // resolves identically through `await` regardless of whether the
  // underlying call is synchronous (sqlite) or async (postgres).
  findByWorkspace(workspaceId: string): Investigation[] | Promise<Investigation[]>;
  updateStatus(
    id: string,
    status: InvestigationStatus,
  ): Investigation | null | undefined | Promise<Investigation | null | undefined>;
}

/**
 * Minimum surface the dispatcher needs to link the new investigation
 * back to its alert rule.
 */
export interface DispatcherAlertRuleStore {
  // Sync-or-async return — matches both sqlite and postgres repository
  // signatures via the data-layer's MaybeAsync. We don't consume the
  // result, only `await` it.
  update(id: string, partial: { investigationId?: string }): unknown;
}

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
  /**
   * Investigation repo. When provided, the dispatcher post-processes the
   * investigation row created by the agent's `investigation_create` tool
   * call: if the agent didn't call `investigation_complete`, the row is
   * transitioned to `completed` (or `failed` on agent error) so the UI
   * detail page renders something instead of spinning at `planning`.
   */
  investigations?: DispatcherInvestigationStore;
  /**
   * Alert-rule repo. When provided, the dispatcher writes the created
   * investigation's id back to `rule.investigationId` so the manual
   * Investigate button on the Alerts page reuses it instead of creating
   * a duplicate row.
   */
  alertRules?: DispatcherAlertRuleStore;
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

    // Snapshot the dispatch start time so we can find the investigation
    // row created by the agent's `investigation_create` tool below.
    const startedAtIso = this.clock().toISOString();

    let reply = '';
    let agentError: Error | null = null;
    try {
      reply = await this.spawnAgent(this.opts.runner, {
        identity,
        message: buildAlertQuestion(payload),
      });
      log.info(
        { ruleId: payload.ruleId, ruleName: payload.ruleName, replyHead: reply.slice(0, 120) },
        'auto-investigation completed',
      );
    } catch (err) {
      agentError = err instanceof Error ? err : new Error(String(err));
      // Crash isolation: one failed investigation must not stop the
      // dispatcher from handling future alerts. Fall through so the
      // finalization step still tries to mark whatever the agent created
      // as failed instead of leaving it stuck at planning.
      log.error(
        { err: agentError.message, ruleId: payload.ruleId },
        'auto-investigation failed',
      );
    }

    // Finalize the investigation row + link it to the rule. Best-effort:
    // missing repos (constructor was wired without them) just skip.
    await this.finalizeInvestigation(payload, identity, startedAtIso, reply, agentError);
  }

  /**
   * After the agent run returns (success or failure), find the investigation
   * row the agent created via `investigation_create` and:
   *
   *   1. If status is still in a pre-terminal state, transition it to
   *      `completed` (success) or `failed` (agent threw). Models often
   *      forget to call `investigation_complete`; without this, the row
   *      sits at `planning` forever and the UI spins.
   *   2. Write its id back to `rule.investigationId` so the manual
   *      Investigate button reuses this row instead of creating a
   *      duplicate one.
   *
   * Discovery is by `(workspaceId, createdAt > dispatchStart)` and picks
   * the most recently created row. There's no investigation→alertRule
   * foreign key today; if that becomes unreliable in practice the cleaner
   * fix is to add `alertRuleId` to the Investigation schema.
   */
  private async finalizeInvestigation(
    payload: AlertFiredPayload,
    identity: Identity,
    dispatchStartIso: string,
    _reply: string,
    agentError: Error | null,
  ): Promise<void> {
    const { investigations, alertRules } = this.opts;
    if (!investigations) return;

    let inv: { id: string; status: string; createdAt: string } | null = null;
    try {
      const list = await investigations.findByWorkspace(identity.orgId);
      // Latest investigation created at or after dispatchStart.
      const candidates = list
        .filter((r) => r.createdAt >= dispatchStartIso)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      inv = candidates[0] ?? null;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'finalize: investigation lookup failed',
      );
      return;
    }

    if (!inv) {
      // Agent never called investigation_create. Nothing to finalize.
      // The reply already landed in chat-service logs above; structured
      // persistence is on the agent.
      return;
    }

    // 1. Status transition. Pre-terminal states get flipped; terminal
    //    states (completed/failed) are left alone — the agent already
    //    finalized properly.
    const terminal = inv.status === 'completed' || inv.status === 'failed';
    if (!terminal) {
      const nextStatus = agentError ? 'failed' : 'completed';
      try {
        await investigations.updateStatus(inv.id, nextStatus);
        log.info(
          { investigationId: inv.id, from: inv.status, to: nextStatus, ruleId: payload.ruleId },
          'finalize: forced status transition (agent did not call investigation_complete)',
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), investigationId: inv.id },
          'finalize: updateStatus failed',
        );
      }
    }

    // 2. Link the investigation to the rule so manual re-Investigate
    //    reuses it. Best-effort; ignore non-fatal errors.
    if (alertRules) {
      try {
        await alertRules.update(payload.ruleId, { investigationId: inv.id });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId, investigationId: inv.id },
          'finalize: alertRule.update(investigationId) failed',
        );
      }
    }
  }

  /** Drop dedup entries older than the window so the map doesn't grow unbounded. */
  private gcRecent(now: number): void {
    for (const [k, v] of this.recent) {
      if (now - v >= this.dedupMs) this.recent.delete(k);
    }
  }
}
