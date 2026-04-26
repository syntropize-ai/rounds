import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IApprovalRequestRepository, IOpsConnectorRepository, OpsConnector } from '@agentic-obs/data-layer';
import { OpsCommandRunnerService, classifyOpsCommand } from './ops-command-runner-service.js';

const baseConnector: OpsConnector = {
  id: 'k8s-prod',
  orgId: 'org_a',
  type: 'kubernetes',
  name: 'Production',
  environment: 'prod',
  config: { clusterName: 'prod' },
  secretRef: 'vault://k8s/prod',
  secret: null,
  allowedNamespaces: ['default'],
  capabilities: ['read', 'propose'],
  status: 'connected',
  lastCheckedAt: null,
  createdAt: 'now',
  updatedAt: 'now',
};

function identity() {
  return {
    userId: 'u_1',
    orgId: 'org_a',
    orgRole: 'Admin',
    isServerAdmin: false,
    authenticatedBy: 'session',
  } as const;
}

describe('classifyOpsCommand', () => {
  it('allows read-only kubectl inspection commands', () => {
    expect(classifyOpsCommand('kubectl get pods -n api').decision).toBe('read');
    expect(classifyOpsCommand('kubectl rollout status deployment/api').decision).toBe('read');
  });

  it('requires approval for mutating commands and denies dangerous commands', () => {
    expect(classifyOpsCommand('kubectl rollout restart deployment/api').decision).toBe('approval_required');
    expect(classifyOpsCommand('kubectl exec -it pod/api -- sh').decision).toBe('denied');
    expect(classifyOpsCommand('kubectl get secret prod -o yaml').decision).toBe('denied');
  });
});

describe('OpsCommandRunnerService', () => {
  let connectors: IOpsConnectorRepository;
  let approvals: IApprovalRequestRepository;

  beforeEach(() => {
    connectors = {
      listByOrg: vi.fn(async () => [baseConnector]),
      findByIdInOrg: vi.fn(async (_orgId, id) => id === baseConnector.id ? baseConnector : null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    approvals = {
      submit: vi.fn(async (params) => ({
        id: 'approval-1',
        action: params.action,
        context: params.context,
        status: 'pending' as const,
        createdAt: 'now',
        expiresAt: 'later',
      })),
      findById: vi.fn(),
      listPending: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      override: vi.fn(),
    };
  });

  it('lists configured connectors for the current org', async () => {
    const service = new OpsCommandRunnerService({ connectors, approvals }, 'org_a');
    await expect(service.listConnectors()).resolves.toEqual([
      {
        id: 'k8s-prod',
        name: 'Production',
        environment: 'prod',
        namespaces: ['default'],
        capabilities: ['read', 'propose'],
      },
    ]);
    expect(connectors.listByOrg).toHaveBeenCalledWith('org_a', { masked: true });
  });

  it('uses the existing approvals repository for mutating command proposals', async () => {
    const service = new OpsCommandRunnerService({ connectors, approvals }, 'org_a');
    const result = await service.runCommand({
      connectorId: 'k8s-prod',
      command: 'kubectl rollout restart deployment/api -n default',
      intent: 'propose',
      identity: identity(),
      sessionId: 'session-1',
    });

    expect(result.decision).toBe('approval_required');
    expect(result.approvalId).toBe('approval-1');
    expect(approvals.submit).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({
        type: 'ops.run_command',
        params: expect.objectContaining({ connectorId: 'k8s-prod' }),
      }),
    }));
  });

  it('requires an approved existing approval record before execution', async () => {
    approvals.findById = vi.fn(async () => ({
      id: 'approval-1',
      action: {
        type: 'ops.run_command',
        targetService: 'Production',
        params: {
          connectorId: 'k8s-prod',
          command: 'kubectl rollout restart deployment/api -n default',
        },
      },
      context: { requestedBy: 'u_1', reason: 'restart api' },
      status: 'pending' as const,
      createdAt: 'now',
      expiresAt: 'later',
    }));
    const service = new OpsCommandRunnerService({ connectors, approvals }, 'org_a');

    const result = await service.executeApprovedApproval('approval-1', identity());

    expect(result.decision).toBe('denied');
    expect(result.observation).toContain('is pending');
  });

  it('requires connector execute_approved capability for approved execution', async () => {
    approvals.findById = vi.fn(async () => ({
      id: 'approval-1',
      action: {
        type: 'ops.run_command',
        targetService: 'Production',
        params: {
          connectorId: 'k8s-prod',
          command: 'kubectl rollout restart deployment/api -n default',
        },
      },
      context: { requestedBy: 'u_1', reason: 'restart api' },
      status: 'approved' as const,
      createdAt: 'now',
      expiresAt: 'later',
    }));
    const service = new OpsCommandRunnerService({ connectors, approvals }, 'org_a');

    const result = await service.executeApprovedApproval('approval-1', identity());

    expect(result.decision).toBe('denied');
    expect(result.observation).toContain('does not allow execute_approved');
  });

  it('uses the injected secretRef resolver when connector credentials are external', async () => {
    const service = new OpsCommandRunnerService({
      connectors,
      approvals,
      secretResolver: {
        resolve: vi.fn(async () => 'apiVersion: v1\nkind: Config\n'),
      },
    }, 'org_a');

    const result = await service.runCommand({
      connectorId: 'k8s-prod',
      command: 'kubectl get pods -n default',
      intent: 'read',
      identity: identity(),
      sessionId: 'session-1',
    });

    expect(result.observation).not.toContain('cannot resolve secretRef');
  });
});
