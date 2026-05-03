/**
 * Boot wiring for the alert evaluator.
 *
 * Phase 0.5 of `docs/design/auto-remediation.md` boot path. Stands up
 * the periodic AlertEvaluatorService against the configured default
 * Prometheus-compatible datasource, behind a feature flag.
 *
 *   ALERT_EVALUATOR_ENABLED   default 'true'
 *
 * v1 single-process: no leader lock, no cross-replica HA. The evaluator
 * is fine to run in one api-gateway instance until horizontal-scale
 * lands (tracked as a follow-up in the design doc).
 *
 * Wiring the AutoInvestigationDispatcher to this evaluator is a
 * separate follow-up — that needs an orchestrator factory extracted
 * from chat-service.
 */

import { createLogger } from '@agentic-obs/common/logging';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import type { BackgroundRunnerDeps } from '@agentic-obs/agent-core';
import {
  AlertEvaluatorService,
  type MetricQueryFn,
} from '../services/alert-evaluator-service.js';
import {
  AutoInvestigationConsumer,
  buildSaIdentityResolverFromRepos,
  type SaIdentityResolver,
  type ConsumerInvestigationStore,
} from '../services/auto-investigation-consumer.js';
import { LeaderLock } from '../services/leader-lock.js';
import {
  resolvePrometheusDatasource,
  type PrometheusDatasource,
} from '../services/dashboard-service.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import type {
  IApiKeyRepository,
  IEventBus,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';

const log = createLogger('alerts-boot');

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Build a `MetricQueryFn` that resolves a rule's PromQL against the
 * configured default Prometheus-compatible datasource and returns the
 * latest scalar value.
 *
 * `null` return = "no sample". The evaluator treats null as "leave
 * state alone", which matches alertmanager semantics: stale =
 * inconclusive.
 *
 * Datasource resolution is **per-call** so an operator can swap
 * datasources at runtime without restarting the api-gateway. The
 * downside is a small overhead per tick; the upside is consistency
 * with the rest of the system (which does the same).
 *
 * Multi-series queries are folded to the first sample. Production
 * alert rules are expected to aggregate to a scalar (e.g. `sum(...) by ()`).
 */
export function buildMetricQueryFn(setupConfig: SetupConfigService): MetricQueryFn {
  return async (rule) => {
    const datasources = await setupConfig.listDatasources({ orgId: rule.workspaceId ?? 'org_main' });
    const prom: PrometheusDatasource | undefined = resolvePrometheusDatasource(datasources);
    if (!prom) {
      log.debug({ ruleId: rule.id }, 'no Prometheus datasource configured; skipping evaluation');
      return null;
    }
    const adapter = new PrometheusMetricsAdapter(prom.url, prom.headers);
    try {
      const samples = await adapter.instantQuery(rule.condition.query);
      const first = samples[0];
      if (!first) return null;
      const v = Number(first.value);
      return Number.isFinite(v) ? v : null;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), ruleId: rule.id },
        'metric query failed; treating as no-sample',
      );
      return null;
    }
  };
}

export interface MountAlertsDeps {
  rules: IAlertRuleRepository;
  setupConfig: SetupConfigService;
  /**
   * BackgroundRunnerDeps — when provided AND `AUTO_INVESTIGATION_ENABLED`
   * is not 'false', the AutoInvestigationDispatcher is started +
   * subscribed to the evaluator's `alert.fired` emitter. The dispatcher
   * resolves a fresh SA identity per event, so a token minted in the UI
   * after boot is picked up without restarting.
   */
  runner?: BackgroundRunnerDeps;
  /**
   * Auth repositories used by the dispatcher to resolve the `openobs` SA
   * identity per `alert.fired` event. Without these the dispatcher
   * cannot run; if absent the dispatcher is skipped.
   */
  authRepos?: {
    users: IUserRepository;
    orgUsers: IOrgUserRepository;
    apiKeys: IApiKeyRepository;
  };
  /**
   * Override resolver for the SA identity. Used by tests; production
   * callers leave this unset and let alerts-boot build the default
   * resolver from `authRepos`.
   */
  resolveSaIdentity?: SaIdentityResolver;
  /**
   * Optional registrar for rule-store change events. Called once at boot
   * with a callback that the underlying store should invoke on every
   * create/update/delete. Wired via the {@link
   * import('@agentic-obs/data-layer').EventEmittingAlertRuleRepository}
   * wrapper. The evaluator coalesces bursts through a debounce.
   */
  subscribeRuleChanges?: (cb: () => void) => void;
  /**
   * Investigation repository. When provided, AutoInvestigationConsumer
   * uses it for the persistent dedup check (look up the rule's prior
   * investigation by id) and to finalize the row created by the agent's
   * `investigation_create` tool. Narrow shape kept inline so we accept
   * any superset (sqlite / postgres / gateway-ext).
   */
  investigations?: ConsumerInvestigationStore;
  /**
   * Event bus the consumer subscribes to for `alert.fired`. Optional
   * for now — without it, the auto-investigation consumer is skipped
   * entirely. T4 wires this in server.ts; until then existing callers
   * keep working with auto-investigation off.
   */
  eventBus?: IEventBus;
  /**
   * QueryClient used to back the leader lock. When provided AND
   * `ALERT_EVALUATOR_HA=true`, the evaluator only runs while it holds
   * the lock. Multi-replica deploys should pass this so two api-gateway
   * pods don't both fire alerts.
   */
  db?: import('@agentic-obs/data-layer').QueryClient;
}

/**
 * Start the evaluator (if enabled). Returns a `{ evaluator, stop }`
 * handle so a graceful-shutdown caller can clean up timers, AND so the
 * follow-up that wires AutoInvestigationDispatcher can subscribe to
 * the evaluator's `alert.fired` events without re-instantiating it.
 */
export async function startAlerts(deps: MountAlertsDeps): Promise<{
  evaluator: AlertEvaluatorService | null;
  consumer: AutoInvestigationConsumer | null;
  stop: () => void;
}> {
  if (!envFlag('ALERT_EVALUATOR_ENABLED', true)) {
    log.info('alert evaluator disabled by ALERT_EVALUATOR_ENABLED=false');
    return { evaluator: null, consumer: null, stop: () => undefined };
  }

  let leaderLock: LeaderLock | undefined;
  if (envFlag('ALERT_EVALUATOR_HA', false) && deps.db) {
    const ttlMs = Number(process.env['ALERT_EVALUATOR_LEADER_TTL_MS']) || 30_000;
    leaderLock = new LeaderLock({
      db: deps.db,
      key: 'alert_evaluator.leader',
      ttlMs,
    });
    log.info({ ttlMs }, 'alert evaluator HA mode: leader lock enabled');
  } else if (envFlag('ALERT_EVALUATOR_HA', false) && !deps.db) {
    log.warn(
      'ALERT_EVALUATOR_HA=true but no db handle wired into startAlerts; running without leader lock. ' +
      'Multi-replica deploys will double-fire alerts in this state.',
    );
  }

  // Construct the evaluator BEFORE wiring listeners. `start()` is held off
  // until the dispatcher (if any) has subscribed — see the listener-
  // before-emitter discipline below.
  const evaluator = new AlertEvaluatorService({
    rules: deps.rules,
    query: buildMetricQueryFn(deps.setupConfig),
    ...(leaderLock ? { leaderLock } : {}),
    ...(deps.eventBus ? { eventBus: deps.eventBus } : {}),
  });

  // Wire the AutoInvestigationConsumer (P8) to the bus's `alert.fired`
  // topic BEFORE starting the evaluator, preserving the listener-before-
  // emitter discipline: even if T4's evaluator publishes synchronously
  // on its first tick, the consumer is already subscribed.
  // Gates:
  //   - AUTO_INVESTIGATION_ENABLED (default true)
  //   - deps.runner provided by server.ts
  //   - deps.eventBus provided by server.ts (T4)
  //   - deps.investigations provided (needed for dedup + finalize)
  //   - either deps.authRepos (production) or deps.resolveSaIdentity
  //     (tests) so we can resolve an SA identity per event.
  // The legacy AUTO_INVESTIGATION_SA_TOKEN env var is honoured as an
  // advanced override — when set, every run uses that plaintext token
  // through the existing validateAndLookup path. Operators on the new
  // path do not need to set it; the consumer reads the live api_key
  // table on each fire.
  let consumer: AutoInvestigationConsumer | null = null;
  const consumerOn = envFlag('AUTO_INVESTIGATION_ENABLED', true);
  const envOverrideToken = process.env['AUTO_INVESTIGATION_SA_TOKEN'];
  if (!consumerOn) {
    log.info('auto-investigation consumer disabled by AUTO_INVESTIGATION_ENABLED=false');
  } else if (!deps.runner) {
    log.warn('background-runner deps not provided — auto-investigation consumer NOT started');
  } else if (!deps.eventBus) {
    log.warn('event bus not wired — auto-investigation consumer NOT started');
  } else if (!deps.investigations) {
    log.warn('investigations repo not wired — auto-investigation consumer NOT started');
  } else {
    let resolveSaIdentity: SaIdentityResolver | undefined = deps.resolveSaIdentity;
    if (!resolveSaIdentity && envOverrideToken && deps.runner) {
      // Override path: validate the env token through ApiKeyService each
      // fire so a revoked token starts to skip without a restart.
      const runner = deps.runner;
      resolveSaIdentity = async () => {
        const lookup = await runner.saTokens.validateAndLookup(envOverrideToken);
        if (!lookup) return null;
        return {
          userId: lookup.user.id,
          orgId: lookup.orgId,
          orgRole: lookup.role,
          isServerAdmin: lookup.isServerAdmin,
          authenticatedBy: 'api_key',
          serviceAccountId: lookup.serviceAccountId ?? undefined,
        };
      };
    }
    if (!resolveSaIdentity && deps.authRepos) {
      resolveSaIdentity = buildSaIdentityResolverFromRepos(deps.authRepos);
    }
    if (!resolveSaIdentity) {
      log.warn(
        'auth repos not provided to startAlerts — auto-investigation consumer NOT started. ' +
        'Pass `authRepos` so the consumer can resolve the openobs SA identity per event.',
      );
    } else {
      consumer = new AutoInvestigationConsumer({
        bus: deps.eventBus,
        runner: deps.runner,
        resolveSaIdentity,
        alertRules: deps.rules,
        investigations: deps.investigations,
      });
      consumer.start();
      log.info('auto-investigation consumer subscribed to alert.fired on bus');
    }
  }

  // Hot-reload: when the rule store reports a change, ask the evaluator
  // to refresh its schedule. The evaluator debounces, so a bulk import
  // collapses to one rebuild.
  if (deps.subscribeRuleChanges) {
    deps.subscribeRuleChanges(() => {
      evaluator.notifyRuleChanged();
    });
  }

  // Listener wiring is done — now safe to start the evaluator.
  await evaluator.start();
  log.info('alert evaluator started');

  return {
    evaluator,
    consumer,
    stop: () => {
      consumer?.stop();
      evaluator.stop();
    },
  };
}
