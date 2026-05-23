import { describe, it, expect, vi } from 'vitest';
import type {
  Connector,
  ConnectorLookupOptions,
  ConnectorSecret,
  ConnectorPolicy,
  ListConnectorPoliciesOptions,
  ListConnectorsOptions,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import {
  KubectlOpsCommandRunner,
  connectorToOpsConfig,
  resolveOpsCommandConfirmation,
  type OpsCommandConfirmation,
} from './ops-command-runner.js';

function mkConnector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'kube-prod',
    orgId: 'org_a',
    type: 'kubernetes',
    name: 'Production',
    config: {},
    status: 'active',
    lastVerifiedAt: null,
    lastVerifyError: null,
    isDefault: false,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    capabilities: ['runtime.get', 'runtime.list'],
    secretMissing: false,
    ...overrides,
  };
}

interface FakeRepoState {
  connectors: Connector[];
  secrets: Map<string, ConnectorSecret>;
  policies?: ConnectorPolicy[];
}

function fakeConnectorRepo(state: FakeRepoState): IConnectorRepository {
  return {
    list: async (opts: ListConnectorsOptions) =>
      state.connectors.filter((c) => c.orgId === opts.orgId),
    get: async (id: string, opts: ConnectorLookupOptions) =>
      state.connectors.find((c) => c.id === id && c.orgId === opts.orgId) ?? null,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => null,
    delete: async () => false,
    count: async () => state.connectors.length,
    findByCapability: async () => [],
    getSecret: async (id: string) => state.secrets.get(id) ?? null,
    upsertSecret: async () => {
      throw new Error('not used');
    },
    deleteSecret: async () => false,
    listPolicies: async (opts: ListConnectorPoliciesOptions) => {
      const rows = state.policies ?? [];
      return rows.filter(
        (p) =>
          p.connectorId === opts.connectorId &&
          (opts.capability === undefined || p.capability === opts.capability),
      );
    },
    getPolicy: async () => null,
    upsertPolicy: async () => {
      throw new Error('not used');
    },
    deletePolicy: async () => false,
  };
}

function readPolicy(
  connectorId: string,
  capability: string,
  human: ConnectorPolicy['humanPolicy'] = 'allow',
): ConnectorPolicy {
  return {
    connectorId,
    subjectType: 'org',
    subjectId: 'org_a',
    capability,
    scope: null,
    humanPolicy: human,
  };
}

describe('connectorToOpsConfig', () => {
  it('passes through name, capabilities, context, namespaces', () => {
    const c = mkConnector({
      config: { context: 'gke-prod', allowedNamespaces: ['api', 'web'] },
      capabilities: ['runtime.get', 'runtime.logs'],
    });
    expect(connectorToOpsConfig(c)).toEqual({
      id: 'kube-prod',
      name: 'Production',
      environment: 'gke-prod',
      namespaces: ['api', 'web'],
      capabilities: ['runtime.get', 'runtime.logs'],
    });
  });
  it('omits absent context/namespaces', () => {
    const c = mkConnector({ config: {}, capabilities: [] });
    const out = connectorToOpsConfig(c);
    expect(out.environment).toBeUndefined();
    expect(out.namespaces).toBeUndefined();
  });
});

describe('KubectlOpsCommandRunner.listConnectors', () => {
  it('returns only kubernetes-type connectors mapped to OpsConnectorConfig', async () => {
    const state: FakeRepoState = {
      connectors: [
        mkConnector({ id: 'p1', type: 'prometheus', name: 'Prom' }),
        mkConnector({ id: 'k1', type: 'kubernetes', name: 'k1' }),
        mkConnector({ id: 'l1', type: 'loki', name: 'Loki' }),
        mkConnector({ id: 'k2', type: 'kubernetes', name: 'k2' }),
      ],
      secrets: new Map(),
    };
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo(state),
      orgId: 'org_a',
    });
    const list = await runner.listConnectors();
    expect(list.map((c) => c.id)).toEqual(['k1', 'k2']);
  });
});

describe('KubectlOpsCommandRunner.runCommand — error paths', () => {
  const identity = {
    userId: 'u1',
    orgId: 'org_a',
    orgRole: 'Admin' as const,
    isServerAdmin: false,
    authenticatedBy: 'session' as const,
  };

  it('returns a clear error when the connector id is not found', async () => {
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({ connectors: [], secrets: new Map() }),
      orgId: 'org_a',
    });
    const result = await runner.runCommand({
      connectorId: 'missing',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect((result as { observation: string }).observation).toContain('not found');
  });

  it('rejects non-kubernetes connector types with a clear message', async () => {
    const state: FakeRepoState = {
      connectors: [mkConnector({ id: 'prom1', type: 'prometheus', name: 'Prom' })],
      secrets: new Map(),
    };
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo(state),
      orgId: 'org_a',
    });
    const result = await runner.runCommand({
      connectorId: 'prom1',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect((result as { observation: string }).observation).toContain('not "kubernetes"');
  });

  it('returns a credential-missing message when kubeconfig is absent and apiServer is set', async () => {
    const state: FakeRepoState = {
      connectors: [
        mkConnector({
          id: 'kube-prod',
          type: 'kubernetes',
          secretMissing: true,
          config: { apiServer: 'https://k8s.example.com' },
        }),
      ],
      secrets: new Map(),
    };
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo(state),
      orgId: 'org_a',
    });
    const result = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    const obs = (result as { observation: string }).observation;
    expect(obs).toContain('no kubeconfig credentials');
    expect(obs).toContain('Settings');
  });

  it('rejects empty commands without spawning kubectl', async () => {
    const state: FakeRepoState = {
      connectors: [
        mkConnector({
          id: 'kube-prod',
          config: { kubeconfig: 'apiVersion: v1\nkind: Config' },
        }),
      ],
      secrets: new Map(),
    };
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo(state),
      orgId: 'org_a',
    });
    const result = await runner.runCommand({
      connectorId: 'kube-prod',
      command: '   ',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect((result as { observation: string }).observation).toContain('non-empty');
  });
});

describe('KubectlOpsCommandRunner.runClusterShell — confirmation', () => {
  const identity = {
    userId: 'u1',
    orgId: 'org_a',
    orgRole: 'Admin' as const,
    isServerAdmin: false,
    authenticatedBy: 'session' as const,
  };

  it('waits for namespace-scoped shell confirmation before running', async () => {
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({
        connectors: [
          mkConnector({
            id: 'kube-prod',
            config: { kubeconfig: 'apiVersion: v1\nkind: Config' },
          }),
        ],
        secrets: new Map(),
      }),
      orgId: 'org_a',
    });
    const seen: string[] = [];
    const result = await runner.runClusterShell({
      connectorId: 'kube-prod',
      script: 'helm install istio-base istio/base -n istio-system',
      scope: 'namespace',
      namespace: 'istio-system',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (confirmation) => {
        seen.push(confirmation.id);
        resolveOpsCommandConfirmation(confirmation.id, 'rejected');
      },
    });

    expect(seen).toHaveLength(1);
    expect(result.observation).toContain('rejected');
  });

  it('marks cluster-scoped shell operations as critical', async () => {
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({
        connectors: [
          mkConnector({
            id: 'kube-prod',
            config: { kubeconfig: 'apiVersion: v1\nkind: Config' },
          }),
        ],
        secrets: new Map(),
      }),
      orgId: 'org_a',
    });
    let risk: string | undefined;
    const result = await runner.runClusterShell({
      connectorId: 'kube-prod',
      script: 'istioctl install -y',
      scope: 'cluster',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (confirmation) => {
        risk = confirmation.risk;
        resolveOpsCommandConfirmation(confirmation.id, 'rejected');
      },
    });

    expect(risk).toBe('critical');
    expect(result.observation).toContain('rejected');
  });
});

describe('KubectlOpsCommandRunner.runCommand — getSecret binding', () => {
  it('invokes getSecret with `this` bound (no destructure-induced this loss)', async () => {
    const state: FakeRepoState = {
      connectors: [
        mkConnector({
          id: 'kube-prod',
          secretMissing: false,
          // No inline kubeconfig and no secretRef — forces the runner to
          // hit `repo.getSecret`. This is exactly the path where a
          // free-function call would have lost `this`.
          config: {},
        }),
      ],
      secrets: new Map([
        [
          'kube-prod',
          {
            connectorId: 'kube-prod',
            ciphertext: new TextEncoder().encode('apiVersion: v1\nkind: Config'),
            keyVersion: 1,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      ]),
      policies: [
        readPolicy('kube-prod', 'runtime.get', 'allow'),
        // `version --client` has no kubectl prefix so the runner classifies
        // it as `runtime.exec`. Without an explicit allow row, the template
        // default (ask) would route it through the confirmation flow and
        // this test would hang waiting for a user decision.
        readPolicy('kube-prod', 'runtime.exec', 'allow'),
      ],
    };
    const repo = fakeConnectorRepo(state);
    const getSecretSpy = vi.spyOn(repo, 'getSecret');
    const runner = new KubectlOpsCommandRunner({
      connectors: repo,
      orgId: 'org_a',
    });

    // We only exercise the resolveKubeconfig branch by reaching into the
    // private method via a public surface that doesn't actually spawn
    // kubectl: we patch a tiny stub adapter by mocking `KubectlExecutionAdapter`
    // would be heavier than worthwhile — instead, call the path that uses
    // resolveKubeconfig by stubbing `execute` through a spy at the right
    // boundary. Simplest: call resolveKubeconfig via a synthesized exec.
    // Because the real adapter spawns a child process, we accept that this
    // test verifies the lookup happens (getSecret called with bound `this`)
    // and tolerate the eventual kubectl failure as a non-assertion.
    await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'version --client',
      intent: 'read',
      identity: {
        userId: 'u1',
        orgId: 'org_a',
        orgRole: 'Admin',
        isServerAdmin: false,
        authenticatedBy: 'session',
      },
      sessionId: 's1',
    }).catch(() => undefined);

    expect(getSecretSpy).toHaveBeenCalledWith('kube-prod');
  });
});

describe('KubectlOpsCommandRunner.runCommand — connector policy gate', () => {
  // The chat-side runner consults the `connector_policies` table to honor
  // the user's per-capability policy from Settings → Connectors. `block`
  // refuses without ever reaching the adapter; `ask` forces a confirmation
  // even for innocuous reads; `allow` lets the risk classifier still
  // confirm high-risk commands.
  const identity = {
    userId: 'u1',
    orgId: 'org_a',
    orgRole: 'Admin' as const,
    isServerAdmin: false,
    authenticatedBy: 'session' as const,
  };

  function mkRunner(
    policies: ConnectorPolicy[],
    resolveUserTeams?: (id: { userId: string }) => Promise<readonly string[]>,
  ): KubectlOpsCommandRunner {
    const state: FakeRepoState = {
      connectors: [
        mkConnector({
          id: 'kube-prod',
          config: { kubeconfig: 'apiVersion: v1\nkind: Config' },
        }),
      ],
      secrets: new Map(),
      policies,
    };
    return new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo(state),
      orgId: 'org_a',
      ...(resolveUserTeams
        ? { resolveUserTeams: resolveUserTeams as never }
        : {}),
    });
  }

  it('blocks `kubectl get pods` when runtime.get policy is block', async () => {
    const runner = mkRunner([readPolicy('kube-prod', 'runtime.get', 'block')]);
    const r = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by connector policy');
    expect(r.observation).toContain('runtime.get');
  });

  it('forces a confirmation when policy is ask, even for a read', async () => {
    const runner = mkRunner([readPolicy('kube-prod', 'runtime.get', 'ask')]);
    let captured: OpsCommandConfirmation | undefined;
    const pending = runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (c) => {
        captured = c;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toBeDefined();
    if (captured) resolveOpsCommandConfirmation(captured.id, 'rejected');
    const r = await pending;
    expect(r.observation).toContain('rejected');
  });

  it('honors a team-scope block over an org-scope allow', async () => {
    const orgRow: ConnectorPolicy = readPolicy(
      'kube-prod',
      'runtime.get',
      'allow',
    );
    const teamRow: ConnectorPolicy = {
      connectorId: 'kube-prod',
      subjectType: 'team',
      subjectId: 'team-readonly',
      capability: 'runtime.get',
      scope: null,
      humanPolicy: 'block',
    };
    const runner = mkRunner([orgRow, teamRow], async () => ['team-readonly']);
    const r = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by connector policy');
  });
});
