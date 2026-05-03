/**
 * AutoInvestigationConsumer — when a rule transitions into `firing`,
 * automatically kick off an investigation that diagnoses why.
 *
 * Replaces the EventEmitter-coupled AutoInvestigationDispatcher: this
 * version subscribes to the `alert.fired` topic on an `IEventBus` and
 * uses a persistent dedup check (the alert rule's `investigationId` +
 * the linked investigation's status) instead of an in-memory time
 * window. That keeps dedup correct across api-gateway restarts and
 * across replicas, both of which the in-memory Map silently broke.
 *
 * Identity, agent dispatch, and investigation finalization are
 * unchanged from the prior dispatcher: the agent runs as the seeded
 * `openobs` service account, and the consumer post-processes the
 * investigation row created by `investigation_create` to flip pre-
 * terminal statuses to `completed`/`failed` and link the row back to
 * the alert rule.
 */
import type {
  AlertRule,
  Identity,
  IEventBus,
  Investigation,
  InvestigationStatus,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { EventTypes, type AlertFiredEventPayload } from '@agentic-obs/common/events';
import { createLogger } from '@agentic-obs/common/logging';
import {
  runBackgroundAgent,
  type BackgroundRunnerDeps,
} from '@agentic-obs/agent-core';

/** Topic name for fired-alert events on the bus. */
export const ALERT_FIRED_TOPIC = EventTypes.ALERT_FIRED;

const log = createLogger('auto-investigation');

/** Cooldown for the "no live SA token" warning so we don't spam the log. */
const NO_TOKEN_WARN_COOLDOWN_MS = 60_000;
/** Default cooldown for the persistent dedup check. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Investigation repo surface the consumer needs. Wider repository
 * interfaces (sqlite / postgres / gateway-extended) all satisfy this,
 * and depending on the narrow contract keeps us decoupled from the
 * bundle's exact intersection type.
 */
export interface ConsumerInvestigationStore {
  findById(id: string): Investigation | null | undefined | Promise<Investigation | null | undefined>;
  findByWorkspace(workspaceId: string): Investigation[] | Promise<Investigation[]>;
  updateStatus(
    id: string,
    status: InvestigationStatus,
  ): Investigation | null | undefined | Promise<Investigation | null | undefined>;
}

/** Alert-rule repo surface the consumer needs. */
export interface ConsumerAlertRuleStore {
  findById(id: string): AlertRule | null | undefined | Promise<AlertRule | null | undefined>;
  update(id: string, partial: { investigationId?: string }): unknown;
}

/**
 * Resolves the identity to use for an auto-investigation, freshly per
 * alert. Returning `null` means "skip this run gracefully" — typically
 * the SA user hasn't been seeded yet.
 */
export type SaIdentityResolver = () => Promise<Identity | null>;

export interface AutoInvestigationConsumerOptions {
  /** Bus to subscribe on. */
  bus: IEventBus;
  /** Service-account token resolver + orchestrator factory. */
  runner: BackgroundRunnerDeps;
  /** Resolves the SA identity per fired alert. */
  resolveSaIdentity: SaIdentityResolver;
  /** Alert-rule repo. Used both for dedup lookup and finalize back-link. */
  alertRules: ConsumerAlertRuleStore;
  /** Investigation repo. Used for dedup lookup and finalize. */
  investigations: ConsumerInvestigationStore;
  /**
   * Window after a terminal investigation during which a re-firing rule is
   * deduped. Defaults to 5 minutes.
   */
  cooldownMs?: number;
  /** Override for tests. */
  clock?: () => Date;
  /** Override the spawned background-agent function — useful in tests. */
  spawnAgent?: typeof runBackgroundAgent;
}

/** Build a {@link SaIdentityResolver} backed by the SA user row. */
export function buildSaIdentityResolverFromRepos(deps: {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  saLogin?: string;
  orgId?: string;
}): SaIdentityResolver {
  const saLogin = deps.saLogin ?? 'openobs';
  const orgId = deps.orgId ?? 'org_main';
  return async () => {
    const sa = await deps.users.findByLogin(saLogin);
    if (!sa || !sa.isServiceAccount || sa.isDisabled) return null;
    const member = await deps.orgUsers.findMembership(orgId, sa.id);
    if (!member) return null;
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
export function buildAlertQuestion(payload: AlertFiredEventPayload): string {
  const labelsBit = Object.keys(payload.labels).length > 0
    ? ` (labels: ${Object.entries(payload.labels).map(([k, v]) => `${k}=${v}`).join(', ')})`
    : '';
  return [
    `Alert "${payload.ruleName}" (${payload.severity}) is firing${labelsBit}.`,
    `Condition: value ${payload.operator} ${payload.threshold}; current ${payload.value}.`,
    'Investigate the root cause and propose a fix if one is in scope.',
  ].join(' ');
}

const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'investigating',
  'evidencing',
  'explaining',
  'acting',
  'verifying',
]);

export class AutoInvestigationConsumer {
  private readonly cooldownMs: number;
  private readonly clock: () => Date;
  private readonly spawnAgent: typeof runBackgroundAgent;
  private unsubscribe: (() => void) | null = null;
  private lastNoTokenWarnAt = 0;

  constructor(private readonly opts: AutoInvestigationConsumerOptions) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = opts.clock ?? (() => new Date());
    this.spawnAgent = opts.spawnAgent ?? runBackgroundAgent;
  }

  /** Subscribe to `alert.fired` on the bus. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.subscribe<AlertFiredEventPayload>(
      ALERT_FIRED_TOPIC,
      (event) => this.onAlertFired(event.payload),
    );
  }

  /** Stop listening. Idempotent. */
  stop(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = null;
  }

  /**
   * Persistent dedup check. The rule's `investigationId` points at the
   * most recent auto-investigation we wrote back. If that row is still
   * running, skip; if it terminated within the cooldown, skip. Otherwise
   * we run.
   */
  async shouldRun(payload: AlertFiredEventPayload): Promise<boolean> {
    const rule = await this.opts.alertRules.findById(payload.ruleId);
    if (!rule || !rule.investigationId) return true;
    const inv = await this.opts.investigations.findById(rule.investigationId);
    if (!inv) return true;
    if (RUNNING_STATUSES.has(inv.status)) return false;
    const lastTsRaw = inv.updatedAt ?? inv.createdAt;
    const lastTs = new Date(lastTsRaw).getTime();
    return this.clock().getTime() - lastTs > this.cooldownMs;
  }

  /**
   * Handle one alert.fired event. Public for tests; production callers
   * go through `start()` and the bus.
   */
  async onAlertFired(payload: AlertFiredEventPayload): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.shouldRun(payload);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
        'auto-investigation dedup check threw — skipping',
      );
      return;
    }
    if (!allowed) {
      log.debug({ ruleId: payload.ruleId }, 'auto-investigation deduped');
      return;
    }

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
      const now = this.clock().getTime();
      if (now - this.lastNoTokenWarnAt >= NO_TOKEN_WARN_COOLDOWN_MS) {
        log.warn(
          { ruleId: payload.ruleId, ruleName: payload.ruleName },
          'no service-account identity available for auto-investigation; skipping. ' +
          'Ensure the openobs SA user is seeded and not disabled.',
        );
        this.lastNoTokenWarnAt = now;
      }
      return;
    }

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
      log.error(
        { err: agentError.message, ruleId: payload.ruleId },
        'auto-investigation failed',
      );
    }

    await this.finalizeInvestigation(payload, identity, startedAtIso, agentError);
  }

  /**
   * After the agent run returns (success or failure), find the investigation
   * row the agent created via `investigation_create` and:
   *   1. Force a terminal status if it's still pre-terminal — agents
   *      sometimes forget to call `investigation_complete` and the UI
   *      spins at `planning` without this.
   *   2. Write its id back to `rule.investigationId` so the dedup check
   *      on the next firing finds it, and so the manual Investigate
   *      button reuses the row instead of creating a duplicate.
   */
  private async finalizeInvestigation(
    payload: AlertFiredEventPayload,
    identity: Identity,
    dispatchStartIso: string,
    agentError: Error | null,
  ): Promise<void> {
    const { investigations, alertRules } = this.opts;
    let inv: Investigation | null = null;
    try {
      const list = await investigations.findByWorkspace(identity.orgId);
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

    if (!inv) return;

    const terminal = inv.status === 'completed' || inv.status === 'failed';
    if (!terminal) {
      const nextStatus: InvestigationStatus = agentError ? 'failed' : 'completed';
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

