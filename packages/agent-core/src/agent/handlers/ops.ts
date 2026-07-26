import type { ActionContext } from './_context.js';
import { withToolEventBoundary, sourceUnavailable } from './_shared.js';

export async function handleOpsRunCommand(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const intent = typeof args.intent === 'string' && args.intent.trim()
    ? args.intent.trim()
    : 'read';

  return withToolEventBoundary(
    ctx.sendEvent,
    'ops_run_command',
    { connectorId, command, intent },
    connectorId ? `Running ops command on ${connectorId}` : 'Running ops command',
    async () => {
      if (!ctx.opsCommandRunner) {
        const msg = 'Ops command runner is not configured. Connect a Kubernetes/Ops integration before querying cluster state.';
        return { observation: sourceUnavailable(msg), summary: msg };
      }
      if (!connectorId) {
        return 'ops_run_command requires connectorId. List configured Ops connectors in Settings and choose one before running a command.';
      }
      if (!command) {
        return 'ops_run_command requires a command.';
      }

      const connectors = ctx.opsConnectors ?? await ctx.opsCommandRunner.listConnectors?.();
      const connectorList = Array.isArray(connectors) ? connectors : undefined;
      if (connectorList) {
        if (connectorList.length === 0) {
          // Unified-connectors model: 0 kubernetes connectors means the
          // user hasn't created one yet. Point them at Settings → Connectors
          // → Add Connector → kubernetes. Do NOT suggest "Mark as Ops"
          // toggles — those don't exist.
          const msg = "No Kubernetes connector configured. Go to Settings → Connectors → Add Connector and pick 'kubernetes'.";
          return { observation: sourceUnavailable(msg), summary: msg };
        }
        const selected = connectorList.find((connector) => connector.id === connectorId);
        if (!selected) {
          const msg = `Kubernetes connector "${connectorId}" is not configured. Choose one of: ${connectorList.map((connector) => connector.id).join(', ')}.`;
          return { observation: sourceUnavailable(msg), summary: msg };
        }

        // Connector exists; credential-missing case (kubeconfig) is detected
        // by the runner per-call and surfaced as the observation. Command
        // safety policy is enforced by the runner/adapter, not here.
      }

      const result = await ctx.opsCommandRunner.runCommand({
        connectorId,
        command,
        intent,
        identity: ctx.identity,
        sessionId: ctx.sessionId,
        onConfirmationRequired: (confirmation: unknown) => {
          emitOpsConfirmation(ctx, confirmation, connectorId, command, 'medium');
        },
        onResolved: (resolution) => emitOpsResolution(ctx, resolution),
      });

      return formatOpsCommandResult(result);
    },
  );
}

export async function handleOpsClusterShell(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const connectorId = typeof args.connectorId === 'string' ? args.connectorId.trim() : '';
  const script = typeof args.script === 'string' ? args.script.trim() : '';
  const scope = args.scope === 'cluster' || args.scope === 'namespace'
    ? args.scope
    : 'namespace';
  const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
  const image = typeof args.image === 'string' ? args.image.trim() : '';

  return withToolEventBoundary(
    ctx.sendEvent,
    'ops_cluster_shell',
    { connectorId, scope, namespace: namespace || undefined, image: image || undefined },
    connectorId ? `Preparing cluster shell command on ${connectorId}` : 'Preparing cluster shell command',
    async () => {
      if (!ctx.opsCommandRunner?.runClusterShell) {
        const msg = 'Cluster shell runner is not configured. Connect a Kubernetes/Ops integration before running cluster shell operations.';
        return { observation: sourceUnavailable(msg), summary: msg };
      }
      if (!connectorId) {
        return 'ops_cluster_shell requires connectorId. List configured Ops connectors in Settings and choose one before running a command.';
      }
      if (!script) {
        return 'ops_cluster_shell requires script.';
      }
      if (scope === 'namespace' && !namespace) {
        return 'ops_cluster_shell requires namespace when scope="namespace".';
      }

      const connectors = ctx.opsConnectors ?? await ctx.opsCommandRunner.listConnectors?.();
      const connectorList = Array.isArray(connectors) ? connectors : undefined;
      if (connectorList) {
        if (connectorList.length === 0) {
          const msg = "No Kubernetes connector configured. Go to Settings → Connectors → Add Connector and pick 'kubernetes'.";
          return { observation: sourceUnavailable(msg), summary: msg };
        }
        const selected = connectorList.find((connector) => connector.id === connectorId);
        if (!selected) {
          const msg = `Kubernetes connector "${connectorId}" is not configured. Choose one of: ${connectorList.map((connector) => connector.id).join(', ')}.`;
          return { observation: sourceUnavailable(msg), summary: msg };
        }
      }

      const result = await ctx.opsCommandRunner.runClusterShell({
        connectorId,
        script,
        scope,
        ...(namespace ? { namespace } : {}),
        ...(image ? { image } : {}),
        identity: ctx.identity,
        sessionId: ctx.sessionId,
        onConfirmationRequired: (confirmation: unknown) => {
          emitOpsConfirmation(ctx, confirmation, connectorId, script, 'high');
        },
        onResolved: (resolution) => emitOpsResolution(ctx, resolution),
      });

      return formatOpsCommandResult(result);
    },
  );
}

// Emitted once a shown confirmation settles. Persisted (not in the chat
// service's skip set) and broadcast to the session, so the card flips to its
// resolved state — showing the executed command + output — in every open view
// and after a reload, instead of stalling on the pending/expired state.
function emitOpsResolution(
  ctx: ActionContext,
  resolution: { id: string; status: 'executed' | 'rejected' | 'expired' | 'failed'; output?: string },
): void {
  if (!resolution.id) return;
  ctx.sendEvent({
    type: 'ops_command_confirmation_resolved',
    id: resolution.id,
    status: resolution.status,
    ...(resolution.output != null ? { output: resolution.output } : {}),
  });
}

function emitOpsConfirmation(
  ctx: ActionContext,
  confirmation: unknown,
  connectorId: string,
  command: string,
  defaultRisk: 'low' | 'medium' | 'high' | 'critical',
): void {
  if (!confirmation || typeof confirmation !== 'object') return;
  const record = confirmation as Record<string, unknown>;
  ctx.sendEvent({
    type: 'ops_command_confirmation_required',
    id: String(record.id ?? ''),
    connectorId: String(record.connectorId ?? connectorId),
    command: String(record.command ?? command),
    risk: (
      record.risk === 'low' ||
      record.risk === 'medium' ||
      record.risk === 'high' ||
      record.risk === 'critical'
    ) ? record.risk : defaultRisk,
    summary: String(record.summary ?? `Run ${command}`),
    expiresAt: String(record.expiresAt ?? new Date().toISOString()),
  });
}

function formatOpsCommandResult(result: unknown): { observation: string; success?: boolean } {
  if (typeof result === 'string') return { observation: result };
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const observation =
      typeof record.observation === 'string' ? record.observation :
      typeof record.summary === 'string' ? record.summary :
      typeof record.message === 'string' ? record.message :
      JSON.stringify(record);
    return { observation };
  }
  return { observation: String(result ?? 'Ops command completed with no output.') };
}
