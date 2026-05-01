import type { Identity } from '@agentic-obs/common';
import {
  classifyKubectlCommand,
  KubectlExecutionAdapter,
  parseKubectlCommandString,
  type KubectlMode,
} from '@agentic-obs/adapters';
import type {
  IApprovalRequestRepository,
  IOpsConnectorRepository,
  OpsConnector,
} from '@agentic-obs/data-layer';
import { DefaultOpsSecretRefResolver, type OpsSecretRefResolver } from './ops-secret-ref-resolver.js';

export type OpsCommandDecision = 'read' | 'approval_required' | 'executed' | 'denied';

export interface OpsCommandRunnerServiceDeps {
  connectors: IOpsConnectorRepository;
  approvals: IApprovalRequestRepository;
  secretResolver?: OpsSecretRefResolver;
}

interface AgentOpsConnectorConfig {
  id: string;
  name: string;
  environment?: string;
  namespaces?: string[];
  capabilities?: string[];
}

export class OpsCommandRunnerService {
  private readonly secretResolver: OpsSecretRefResolver;

  constructor(private readonly deps: OpsCommandRunnerServiceDeps, private readonly orgId: string) {
    this.secretResolver = deps.secretResolver ?? new DefaultOpsSecretRefResolver();
  }

  async listConnectors(): Promise<AgentOpsConnectorConfig[]> {
    const connectors = await this.deps.connectors.listByOrg(this.orgId, { masked: true });
    return connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      environment: connector.environment ?? undefined,
      namespaces: connector.allowedNamespaces,
      capabilities: connector.capabilities,
    }));
  }

  async runCommand(params: {
    connectorId: string;
    command: string;
    intent: string;
    identity: Identity;
    sessionId: string;
  }): Promise<{ observation: string; decision: OpsCommandDecision; approvalId?: string }> {
    const connector = await this.deps.connectors.findByIdInOrg(this.orgId, params.connectorId);
    if (!connector) {
      return {
        decision: 'denied',
        observation: `Ops connector "${params.connectorId}" is not configured for this org.`,
      };
    }

    const policy = classifyOpsCommand(params.command, connector.allowedNamespaces);
    if (policy.decision === 'denied') {
      return {
        decision: 'denied',
        observation: `Denied by Ops command policy: ${policy.reason}.`,
      };
    }

    if (!connector.secret && !connector.secretRef) {
      return {
        decision: 'denied',
        observation: `Ops connector "${connector.id}" is not connected: no credential secret or secretRef is configured.`,
      };
    }

    if (policy.decision === 'approval_required' || params.intent === 'propose') {
      const approval = await this.deps.approvals.submit({
        action: {
          type: 'ops.run_command',
          targetService: connector.name,
          params: {
            connectorId: connector.id,
            command: params.command.trim(),
            intent: 'execute_approved',
            policyReason: policy.reason,
            sessionId: params.sessionId,
          },
        },
        context: {
          requestedBy: params.identity.userId,
          reason: `Run Kubernetes/Ops command on connector "${connector.name}": ${params.command.trim()}`,
        },
      });
      return {
        decision: 'approval_required',
        approvalId: approval.id,
        observation: `Command requires approval. Existing approvals workflow created request ${approval.id}. Do not execute until it is approved.`,
      };
    }

    if (params.intent === 'execute_approved') {
      return {
        decision: 'approval_required',
        observation:
          'Use the existing approval request execute endpoint to run approved Ops commands. Do not execute directly from chat.',
      };
    }

    return this.runKubectlCommand(connector, params.command, 'read');
  }

  async executeApprovedApproval(
    approvalId: string,
    identity: Identity,
  ): Promise<{ observation: string; decision: OpsCommandDecision; approvalId: string }> {
    const approval = await this.deps.approvals.findById(approvalId);
    if (!approval) {
      return {
        approvalId,
        decision: 'denied',
        observation: `Approval request "${approvalId}" was not found.`,
      };
    }
    if (approval.status !== 'approved') {
      return {
        approvalId,
        decision: 'denied',
        observation: `Approval request "${approvalId}" is ${approval.status}; only approved Ops command requests can execute.`,
      };
    }
    if (approval.action.type !== 'ops.run_command') {
      return {
        approvalId,
        decision: 'denied',
        observation: `Approval request "${approvalId}" is for "${approval.action.type}", not ops.run_command.`,
      };
    }

    const connectorId = typeof approval.action.params['connectorId'] === 'string'
      ? approval.action.params['connectorId']
      : '';
    const command = typeof approval.action.params['command'] === 'string'
      ? approval.action.params['command']
      : '';
    if (!connectorId || !command) {
      return {
        approvalId,
        decision: 'denied',
        observation: `Approval request "${approvalId}" is missing connectorId or command.`,
      };
    }

    const connector = await this.deps.connectors.findByIdInOrg(this.orgId, connectorId);
    if (!connector) {
      return {
        approvalId,
        decision: 'denied',
        observation: `Ops connector "${connectorId}" is not configured for this org.`,
      };
    }
    if (!connector.capabilities.includes('execute_approved')) {
      return {
        approvalId,
        decision: 'denied',
        observation: `Ops connector "${connector.name}" does not allow execute_approved commands.`,
      };
    }

    const policy = classifyOpsCommand(command, connector.allowedNamespaces);
    if (policy.decision === 'denied') {
      return {
        approvalId,
        decision: 'denied',
        observation: `Denied by Ops command policy: ${policy.reason}.`,
      };
    }

    const result = await this.runKubectlCommand(connector, command, 'write');
    return {
      approvalId,
      decision: result.decision === 'denied' ? 'denied' : 'executed',
      observation: `Approved by ${identity.userId}; ${result.observation}`,
    };
  }

  private async runKubectlCommand(
    connector: OpsConnector,
    command: string,
    mode: KubectlMode,
  ): Promise<{ observation: string; decision: OpsCommandDecision }> {
    const argv = parseKubectlCommandString(command);
    if (argv.length === 0) {
      return { decision: 'denied', observation: 'empty kubectl command' };
    }

    // The adapter owns the final policy check before spawn. The service only
    // chooses the semantic mode: read paths cannot execute write verbs; approved
    // execution paths can.
    const adapter = new KubectlExecutionAdapter({
      resolveKubeconfig: async () => {
        const k = await this.resolveKubeconfig(connector);
        if (!k.ok) throw new Error(k.error);
        return k.value;
      },
      allowedNamespaces: connector.allowedNamespaces,
      mode,
    });

    const validation = await adapter.validate({
      type: 'ops.run_command',
      targetService: connector.id,
      params: { argv },
    });
    if (!validation.valid) {
      return { decision: 'denied', observation: validation.reason ?? 'kubectl command rejected' };
    }

    let result;
    try {
      result = await adapter.execute({
        type: 'ops.run_command',
        targetService: connector.id,
        params: { argv },
      });
    } catch (err) {
      // Spawn-level failure (kubectl not on PATH, kubeconfig resolution
      // threw, ...). Convert to a denied observation rather than letting
      // the error escape to the agent — the agent has nothing actionable
      // it can do with a thrown error here.
      const message = err instanceof Error ? err.message : String(err);
      return {
        decision: 'denied',
        observation: `kubectl execution failed: ${message}`,
      };
    }

        return {
          decision: mode === 'read' ? 'read' : 'executed',
          observation: formatKubectlObservation(mode, command, {
            exitCode: result.success ? 0 : 1,
            stdout: typeof result.output === 'string' ? result.output : '',
            stderr: result.error ?? '',
          }),
    };
  }

  private async resolveKubeconfig(
    connector: OpsConnector,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    if (connector.secret) return { ok: true, value: connector.secret };
    if (!connector.secretRef) {
      return {
        ok: false,
        error: `Ops connector "${connector.id}" is not connected: no credential secret or secretRef is configured.`,
      };
    }
    try {
      const value = await this.secretResolver.resolve(connector.secretRef);
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        error: `Command was not executed because secretRef could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

export function classifyOpsCommand(
  command: string,
  allowedNamespaces: readonly string[] = [],
): { decision: OpsCommandDecision; reason: string } {
  const policy = classifyKubectlCommand(command, allowedNamespaces);
  return { decision: policy.decision, reason: policy.reason };
}

function formatKubectlObservation(
  mode: KubectlMode,
  command: string,
  result: { exitCode: number; stdout: string; stderr: string },
): string {
  const stdout = truncate(result.stdout.trim(), 12_000);
  const stderr = truncate(result.stderr.trim(), 4_000);
  const label = mode === 'read' ? 'read' : 'approved command';
  if (result.exitCode === 0) {
    return stdout
      ? `kubectl ${label} succeeded: ${command}\n\n${stdout}`
      : `kubectl ${label} succeeded: ${command}\n\n(no output)`;
  }
  return `kubectl ${label} failed with exit code ${result.exitCode}: ${command}\n\n${stderr || stdout || 'no output'}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... truncated ...`;
}
