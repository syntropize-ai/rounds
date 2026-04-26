import type { Identity } from '@agentic-obs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

    const policy = classifyOpsCommand(params.command);
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

    return this.runKubectlCommand(connector, params.command);
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

    const policy = classifyOpsCommand(command);
    if (policy.decision === 'denied') {
      return {
        approvalId,
        decision: 'denied',
        observation: `Denied by Ops command policy: ${policy.reason}.`,
      };
    }

    const result = await this.runKubectlCommand(connector, command);
    return {
      approvalId,
      decision: result.decision === 'denied' ? 'denied' : 'executed',
      observation: `Approved by ${identity.userId}; ${result.observation}`,
    };
  }

  private async runKubectlCommand(
    connector: OpsConnector,
    command: string,
  ): Promise<{ observation: string; decision: OpsCommandDecision }> {
    const kubeconfig = await this.resolveKubeconfig(connector);
    if (!kubeconfig.ok) {
      return {
        decision: 'denied',
        observation: kubeconfig.error,
      };
    }
    if (!looksLikeKubeconfig(kubeconfig.value)) {
      return {
        decision: 'denied',
        observation:
          'Command was not executed because only kubeconfig credentials are supported for live kubectl execution in this build.',
      };
    }

    const namespaceError = validateNamespacePolicy(command, connector.allowedNamespaces);
    if (namespaceError) {
      return { decision: 'denied', observation: namespaceError };
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'openobs-kube-'));
    const kubeconfigPath = join(tempDir, 'config');
    try {
      await writeFile(kubeconfigPath, kubeconfig.value, { encoding: 'utf8', mode: 0o600 });
      const args = tokenizeKubectlCommand(command).slice(1);
      const result = await runKubectl(args, kubeconfigPath);
      return {
        decision: 'read',
        observation: formatKubectlObservation(command, result),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

export function classifyOpsCommand(command: string): { decision: OpsCommandDecision; reason: string } {
  const normalized = command.trim().replace(/\s+/g, ' ');
  const lower = normalized.toLowerCase();

  if (!lower.startsWith('kubectl ')) {
    return { decision: 'denied', reason: 'only kubectl commands are supported for Kubernetes connectors' };
  }

  const deniedPatterns = [
    /^kubectl\s+exec\b/,
    /^kubectl\s+cp\b/,
    /^kubectl\s+port-forward\b/,
    /^kubectl\s+proxy\b/,
    /^kubectl\s+edit\b/,
    /^kubectl\s+(get|describe)\s+secrets?\b/,
    /^kubectl\s+delete\s+secrets?\b/,
  ];
  if (deniedPatterns.some((pattern) => pattern.test(lower))) {
    return { decision: 'denied', reason: 'command can expose secrets or open an interactive/network tunnel' };
  }

  const readPatterns = [
    /^kubectl\s+get\b/,
    /^kubectl\s+describe\b/,
    /^kubectl\s+logs\b/,
    /^kubectl\s+top\b/,
    /^kubectl\s+rollout\s+(status|history)\b/,
    /^kubectl\s+events\b/,
    /^kubectl\s+api-(resources|versions)\b/,
    /^kubectl\s+version\b/,
    /^kubectl\s+config\s+current-context\b/,
  ];
  if (readPatterns.some((pattern) => pattern.test(lower))) {
    return { decision: 'read', reason: 'read-only inspection command' };
  }

  const mutatingPatterns = [
    /^kubectl\s+(apply|patch|scale|create|delete|replace|set|annotate|label)\b/,
    /^kubectl\s+rollout\s+(restart|undo|pause|resume)\b/,
    /^kubectl\s+(cordon|uncordon|drain|taint)\b/,
  ];
  if (mutatingPatterns.some((pattern) => pattern.test(lower))) {
    return { decision: 'approval_required', reason: 'mutating cluster command' };
  }

  return { decision: 'approval_required', reason: 'unclassified kubectl command must be reviewed' };
}

function looksLikeKubeconfig(secret: string): boolean {
  return /\bapiVersion\s*:/.test(secret) && /\bkind\s*:\s*Config\b/.test(secret);
}

function validateNamespacePolicy(command: string, allowedNamespaces: string[]): string | null {
  if (allowedNamespaces.length === 0) return null;
  const args = tokenizeKubectlCommand(command);
  const namespace = findNamespaceArg(args);
  if (!namespace) {
    return `Command was not executed: connector is restricted to namespaces ${allowedNamespaces.join(', ')}, so the command must include --namespace or -n.`;
  }
  if (!allowedNamespaces.includes(namespace)) {
    return `Command was not executed: namespace "${namespace}" is outside this connector's allowed namespaces (${allowedNamespaces.join(', ')}).`;
  }
  return null;
}

function findNamespaceArg(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-n' || arg === '--namespace') return args[i + 1] ?? null;
    if (arg?.startsWith('--namespace=')) return arg.slice('--namespace='.length);
  }
  return null;
}

function tokenizeKubectlCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function runKubectl(
  args: string[],
  kubeconfigPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('kubectl', ['--kubeconfig', kubeconfigPath, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      stderr += '\nkubectl command timed out after 15s';
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ exitCode: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function formatKubectlObservation(
  command: string,
  result: { exitCode: number; stdout: string; stderr: string },
): string {
  const stdout = truncate(result.stdout.trim(), 12_000);
  const stderr = truncate(result.stderr.trim(), 4_000);
  if (result.exitCode === 0) {
    return stdout
      ? `kubectl read command succeeded: ${command}\n\n${stdout}`
      : `kubectl read command succeeded: ${command}\n\n(no output)`;
  }
  return `kubectl read command failed with exit code ${result.exitCode}: ${command}\n\n${stderr || stdout || 'no output'}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... truncated ...`;
}
