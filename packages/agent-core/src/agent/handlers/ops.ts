import { checkKubectl, parseKubectlCommandString } from '@agentic-obs/adapters';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

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
    'ops.run_command',
    { connectorId, command, intent },
    connectorId ? `Running ops command on ${connectorId}` : 'Running ops command',
    async () => {
      if (!ctx.opsCommandRunner) {
        return 'Ops command runner is not configured. Connect a Kubernetes/Ops integration before querying cluster state.';
      }
      if (!connectorId) {
        return 'ops.run_command requires connectorId. List configured Ops connectors in Settings and choose one before running a command.';
      }
      if (!command) {
        return 'ops.run_command requires a command.';
      }

      const connectors = ctx.opsConnectors ?? await ctx.opsCommandRunner.listConnectors?.();
      const connectorList = Array.isArray(connectors) ? connectors : undefined;
      if (connectorList) {
        if (connectorList.length === 0) {
          return 'No Ops connectors are configured. Connect a Kubernetes/Ops integration before querying cluster state.';
        }
        const selected = connectorList.find((connector) => connector.id === connectorId);
        if (!selected) {
          return `Ops connector "${connectorId}" is not configured. Choose one of: ${connectorList.map((connector) => connector.id).join(', ')}.`;
        }

        // Defense-in-depth gate (P2 / T2.3 + T2.5):
        //
        // When the agent declares intent="read", the command argv MUST also
        // be on the P6 read-allowlist. Without this gate, a model could
        // smuggle a write through with intent="read" and the runner is the
        // only line of defense — we want a second one at the handler so the
        // shape of the command can't lie about its effect.
        //
        // Best-effort: a parse failure falls through and the runner takes
        // over. A successful parse that fails the allowlist is rejected.
        if (intent === 'read') {
          const argv = parseKubectlCommandString(command);
          if (argv.length > 0) {
            const decision = checkKubectl(argv, 'read', selected.namespaces ?? []);
            if (!decision.allow) {
              return `ops.run_command rejected: ${decision.reason}. Use intent="propose" for writes, and only on a connector configured for the target namespace.`;
            }
          }
        }
      }

      const result = await ctx.opsCommandRunner.runCommand({
        connectorId,
        command,
        intent,
        identity: ctx.identity,
        sessionId: ctx.sessionId,
      });

      return formatOpsCommandResult(result);
    },
  );
}

function formatOpsCommandResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.observation === 'string') return record.observation;
    if (typeof record.summary === 'string') return record.summary;
    if (typeof record.message === 'string') return record.message;
    return JSON.stringify(record);
  }
  return String(result ?? 'Ops command completed with no output.');
}
