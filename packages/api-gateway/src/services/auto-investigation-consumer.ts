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
 * `rounds` service account, and the consumer post-processes the
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
import { createLogger } from '@agentic-obs/server-utils/logging';
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
/** Auto-alert investigations older than this are considered abandoned. */
const DEFAULT_RUNNING_STALE_MS = 30 * 60 * 1000;
/** Hard cap for one background agent run. Keeps alert UI state from sticking. */
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTO_ALERT_SESSION_PREFIX = 'auto-alert:';

function sanitizeSessionPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function buildAutoAlertSessionId(payload: AlertFiredEventPayload, startedAtIso: string): string {
  const eventPart = payload.fingerprint || payload.firedAt || startedAtIso;
  return [
    AUTO_ALERT_SESSION_PREFIX,
    sanitizeSessionPart(payload.ruleId),
    ':',
    sanitizeSessionPart(eventPart),
    ':',
    sanitizeSessionPart(startedAtIso),
  ].join('');
}

/**
 * Investigation repo surface the consumer needs. Wider repository
 * interfaces (sqlite / postgres / gateway-extended) all satisfy this,
 * and depending on the narrow contract keeps us decoupled from the
 * bundle's exact intersection type.
 */
export interface ConsumerInvestigationStore {
  create?(input: {
    question: string;
    sessionId: string;
    userId: string;
    tenantId?: string;
    workspaceId?: string;
  }): Investigation | Promise<Investigation>;
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
  findAll?(): { list: AlertRule[]; total: number } | Promise<{ list: AlertRule[]; total: number }>;
  findByWorkspace?(workspaceId: string): AlertRule[] | Promise<AlertRule[]>;
  update(id: string, partial: {
    investigationId?: string;
    investigationStartedAt?: string;
    investigationFailedAt?: string;
    investigationFailureReason?: string;
  }): unknown;
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
  /**
   * Window after which a pre-terminal auto-alert investigation is considered
   * abandoned. This prevents Alerts from showing "Investigating..." forever if
   * the api-gateway process restarts or the agent dies before finalization.
   */
  staleRunningMs?: number;
  /**
   * Maximum wall-clock time for one background agent invocation. The agent may
   * still be deep, but the alert row must not remain "Investigating..." forever
   * if the runner gets stuck behind an invisible wait.
   */
  agentRunTimeoutMs?: number;
  /** Org whose auto-alert rows should be swept for stale state. */
  orgId?: string;
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
  const saLogin = deps.saLogin ?? 'rounds';
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
  private readonly staleRunningMs: number;
  private readonly agentRunTimeoutMs: number;
  private readonly orgId: string;
  private readonly clock: () => Date;
  private readonly spawnAgent: typeof runBackgroundAgent;
  private unsubscribe: (() => void) | null = null;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastNoTokenWarnAt = 0;

  constructor(private readonly opts: AutoInvestigationConsumerOptions) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.staleRunningMs = opts.staleRunningMs ?? DEFAULT_RUNNING_STALE_MS;
    this.agentRunTimeoutMs = opts.agentRunTimeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
    this.orgId = opts.orgId ?? 'org_main';
    this.clock = opts.clock ?? (() => new Date());
    this.spawnAgent = opts.spawnAgent ?? runBackgroundAgent;
  }

  /** Subscribe to `alert.fired` on the bus. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    void this.markInterruptedAlertLevelInvestigations()
      .then(() => this.markStaleLiveInvestigations())
      .catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'stale auto-investigation sweep failed',
        );
      });
    this.staleSweepTimer = setInterval(() => {
      void this.markStaleAutoInvestigations().catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'stale auto-investigation sweep failed',
        );
      });
    }, Math.min(this.staleRunningMs, 60_000));
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
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
  }

  /**
   * Persistent dedup check. The rule's `investigationId` points at the
   * most recent auto-investigation we wrote back. If that row is still
   * running, skip; if it terminated within the cooldown, skip. Otherwise
   * we run.
   */
  async shouldRun(payload: AlertFiredEventPayload): Promise<boolean> {
    const rule = await this.opts.alertRules.findById(payload.ruleId);
    if (!rule) return true;
    if (!rule.investigationId && rule.investigationStartedAt) {
      const startedTs = new Date(rule.investigationStartedAt).getTime();
      if (Number.isFinite(startedTs) && this.clock().getTime() - startedTs <= this.staleRunningMs) {
        return false;
      }
      return true;
    }
    if (!rule.investigationId) return true;
    const inv = await this.opts.investigations.findById(rule.investigationId);
    if (!inv) return true;
    if (RUNNING_STATUSES.has(inv.status)) {
      if (!this.isStaleAutoAlertInvestigation(inv)) return false;
      try {
        await this.opts.investigations.updateStatus(inv.id, 'failed');
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), investigationId: inv.id },
          'stale auto-investigation status update failed during dedup check',
        );
      }
      return true;
    }
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
          'Ensure the rounds SA user is seeded and not disabled.',
        );
        this.lastNoTokenWarnAt = now;
      }
      return;
    }

    const startedAtIso = this.clock().toISOString();
    const sessionId = buildAutoAlertSessionId(payload, startedAtIso);
    await this.markInvestigationStarted(payload.ruleId, startedAtIso);

    let reply = '';
    let agentError: Error | null = null;
    try {
      reply = await this.runAgentWithTimeout({
        identity,
        sessionId,
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

    try {
      await this.finalizeInvestigation(payload, identity, sessionId, agentError);
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          ruleId: payload.ruleId,
          sessionId,
        },
        'auto-investigation finalize failed',
      );
      try {
        await this.opts.alertRules.update(payload.ruleId, {
          investigationStartedAt: undefined,
          investigationFailedAt: this.clock().toISOString(),
          investigationFailureReason: err instanceof Error ? err.message : String(err),
        });
      } catch (updateErr) {
        log.error(
          {
            err: updateErr instanceof Error ? updateErr.message : String(updateErr),
            ruleId: payload.ruleId,
            sessionId,
          },
          'auto-investigation finalize failure marker update failed',
        );
      }
    }
  }

  private async runAgentWithTimeout(input: Parameters<typeof runBackgroundAgent>[1]): Promise<string> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.spawnAgent(this.opts.runner, input),
        new Promise<string>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Auto-investigation timed out after ${this.agentRunTimeoutMs}ms.`));
          }, this.agentRunTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async markInvestigationStarted(ruleId: string, startedAtIso: string): Promise<void> {
    try {
      await this.opts.alertRules.update(ruleId, {
        investigationId: undefined,
        investigationStartedAt: startedAtIso,
        investigationFailedAt: undefined,
        investigationFailureReason: undefined,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), ruleId },
        'auto-investigation start marker update failed',
      );
    }
  }

  private isStaleAutoAlertInvestigation(inv: Investigation): boolean {
    if (!RUNNING_STATUSES.has(inv.status)) return false;
    if (!inv.sessionId?.startsWith(AUTO_ALERT_SESSION_PREFIX)) return false;
    const lastTs = new Date(inv.updatedAt ?? inv.createdAt).getTime();
    return Number.isFinite(lastTs) && this.clock().getTime() - lastTs > this.staleRunningMs;
  }

  private async markStaleLiveInvestigations(): Promise<void> {
    const list = await this.opts.investigations.findByWorkspace(this.orgId);
    const stale = list.filter((inv) => this.isStaleAutoAlertInvestigation(inv));
    for (const inv of stale) {
      try {
        await this.opts.investigations.updateStatus(inv.id, 'failed');
        log.warn(
          { investigationId: inv.id, updatedAt: inv.updatedAt },
          'marked stale auto-investigation as failed',
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), investigationId: inv.id },
          'stale auto-investigation status update failed',
        );
      }
    }
  }

  private async listAlertRulesInOrg(): Promise<AlertRule[] | null> {
    if (this.opts.alertRules.findByWorkspace) {
      return this.opts.alertRules.findByWorkspace(this.orgId);
    }
    if (this.opts.alertRules.findAll) {
      const result = await this.opts.alertRules.findAll();
      return result.list.filter((rule) => rule.workspaceId === this.orgId);
    }
    return null;
  }

  private isStaleAlertLevelInvestigation(rule: AlertRule): boolean {
    if (rule.investigationId) return false;
    if (!rule.investigationStartedAt) return false;
    const startedTs = new Date(rule.investigationStartedAt).getTime();
    return Number.isFinite(startedTs) && this.clock().getTime() - startedTs > this.staleRunningMs;
  }

  private async markStaleAlertLevelInvestigations(): Promise<void> {
    const list = await this.listAlertRulesInOrg();
    if (!list) return;
    const stale = list.filter((rule) => this.isStaleAlertLevelInvestigation(rule));
    for (const rule of stale) {
      try {
        await this.opts.alertRules.update(rule.id, {
          investigationStartedAt: undefined,
          investigationFailedAt: this.clock().toISOString(),
          investigationFailureReason: 'The investigation was interrupted before saving a report.',
        });
        log.warn(
          { ruleId: rule.id, investigationStartedAt: rule.investigationStartedAt },
          'marked stale alert investigation marker as failed',
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), ruleId: rule.id },
          'stale alert investigation marker update failed',
        );
      }
    }
  }

  private async markInterruptedAlertLevelInvestigations(): Promise<void> {
    const list = await this.listAlertRulesInOrg();
    if (!list) return;
    const interrupted = list.filter((rule) => !rule.investigationId && Boolean(rule.investigationStartedAt));
    for (const rule of interrupted) {
      try {
        await this.opts.alertRules.update(rule.id, {
          investigationStartedAt: undefined,
          investigationFailedAt: this.clock().toISOString(),
          investigationFailureReason: 'The investigation was interrupted before this API process started.',
        });
        log.warn(
          { ruleId: rule.id, investigationStartedAt: rule.investigationStartedAt },
          'marked interrupted alert investigation marker as failed on startup',
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), ruleId: rule.id },
          'interrupted alert investigation marker update failed',
        );
      }
    }
  }

  private async markStaleAutoInvestigations(): Promise<void> {
    await this.markStaleLiveInvestigations();
    await this.markStaleAlertLevelInvestigations();
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
    sessionId: string,
    agentError: Error | null,
  ): Promise<void> {
    const { investigations, alertRules } = this.opts;
    let inv: Investigation | null = null;
    try {
      const list = await investigations.findByWorkspace(identity.orgId);
      const candidates = list
        .filter((r) => r.sessionId === sessionId)
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
      try {
        await alertRules.update(payload.ruleId, {
          investigationStartedAt: undefined,
          investigationFailedAt: this.clock().toISOString(),
          investigationFailureReason: agentError
            ? agentError.message
            : `The agent finished without saving an investigation report for session ${sessionId}.`,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId },
          'finalize: clear start marker failed',
        );
      }
      return;
    }

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
      await alertRules.update(payload.ruleId, {
        investigationId: inv.id,
        investigationStartedAt: undefined,
        investigationFailedAt: undefined,
        investigationFailureReason: undefined,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), ruleId: payload.ruleId, investigationId: inv.id },
        'finalize: alertRule.update(investigationId) failed',
      );
    }
  }
}
