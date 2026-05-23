import { describe, it, expect, vi } from 'vitest';
import type {
  Connector,
  ConnectorLookupOptions,
  ConnectorSecret,
  ConnectorTeamPolicy,
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
  policies?: ConnectorTeamPolicy[];
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

function readPolicy(connectorId: string, capability: string, agent: ConnectorTeamPolicy['agentPolicy']): ConnectorTeamPolicy {
  return {
    connectorId,
    teamId: '',
    capability,
    scope: null,
    humanPolicy: 'allow',
    agentPolicy: agent,
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
      policies: [readPolicy('kube-prod', 'runtime.get', 'allow')],
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

describe('KubectlOpsCommandRunner.runCommand — policy-table bypass', () => {
  // The per-capability per-team policy gate was retired (ops-trust-model
  // v4). The runner no longer queries `listPolicies` or resolves an
  // effective `agentPolicy`. Authority is: kubeconfig RBAC (real auth) +
  // pattern-based confirmation gate (`shellCommandNeedsConfirmation` on
  // the command string).
  //
  // These tests pin the contract: the runner reaches the shell adapter
  // regardless of any policy rows that might still exist in the DB.
  const identity = {
    userId: 'u1',
    orgId: 'org_a',
    orgRole: 'Admin' as const,
    isServerAdmin: false,
    authenticatedBy: 'session' as const,
  };

  function mkRunner(policies: ConnectorTeamPolicy[]): {
    runner: KubectlOpsCommandRunner;
    listPoliciesCalls: ConnectorTeamPolicy[][];
  } {
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
    const repo = fakeConnectorRepo(state);
    // Wrap listPolicies so tests can assert the shim doesn't consult it.
    const listPoliciesCalls: ConnectorTeamPolicy[][] = [];
    const origListPolicies = repo.listPolicies.bind(repo);
    repo.listPolicies = (async (opts: { connectorId: string; capability?: string }) => {
      const rows = await origListPolicies(opts);
      listPoliciesCalls.push(rows);
      return rows;
    }) as typeof repo.listPolicies;
    const runner = new KubectlOpsCommandRunner({
      connectors: repo,
      orgId: 'org_a',
    });
    return { runner, listPoliciesCalls };
  }

  it('does NOT consult the policy table (always-allow shim)', async () => {
    const { runner, listPoliciesCalls } = mkRunner([
      readPolicy('kube-prod', 'runtime.apply', 'deny'),
    ]);
    // Issue a kubectl call that under the old gate would have been denied.
    // We expect the runner to bypass the policy lookup entirely and reach
    // the adapter (which then complains about a different layer — the
    // missing --namespace on apply -f -).
    await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl apply -f -',
      intent: 'execute_approved',
      identity,
      sessionId: 's1',
    });
    expect(listPoliciesCalls).toHaveLength(0);
  });

  it('reaches the kubectl adapter even when policy rows would have denied', async () => {
    const { runner } = mkRunner([
      readPolicy('kube-prod', 'runtime.apply', 'deny'),
    ]);
    const r = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl apply -f -',
      intent: 'execute_approved',
      identity,
      sessionId: 's1',
    });
    // The observation now comes from the adapter (apply needs a namespace),
    // not from a synthesized "denied by policy" string.
    expect(r.observation).not.toContain('denied by policy');
    expect(r.observation).not.toContain('formal approval');
    expect(r.observation).not.toContain('user review');
  });

  it('reaches the kubectl adapter when no policy rows exist', async () => {
    const { runner } = mkRunner([]);
    const r = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl apply -f -',
      intent: 'execute_approved',
      identity,
      sessionId: 's1',
    });
    expect(r.observation).not.toContain('denied by policy');
  });

  it('treats unknown kubectl verbs as confirmation-required instead of hard-refusing', async () => {
    const { runner } = mkRunner([]);
    // Pattern classifier marks `kubectl <unknown-verb>` as medium risk
    // (kubectl mentioned, no read-verb match), which surfaces a Yes/No
    // card rather than the old "no mapped capability" refusal. We assert
    // the new flow by capturing the confirmation and rejecting it so the
    // call returns instead of blocking on user input.
    let captured: OpsCommandConfirmation | undefined;
    const pending = runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl frobnicate',
      intent: 'read',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (c) => { captured = c; },
    });
    // Give the runner one microtask tick to emit the confirmation, then
    // reject so the awaiting Promise unblocks.
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toBeDefined();
    if (captured) resolveOpsCommandConfirmation(captured.id, 'rejected');
    const r = await pending;
    expect(r.observation).not.toContain('no mapped capability');
    expect(r.observation).toContain('rejected');
  });
});
