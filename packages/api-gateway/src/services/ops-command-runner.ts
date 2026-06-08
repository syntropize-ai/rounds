/**
 * KubectlOpsCommandRunner — agent-facing `OpsCommandRunner` impl for the
 * `ops_run_command` and `ops_cluster_shell` chat tools.
 *
 * Architecture:
 *   - The single source of truth for ops integrations is the `connectors`
 *     table; rows with `type='kubernetes'` are the ops connectors. There is
 *     no separate `ops_connectors` table or "Mark as Ops integration"
 *     toggle.
 *   - Per call, this runner resolves the connector + secret fresh from the
 *     repo so rotated kubeconfigs take effect without restart, and so
 *     newly-added connectors are immediately usable without rebuilding the
 *     chat session.
 *   - `ops_run_command` runs via `ShellExecutionAdapter` (real `sh -c` with
 *     KUBECONFIG injected) so the model gets pipes, `&&`, `$(...)`, quoting,
 *     and `--tail=N` for free. Confirmation is pattern-gated by
 *     `classifyShellCommandRisk` on the full command string.
 *   - `ops_cluster_shell` runs via `ClusterShellExecutionAdapter` (one-shot
 *     Job inside the cluster) for scripts that need tools missing from the
 *     api-gateway host (istioctl, helm, operator installers).
 */

import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '@agentic-obs/server-utils/logging';
import { ClusterShellExecutionAdapter, ShellExecutionAdapter } from '@agentic-obs/adapters';
import type {
  OpsCommandIntent,
  OpsCommandRunner,
  OpsConnectorConfig,
} from '@agentic-obs/agent-core';
import type {
  Identity,
  Connector,
  ConnectorHumanPolicy,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import {
  DefaultOpsSecretRefResolver,
  type OpsSecretRefResolver,
} from './ops-secret-ref-resolver.js';
import {
  capabilityForShellCommand,
  resolveConnectorPolicy,
  templateDefaultPolicy,
} from './ops-policy.js';
import type { AuditWriter } from '../auth/audit-writer.js';

const log = createLogger('ops-command-runner');

export interface KubectlOpsCommandRunnerDeps {
  connectors: IConnectorRepository;
  /** Caller's org — scopes every connector lookup. */
  orgId: string;
  /** Override for tests; defaults to env/file/vault-backed resolver. */
  secretResolver?: OpsSecretRefResolver;
  /**
   * Resolve the calling user's team ids. The runner picks the most permissive
   * team-specific policy if any team id matches a policy row; otherwise it
   * falls back to the wildcard (`teamId: ''`) policy and finally to deny.
   * Optional — when omitted, only wildcard policies match.
   */
  resolveUserTeams?: (identity: Identity) => Promise<readonly string[]>;
  /**
   * Auto-approve read-shaped commands. Set by background investigation runs
   * (no human at the keyboard to click a confirmation card) AND by interactive
   * chat (a prompt on every read is pure friction). When true, this runner
   * bypasses the confirmation gate for read-shaped commands (per
   * `isAgentReadSafeCommand`) — covering
   * non-kubectl probes (`curl`, `jq`) and `kubectl exec ... -- <read-cmd>`
   * which the policy classifier flags as `runtime.exec`/'ask' by default.
   *
   * The bypass NEVER applies to (a) commands classified as `critical` risk
   * (`kubectl delete/drain`, `rm`, `mkfs`, …), (b) explicit kubectl write
   * verbs (`apply`/`create`/`patch`/…), or (c) commands where an operator
   * has set an EXPLICIT (team/org) policy row — operator config always wins.
   *
   * Agent honesty about the command being read-only is enforced by the
   * orchestrator prompt; the runner only checks the surface shape.
   */
  readOnlyAgentBypass?: boolean;
  /**
   * Optional audit sink. When provided, every executed command (success or
   * failure) emits one `ops.command.run` row. Attribution rules:
   *   - confirmed by a human → actor = the approver (the human "owns" the
   *     execution per the "who approved = who executed" principle); the
   *     proposing agent's id lives in metadata.agentUserId.
   *   - bypassed (`readOnlyAgentBypass` opened the gate) → actor = the
   *     agent SA; metadata.bypassed = true so SIEM can filter.
   *   - no policy/risk gate hit at all (e.g. `kubectl get` from interactive
   *     chat) → actor = the calling identity directly.
   *
   * Omit in tests that don't care about audit.
   */
  audit?: AuditWriter;
}

export interface OpsCommandConfirmation {
  id: string;
  kind: 'kubectl' | 'cluster_shell';
  orgId: string;
  /** The agent identity that proposed the command. Audit attribution falls
   *  back to this when no human approver is recorded (e.g. read-only bypass). */
  userId: string;
  sessionId: string;
  connectorId: string;
  capability?: string;
  command: string;
  script?: string;
  scope?: 'cluster' | 'namespace';
  namespace?: string;
  image?: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  expiresAt: string;
  status: 'pending' | 'executed' | 'rejected' | 'expired' | 'failed';
  /** The human who clicked approve/reject. Set by `/execute` and `/reject`.
   *  Absent when status flips to `expired` or when bypassed. The audit row
   *  attributes execution to this user — "who approved = who executed". */
  approvedByUserId?: string;
  /** ISO timestamp of the approve/reject click. Paired with approvedByUserId. */
  approvedAt?: string;
}

export interface OpsRunResult {
  observation: string;
  success?: boolean;
  confirmationRequired?: boolean;
  confirmation?: OpsCommandConfirmation;
}

/**
 * Env var name that gates the kubeconfig `user.exec` credential plugin path.
 * Mirrors `EXEC_ENABLED_ENV` in kubeconfig-exec.ts — duplicated here to keep
 * this gate-check independent of that module's import surface.
 */
const KUBECONFIG_EXEC_ENV = 'KUBECONFIG_EXEC_PLUGIN';

/**
 * Refuse to hand a kubeconfig with `user.exec` to kubectl unless the api-gateway
 * operator has explicitly opted into the exec plugin. We don't strip the field —
 * mutating user credentials silently could break their intent and would hide
 * the misconfiguration. Reject loudly so the operator sees it.
 */
function assertNoUnauthorizedExec(kubeconfigYaml: string): void {
  if (process.env[KUBECONFIG_EXEC_ENV] === '1') return;
  let cfg: unknown;
  try {
    cfg = parseYaml(kubeconfigYaml);
  } catch {
    return; // Malformed YAML — let kubectl produce the user-facing error.
  }
  if (!cfg || typeof cfg !== 'object') return;
  const users = (cfg as { users?: unknown }).users;
  if (!Array.isArray(users)) return;
  for (const entry of users) {
    if (entry && typeof entry === 'object') {
      const user = (entry as { user?: unknown }).user;
      if (user && typeof user === 'object' && 'exec' in user && (user as { exec?: unknown }).exec) {
        throw new Error(
          'Kubeconfig with user.exec auth requires KUBECONFIG_EXEC_PLUGIN=1 on the api-gateway.',
        );
      }
    }
  }
}

const PENDING_CONFIRMATIONS = new Map<string, OpsCommandConfirmation>();
const CONFIRMATION_WAITERS = new Map<string, (status: OpsCommandConfirmation['status']) => void>();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

function clusterShellRisk(scope: 'cluster' | 'namespace'): OpsCommandConfirmation['risk'] {
  return scope === 'cluster' ? 'critical' : 'high';
}

/**
 * Pattern-based risk classifier for the shell-execution path. Operates on
 * the full opaque command string (which may contain pipes, `&&`, `$(...)`,
 * heredocs, etc.) and asks: does anything in here look like a mutation?
 *
 * Heuristic only — the kubeconfig's RBAC is still the real authority. The
 * point here is solely to decide whether to surface a confirmation card
 * before running. False positives (confirm prompts on a read) are
 * acceptable; false negatives (silently running a write) are not.
 *
 * Returns the highest matched risk level, or 'low' if nothing matches.
 */
const KUBECTL_CRITICAL_RE = /\bkubectl\s+(?:[^\n|;&]*\s)?(delete|drain)\b/;
const KUBECTL_HIGH_RE =
  /\bkubectl\s+(?:[^\n|;&]*\s)?(apply|create|patch|edit|replace|scale|cordon|uncordon|rollout|exec|cp|annotate|label|taint|set)\b/;
const KUBECTL_READ_RE =
  /\bkubectl\s+(?:[^\n|;&]*\s)?(get|list|describe|logs|events|top|version|api-resources|api-versions|cluster-info|explain|auth|config)\b/;
const SHELL_DESTRUCTIVE_RE = /(?:^|[\s|;&])(?:rm\b|mv\b|dd\b|mkfs\b|>\s*\/)/;

export function classifyShellCommandRisk(command: string): OpsCommandConfirmation['risk'] {
  if (KUBECTL_CRITICAL_RE.test(command) || SHELL_DESTRUCTIVE_RE.test(command)) return 'critical';
  if (KUBECTL_HIGH_RE.test(command)) return 'high';
  // If it mentions kubectl at all but doesn't match a known read verb, treat
  // as medium so an unfamiliar kubectl subcommand still prompts.
  if (/\bkubectl\b/.test(command) && !KUBECTL_READ_RE.test(command)) return 'medium';
  return 'low';
}

/**
 * Decide whether the runner should surface a Yes/No confirmation card
 * before executing. Read-shaped commands (kubectl get/describe/logs/…)
 * skip confirmation; anything mutating or unrecognized prompts.
 *
 * Works on the full shell command string — pipes/chains supported.
 */
export function shellCommandNeedsConfirmation(command: string): boolean {
  return classifyShellCommandRisk(command) !== 'low';
}

/**
 * Kubectl write verbs that are unambiguous mutations and must always
 * confirm even when the caller is a background investigation agent.
 *
 * `exec` is intentionally excluded: agents legitimately use
 * `kubectl exec ... -- ps/cat/netstat/curl localhost:15000/...` to probe
 * sidecar internals. The inner command's read-only-ness is the prompt's
 * contract, not the runner's regex job. `cp` is also excluded for the
 * same reason (file extraction from a pod is read-shaped); a `cp` that
 * pushes a file in is still detectable through the destination form
 * only with deeper parsing — that's a follow-up.
 */
const KUBECTL_UNAMBIGUOUS_WRITE_RE =
  /\bkubectl\s+(?:[^\n|;&]*\s)?(apply|create|patch|edit|replace|scale|cordon|uncordon|rollout|annotate|label|taint|set)\b/;

/**
 * Surface-level safety classifier for the background-investigation bypass.
 *
 * Returns true when the command shape is plausibly read-only: no critical
 * verbs (`delete`/`drain`/`rm`/`mkfs`/…), no unambiguous kubectl writes
 * (`apply`/`create`/`patch`/…). `kubectl exec` and pure non-kubectl shell
 * commands (curl/jq/grep) pass — the agent is contractually limited to
 * read-only inner commands by the orchestrator prompt.
 *
 * This is a SURFACE check only. A `kubectl exec -- sh -c 'rm -rf /'`
 * passes because the inner script isn't parsed. The trust model:
 * background agent prompt forbids writes; runner enforces the obvious
 * cases; audit log captures everything for post-hoc review.
 */
export function isAgentReadSafeCommand(command: string): boolean {
  if (classifyShellCommandRisk(command) === 'critical') return false;
  if (KUBECTL_UNAMBIGUOUS_WRITE_RE.test(command)) return false;
  return true;
}

function createConfirmation(params: {
  orgId: string;
  userId: string;
  sessionId: string;
  connectorId: string;
  command: string;
}): OpsCommandConfirmation {
  const capability = capabilityForShellCommand(params.command);
  const confirmation: OpsCommandConfirmation = {
    id: randomUUID(),
    kind: 'kubectl',
    orgId: params.orgId,
    userId: params.userId,
    sessionId: params.sessionId,
    connectorId: params.connectorId,
    capability,
    command: params.command,
    risk: classifyShellCommandRisk(params.command),
    summary: `Run ${params.command}`,
    expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    status: 'pending',
  };
  PENDING_CONFIRMATIONS.set(confirmation.id, confirmation);
  return confirmation;
}

function createClusterShellConfirmation(params: {
  orgId: string;
  userId: string;
  sessionId: string;
  connectorId: string;
  script: string;
  scope: 'cluster' | 'namespace';
  namespace?: string;
  image?: string;
}): OpsCommandConfirmation {
  const target = params.scope === 'namespace' ? `namespace ${params.namespace}` : 'cluster';
  const confirmation: OpsCommandConfirmation = {
    id: randomUUID(),
    kind: 'cluster_shell',
    orgId: params.orgId,
    userId: params.userId,
    sessionId: params.sessionId,
    connectorId: params.connectorId,
    command: `cluster shell (${target}): ${params.script}`,
    script: params.script,
    scope: params.scope,
    ...(params.namespace ? { namespace: params.namespace } : {}),
    ...(params.image ? { image: params.image } : {}),
    risk: clusterShellRisk(params.scope),
    summary: `Run cluster shell script on ${target}`,
    expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
    status: 'pending',
  };
  PENDING_CONFIRMATIONS.set(confirmation.id, confirmation);
  return confirmation;
}

export function getOpsCommandConfirmation(id: string): OpsCommandConfirmation | undefined {
  const confirmation = PENDING_CONFIRMATIONS.get(id);
  if (!confirmation) return undefined;
  if (confirmation.status === 'pending' && Date.parse(confirmation.expiresAt) <= Date.now()) {
    confirmation.status = 'expired';
  }
  return confirmation;
}

export function resolveOpsCommandConfirmation(
  id: string,
  status: Extract<OpsCommandConfirmation['status'], 'executed' | 'rejected' | 'failed'>,
  approver?: { userId: string },
): OpsCommandConfirmation | undefined {
  const confirmation = getOpsCommandConfirmation(id);
  if (!confirmation || confirmation.status !== 'pending') return confirmation;
  confirmation.status = status;
  if (approver) {
    confirmation.approvedByUserId = approver.userId;
    confirmation.approvedAt = new Date().toISOString();
  }
  const waiter = CONFIRMATION_WAITERS.get(id);
  if (waiter) {
    CONFIRMATION_WAITERS.delete(id);
    waiter(status);
  }
  return confirmation;
}

async function waitForConfirmationDecision(
  confirmation: OpsCommandConfirmation,
): Promise<OpsCommandConfirmation['status']> {
  const current = getOpsCommandConfirmation(confirmation.id);
  if (!current || current.status !== 'pending') return current?.status ?? 'expired';
  const expiresInMs = Math.max(0, Date.parse(current.expiresAt) - Date.now());
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const latest = getOpsCommandConfirmation(confirmation.id);
      if (latest?.status === 'pending') latest.status = 'expired';
      CONFIRMATION_WAITERS.delete(confirmation.id);
      resolve('expired');
    }, expiresInMs);
    CONFIRMATION_WAITERS.set(confirmation.id, (status) => {
      clearTimeout(timeout);
      resolve(status);
    });
  });
}

export class KubectlOpsCommandRunner implements OpsCommandRunner {
  private readonly secretResolver: OpsSecretRefResolver;

  constructor(private readonly deps: KubectlOpsCommandRunnerDeps) {
    this.secretResolver = deps.secretResolver ?? new DefaultOpsSecretRefResolver();
  }

  async listConnectors(): Promise<OpsConnectorConfig[]> {
    const rows = await this.deps.connectors.list({ orgId: this.deps.orgId });
    return rows
      .filter((c) => c.type === 'kubernetes')
      .map(connectorToOpsConfig);
  }

  async runCommand(params: {
    connectorId: string;
    command: string;
    intent: OpsCommandIntent;
    identity: Identity;
    sessionId: string;
    confirmed?: boolean;
    onConfirmationRequired?: (confirmation: OpsCommandConfirmation) => void;
    onResolved?: (resolution: { id: string; status: 'executed' | 'rejected' | 'expired' | 'failed'; output?: string }) => void;
  }): Promise<OpsRunResult> {
    const connector = await this.deps.connectors.get(params.connectorId, {
      orgId: this.deps.orgId,
    });
    if (!connector) {
      return { observation: `Ops connector "${params.connectorId}" not found in org ${this.deps.orgId}.` };
    }
    if (connector.type !== 'kubernetes') {
      return {
        observation: `Connector "${connector.name}" is type "${connector.type}", not "kubernetes". ops_run_command only supports kubernetes connectors today.`,
      };
    }
    if (connector.secretMissing && !hasInlineKubeconfig(connector) && !isInClusterCandidate(connector)) {
      return {
        observation: `Kubernetes connector "${connector.name}" has no kubeconfig credentials. Paste credentials via Settings → Connectors → Policies, or run Rounds inside the cluster to use the mounted service account.`,
      };
    }

    const command = params.command.trim();
    if (!command) {
      return { observation: 'ops_run_command requires a non-empty command.' };
    }

    // Confirmation gating. The `intent` parameter is the model's
    // self-declared expectation; we cross-check against a pattern-based
    // risk classifier on the full command string so writes can't sneak
    // through declared as reads. `execute_approved` is reserved for the
    // confirmation route (which sets confirmed=true).
    if (params.intent === 'execute_approved' && !params.confirmed) {
      return {
        observation: 'ops_run_command execute_approved is reserved for the confirmation executor.',
      };
    }

    // Connector-policy gate (Settings → Connectors → Permissions). The
    // user-configured per-capability policy takes precedence over the
    // pattern-based risk classifier:
    //   - `block` → refuse here, never reach the adapter.
    //   - `ask`   → force confirmation regardless of how innocuous the
    //               command looks.
    //   - `allow` → still let the risk classifier confirm high-risk
    //               commands (defense in depth — a `delete` shouldn't
    //               sneak through just because someone allowed `runtime.get`).
    //   - no row  → fall back to the template's seed default, then to the
    //               risk classifier.
    const capability = capabilityForShellCommand(command);
    const teamIds = this.deps.resolveUserTeams
      ? await this.deps.resolveUserTeams(params.identity)
      : [];
    const explicit = await resolveConnectorPolicy({
      connectorRepo: this.deps.connectors,
      connectorId: connector.id,
      capability,
      orgId: this.deps.orgId,
      userTeamIds: teamIds,
    });
    const policy: ConnectorHumanPolicy | 'no-policy' =
      explicit === 'no-policy'
        ? (templateDefaultPolicy(connector.type, capability) ?? 'no-policy')
        : explicit;

    if (policy === 'block') {
      return {
        observation:
          `Blocked by connector policy: capability "${capability}" on "${connector.name}" is set to block. ` +
          `Adjust via Settings → Connectors → ${connector.name} → Permissions.`,
        success: false,
      };
    }

    const policyWantsConfirm = policy === 'ask';
    const riskWantsConfirm = shellCommandNeedsConfirmation(command);
    let needsConfirmation =
      !params.confirmed && (policyWantsConfirm || riskWantsConfirm);

    // Read-only auto-approve: a confirmation card on a read-shaped command is
    // pure friction (background runs have no human to click it; interactive
    // chat reads don't warrant a prompt). Only applies when (a) caller opted
    // in, (b) command shape is read-safe, (c) operator has not set an explicit
    // policy (explicit ask/block always wins).
    if (
      needsConfirmation &&
      this.deps.readOnlyAgentBypass &&
      explicit === 'no-policy' &&
      isAgentReadSafeCommand(command)
    ) {
      needsConfirmation = false;
      log.info(
        {
          userId: params.identity.userId,
          capability,
          commandHead: command.slice(0, 120),
        },
        'read-only bypass: read-shaped command auto-approved',
      );
    }

    // Track who approved (if anyone) — feeds the audit attribution below.
    let approvedByUserId: string | undefined;
    const bypassed = !needsConfirmation && (policyWantsConfirm || riskWantsConfirm);

    // Set when a confirmation card was actually shown — gates the resolution
    // event so auto-approved/bypassed reads (no card) don't emit one.
    let shownConfirmationId: string | undefined;
    if (needsConfirmation) {
      const confirmation = createConfirmation({
        orgId: this.deps.orgId,
        userId: params.identity.userId,
        sessionId: params.sessionId,
        connectorId: params.connectorId,
        command,
      });
      shownConfirmationId = confirmation.id;
      params.onConfirmationRequired?.(confirmation);
      const decision = await waitForConfirmationDecision(confirmation);
      if (decision !== 'executed') {
        params.onResolved?.({ id: confirmation.id, status: decision === 'pending' ? 'failed' : decision });
        return { observation: `User did not approve "${command}" (${decision}).`, success: false };
      }
      // Re-read so we see fields the `/execute` endpoint stamped onto the
      // confirmation (approvedByUserId, approvedAt).
      const settled = getOpsCommandConfirmation(confirmation.id);
      approvedByUserId = settled?.approvedByUserId;
    }

    // Real shell semantics. The command runs as `sh -c <command>` with the
    // connector's kubeconfig exported as KUBECONFIG. Pipes, redirects, `&&`,
    // `$(...)`, quoting, heredocs all work as the model wrote them. There's
    // no argv-based gate here — confirmation already covered that — but
    // common tools (kubectl, jq, curl, grep, awk, sed) need to exist on the
    // api-gateway host's PATH.
    const adapter = new ShellExecutionAdapter({
      resolveKubeconfig: async () => this.resolveKubeconfig(connector),
    });

    const action = {
      type: 'shell:exec',
      targetService: connector.id,
      params: { command },
    } as const;

    // ShellExecutionAdapter has no success/failure distinction — it always
    // returns `success: true` with stdout (and exit/stderr/timeout
    // appended as a footer when relevant). The model reads the
    // observation and decides for itself; the runner is a passthrough.
    const result = await adapter.execute(action);
    const observation = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

    // If a confirmation card was shown, settle it with the command output so
    // the card persists as "executed" (and survives reload) instead of stalling
    // on the pending/expired state. Output capped for the card; the full blob
    // still flows through the agent's tool_result step.
    if (shownConfirmationId) {
      params.onResolved?.({ id: shownConfirmationId, status: 'executed', output: observation.slice(0, 4000) });
    }

    // Audit emission. "Who approved = who executed" — when a human approved,
    // they own the action; otherwise the agent SA does (with bypassed=true
    // for SIEM filtering when the gate was opened by the read-only bypass).
    if (this.deps.audit) {
      const actorId = approvedByUserId ?? params.identity.userId;
      const actorType: 'user' | 'service_account' =
        approvedByUserId ? 'user' : 'service_account';
      void this.deps.audit.log({
        action: 'ops.command.run',
        actorType,
        actorId,
        orgId: this.deps.orgId,
        targetType: 'connector',
        targetId: connector.id,
        targetName: connector.name,
        outcome: 'success',
        metadata: {
          command: command.slice(0, 2000),
          capability,
          agentUserId: params.identity.userId,
          ...(approvedByUserId ? { approvedByUserId } : {}),
          bypassed,
          sessionId: params.sessionId,
        },
      });
    }

    return { observation, success: true };
  }

  async runClusterShell(params: {
    connectorId: string;
    script: string;
    scope: 'cluster' | 'namespace';
    namespace?: string;
    image?: string;
    identity: Identity;
    sessionId: string;
    confirmed?: boolean;
    onConfirmationRequired?: (confirmation: OpsCommandConfirmation) => void;
    onResolved?: (resolution: { id: string; status: 'executed' | 'rejected' | 'expired' | 'failed'; output?: string }) => void;
  }): Promise<OpsRunResult> {
    const connector = await this.deps.connectors.get(params.connectorId, {
      orgId: this.deps.orgId,
    });
    if (!connector) {
      return { observation: `Ops connector "${params.connectorId}" not found in org ${this.deps.orgId}.` };
    }
    if (connector.type !== 'kubernetes') {
      return {
        observation: `Connector "${connector.name}" is type "${connector.type}", not "kubernetes". ops_cluster_shell only supports kubernetes connectors today.`,
      };
    }
    if (connector.secretMissing && !hasInlineKubeconfig(connector) && !isInClusterCandidate(connector)) {
      return {
        observation: `Kubernetes connector "${connector.name}" has no kubeconfig credentials. Paste credentials via Settings → Connectors → Policies, or run Rounds inside the cluster to use the mounted service account.`,
      };
    }
    if (!params.script.trim()) {
      return { observation: 'ops_cluster_shell requires a non-empty script.' };
    }
    if (params.scope === 'namespace' && !params.namespace?.trim()) {
      return { observation: 'ops_cluster_shell requires namespace when scope="namespace".' };
    }

    // Policy gate (same precedence as runCommand). Cluster shell always
    // confirms, so the `ask` branch is moot — but `block` must work.
    const capability = `runtime.cluster_shell.${params.scope}`;
    const teamIds = this.deps.resolveUserTeams
      ? await this.deps.resolveUserTeams(params.identity)
      : [];
    const explicit = await resolveConnectorPolicy({
      connectorRepo: this.deps.connectors,
      connectorId: connector.id,
      capability,
      orgId: this.deps.orgId,
      userTeamIds: teamIds,
    });
    const policy: ConnectorHumanPolicy | 'no-policy' =
      explicit === 'no-policy'
        ? (templateDefaultPolicy(connector.type, capability) ?? 'no-policy')
        : explicit;
    if (policy === 'block') {
      return {
        observation:
          `Blocked by connector policy: capability "${capability}" on "${connector.name}" is set to block. ` +
          `Adjust via Settings → Connectors → ${connector.name} → Permissions.`,
        success: false,
      };
    }

    // Set when a confirmation card was shown — gates the resolution event.
    let shownConfirmationId: string | undefined;
    if (!params.confirmed) {
      const confirmation = createClusterShellConfirmation({
        orgId: this.deps.orgId,
        userId: params.identity.userId,
        sessionId: params.sessionId,
        connectorId: params.connectorId,
        script: params.script,
        scope: params.scope,
        ...(params.namespace ? { namespace: params.namespace } : {}),
        ...(params.image ? { image: params.image } : {}),
      });
      params.onConfirmationRequired?.(confirmation);
      shownConfirmationId = confirmation.id;
      const decision = await waitForConfirmationDecision(confirmation);
      if (decision !== 'executed') {
        params.onResolved?.({ id: confirmation.id, status: decision === 'pending' ? 'failed' : decision });
        return { observation: `User did not approve cluster shell script on "${params.connectorId}" (${decision}).`, success: false };
      }
    }

    const adapter = new ClusterShellExecutionAdapter({
      resolveKubeconfig: async () => this.resolveKubeconfig(connector),
    });
    const result = await adapter.execute({
      type: 'ops.cluster_shell',
      targetService: connector.id,
      params: {
        script: params.script,
        scope: params.scope,
        ...(params.namespace ? { namespace: params.namespace } : {}),
        ...(params.image ? { image: params.image } : {}),
      },
    });
    if (!result.success) {
      log.info(
        { connectorId: connector.id, error: result.error },
        'ops_cluster_shell: cluster shell execution failed',
      );
      if (shownConfirmationId) {
        params.onResolved?.({ id: shownConfirmationId, status: 'failed', output: result.error ?? undefined });
      }
      return { observation: result.error ?? 'cluster shell execution failed with no error message.', success: false };
    }
    const observation = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (shownConfirmationId) {
      params.onResolved?.({ id: shownConfirmationId, status: 'executed', output: observation.slice(0, 4000) });
    }
    return { observation, success: true };
  }

  private async resolveKubeconfig(connector: Connector): Promise<string> {
    const yaml = await this.loadKubeconfigYaml(connector);
    // Gate-bypass defense: if the kubeconfig contains user.exec, the
    // operator must have explicitly enabled the plugin. We never run kubectl
    // with an exec-bearing kubeconfig unless the host env opts in.
    assertNoUnauthorizedExec(yaml);
    return yaml;
  }

  private async loadKubeconfigYaml(connector: Connector): Promise<string> {
    const inline = connector.config['kubeconfig'];
    if (typeof inline === 'string' && inline) return inline;
    const secretRef = connector.config['secretRef'];
    if (typeof secretRef === 'string' && secretRef) {
      return this.secretResolver.resolve(secretRef);
    }
    // Bind `this` explicitly — destructuring + invoking the free function
    // loses repo context and the better-sqlite3 backend trips on
    // `this.db is undefined`.
    const row = await this.deps.connectors.getSecret.call(
      this.deps.connectors,
      connector.id,
    );
    if (row?.ciphertext && row.ciphertext.length > 0) {
      return Buffer.from(row.ciphertext).toString('utf8');
    }
    throw new Error(
      `kubernetes connector "${connector.name}" has no kubeconfig credentials (no inline config.kubeconfig, no secretRef, no stored secret).`,
    );
  }
}

/** Build the `OpsConnectorConfig` derived view of a `connectors` row. */
export function connectorToOpsConfig(c: Connector): OpsConnectorConfig {
  const context = typeof c.config['context'] === 'string' ? c.config['context'] : undefined;
  const namespaces = readAllowedNamespaces(c);
  return {
    id: c.id,
    name: c.name,
    ...(context ? { environment: context } : {}),
    ...(namespaces.length > 0 ? { namespaces } : {}),
    capabilities: c.capabilities ?? [],
  };
}

function readAllowedNamespaces(c: Connector): string[] {
  const raw = c.config['allowedNamespaces'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function hasInlineKubeconfig(c: Connector): boolean {
  const inline = c.config['kubeconfig'];
  return typeof inline === 'string' && inline.length > 0;
}

function isInClusterCandidate(c: Connector): boolean {
  // When Rounds runs inside k8s with a mounted SA, the kubectl client picks
  // up KUBECONFIG-free credentials automatically. We treat a connector that
  // declares no apiServer (i.e. "use the in-cluster default") as a candidate
  // for that path. Best-effort — final answer comes from kubectl itself.
  const apiServer = c.config['apiServer'];
  return apiServer === undefined || apiServer === '' || apiServer === null;
}
