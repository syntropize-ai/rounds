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
  checkShellCommandAllowlist,
  connectorToOpsConfig,
  isAgentReadSafeCommand,
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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
      commandPolicy: { mode: 'write' },
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

  it('background bypass skips confirmation for read-safe runtime.exec when policy is allow', async () => {
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({
        connectors: [
          mkConnector({
            id: 'kube-prod',
            config: { kubeconfig: 'apiVersion: v1\nkind: Config' },
          }),
        ],
        secrets: new Map(),
        policies: [readPolicy('kube-prod', 'runtime.exec', 'allow')],
      }),
      orgId: 'org_a',
      commandPolicy: { mode: 'write' },
      readOnlyAgentBypass: true,
    });
    let captured: OpsCommandConfirmation | undefined;
    await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl exec pod-a -- ps aux',
      intent: 'read',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (c) => {
        captured = c;
      },
    });
    expect(captured).toBeUndefined();
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

describe('isAgentReadSafeCommand — background investigation bypass classifier', () => {
  // Pairs with KubectlOpsCommandRunner.readOnlyAgentBypass. The runner skips
  // the confirmation card for commands this classifier flags as read-safe
  // BY SURFACE SHAPE — agent honesty about inner intent is the prompt's job.
  // The cases below pin down "what does 'read-safe' mean to the runner".

  it('flags `kubectl exec` as read-safe — agent contract limits inner cmds', () => {
    // The whole point of the bypass: investigation agents need exec to look
    // inside sidecars (`ps`, `netstat`, dump envoy admin). The classifier
    // can't parse the inner command, so it trusts the prompt contract here.
    expect(isAgentReadSafeCommand('kubectl exec pod-a -- ps aux')).toBe(true);
    expect(isAgentReadSafeCommand('kubectl exec -n default pod-a -c istio-proxy -- curl http://localhost:15000/config_dump')).toBe(true);
  });

  it('flags non-kubectl reads (curl / jq / grep chains) as read-safe', () => {
    expect(isAgentReadSafeCommand('curl http://prometheus:9090/api/v1/query?query=up')).toBe(true);
    expect(isAgentReadSafeCommand('kubectl get pods -o json | jq ".items[].metadata.name"')).toBe(true);
  });

  it('flags `kubectl get/describe/logs/top` as read-safe (already low-risk)', () => {
    expect(isAgentReadSafeCommand('kubectl get pods')).toBe(true);
    expect(isAgentReadSafeCommand('kubectl describe pod foo')).toBe(true);
    expect(isAgentReadSafeCommand('kubectl logs foo --tail=200')).toBe(true);
    expect(isAgentReadSafeCommand('kubectl top pods')).toBe(true);
  });

  it('refuses `kubectl delete/drain` — critical risk, always confirms', () => {
    expect(isAgentReadSafeCommand('kubectl delete pod foo')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl drain node-1')).toBe(false);
  });

  it('refuses destructive shell verbs (rm / mkfs / redirect to /)', () => {
    expect(isAgentReadSafeCommand('rm -rf /tmp/data')).toBe(false);
    expect(isAgentReadSafeCommand('mkfs.ext4 /dev/sdb1')).toBe(false);
    expect(isAgentReadSafeCommand('echo bad > /etc/hosts')).toBe(false);
  });

  it('refuses explicit kubectl write verbs (apply / create / patch / scale / rollout / …)', () => {
    // These are the writes the agent should propose via remediation_plan_create
    // rather than execute directly. Even with bypass on, the runner forces
    // the operator to approve them.
    expect(isAgentReadSafeCommand('kubectl apply -f manifest.yaml')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl create deployment foo --image=nginx')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl patch deployment foo -p \'{"spec":{"replicas":3}}\'')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl scale deployment foo --replicas=5')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl rollout restart deployment foo')).toBe(false);
    expect(isAgentReadSafeCommand('kubectl label pod foo team=infra')).toBe(false);
  });

  it('catches writes hidden in command chains', () => {
    // The agent could try to sneak a write past the surface check by
    // bundling it with a read. The regex matches on substring, so `apply`
    // anywhere in the chain still flags.
    expect(
      isAgentReadSafeCommand('kubectl get pods && kubectl apply -f bad.yaml'),
    ).toBe(false);
    expect(
      isAgentReadSafeCommand('kubectl get cm | xargs -I{} kubectl delete cm {}'),
    ).toBe(false);
  });
});

describe('resolveOpsCommandConfirmation — approver attribution', () => {
  // Pairs with the /execute and /reject HTTP endpoints. The approver field is
  // the audit trail's "who actually executed this" — "who approved = who
  // executed" per the audit contract. Tests below pin the data shape so a
  // refactor can't silently drop attribution.

  // Imported lazily so the helper module remains under test isolation.
  const id = 'test-confirmation';
  function seedConfirmation(): void {
    // Reach into the module via createConfirmation? Not exported. Use the
    // runner end-to-end pattern: spawn a confirmation through the runner,
    // capture its id, then resolve via the exported helper.
  }
  void seedConfirmation;

  it('stamps approvedByUserId and approvedAt when an approver is supplied', async () => {
    // Drive a real confirmation through the runner so we exercise the same
    // code path as production (avoids reaching into private maps).
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
      commandPolicy: { mode: 'write' },
    });
    let captured: OpsCommandConfirmation | undefined;
    const pending = runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl exec foo -- ps aux', // forces confirmation
      intent: 'read',
      identity: {
        userId: 'agent-sa',
        orgId: 'org_a',
        orgRole: 'Editor' as const,
        isServerAdmin: false,
        authenticatedBy: 'api_key' as const,
      },
      sessionId: 's1',
      onConfirmationRequired: (c) => {
        captured = c;
        // Simulate the /execute endpoint: approver = human "operator-bob".
        resolveOpsCommandConfirmation(c.id, 'rejected', { userId: 'operator-bob' });
      },
    });
    const r = await pending;
    expect(r.observation).toContain('rejected');
    expect(captured).toBeDefined();
    if (!captured) return;
    expect(captured.capability).toBe('runtime.exec');
    // Confirmation row preserves the approver + timestamp.
    expect(captured.approvedByUserId).toBe('operator-bob');
    expect(captured.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(captured.userId).toBe('agent-sa'); // proposer untouched
  });
  void id;
});

describe('runCommand — onResolved resolution callback', () => {
  it('fires onResolved with the settled status when a shown confirmation is rejected', async () => {
    const runner = new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({
        connectors: [
          mkConnector({ id: 'kube-prod', config: { kubeconfig: 'apiVersion: v1\nkind: Config' } }),
        ],
        secrets: new Map(),
      }),
      orgId: 'org_a',
      commandPolicy: { mode: 'write' },
    });
    const resolutions: Array<{ id: string; status: string; output?: string }> = [];
    const pending = runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl exec foo -- ps aux', // forces confirmation
      intent: 'read',
      identity: {
        userId: 'agent-sa',
        orgId: 'org_a',
        orgRole: 'Editor' as const,
        isServerAdmin: false,
        authenticatedBy: 'api_key' as const,
      },
      sessionId: 's1',
      onConfirmationRequired: (c) => resolveOpsCommandConfirmation(c.id, 'rejected'),
      onResolved: (r) => resolutions.push(r),
    });
    const r = await pending;

    expect(r.success).toBe(false);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.status).toBe('rejected');
  });
});

describe('KubectlOpsCommandRunner — kubectl allowlist gate', () => {
  // The allowlist (`checkKubectl` verbs + the connector's allowedNamespaces)
  // used to be enforced only by the plan executor's KubectlExecutionAdapter.
  // The chat and background paths run through this runner, which shells out
  // to `sh -c`, and had no argv/namespace gate at all. The gate now lives in
  // the runner itself and the policy is a required dependency, so no call
  // site can skip it.
  const identity = {
    userId: 'u1',
    orgId: 'org_a',
    orgRole: 'Admin' as const,
    isServerAdmin: false,
    authenticatedBy: 'session' as const,
  };

  function mkRunner(mode: 'read' | 'write'): KubectlOpsCommandRunner {
    return new KubectlOpsCommandRunner({
      connectors: fakeConnectorRepo({
        connectors: [
          mkConnector({
            id: 'kube-prod',
            config: {
              kubeconfig: 'apiVersion: v1\nkind: Config',
              allowedNamespaces: ['api', 'web'],
            },
          }),
        ],
        secrets: new Map(),
        // Explicit allows so nothing below stalls on a confirmation card —
        // the assertions are about the allowlist, not the policy table.
        policies: [
          readPolicy('kube-prod', 'runtime.get', 'allow'),
          readPolicy('kube-prod', 'runtime.exec', 'allow'),
          readPolicy('kube-prod', 'runtime.scale', 'allow'),
          readPolicy('kube-prod', 'runtime.delete', 'allow'),
        ],
      }),
      orgId: 'org_a',
      commandPolicy: { mode },
    });
  }

  it('throws when constructed without a command policy', () => {
    expect(
      () =>
        new KubectlOpsCommandRunner({
          connectors: fakeConnectorRepo({ connectors: [], secrets: new Map() }),
          orgId: 'org_a',
        } as unknown as ConstructorParameters<typeof KubectlOpsCommandRunner>[0]),
    ).toThrow(/requires commandPolicy\.mode/);
  });

  it('throws when the command policy mode is not read or write', () => {
    expect(
      () =>
        new KubectlOpsCommandRunner({
          connectors: fakeConnectorRepo({ connectors: [], secrets: new Map() }),
          orgId: 'org_a',
          commandPolicy: { mode: 'anything' },
        } as unknown as ConstructorParameters<typeof KubectlOpsCommandRunner>[0]),
    ).toThrow(/requires commandPolicy\.mode/);
  });

  it('denies a chat-path command targeting a namespace outside allowedNamespaces', async () => {
    const r = await mkRunner('write').runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get pods -n kube-system',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
    expect(r.observation).toContain("namespace 'kube-system'");
  });

  it('denies a chat-path exec into a namespace outside allowedNamespaces', async () => {
    const r = await mkRunner('write').runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl exec -n kube-system etcd-0 -- cat /etc/passwd',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain("namespace 'kube-system'");
  });

  it('denies a background-agent kubectl exec even inside an allowed namespace', async () => {
    // `kubectl exec … -- cat /var/run/secrets/…/token` reads a service-account
    // token exactly as `kubectl get secret` does. On the unattended path there
    // is no confirmation card to catch it (readOnlyAgentBypass opens the gate
    // for read-shaped commands), so the exec/cp exemption is chat-only.
    const r = await mkRunner('read').runCommand({
      connectorId: 'kube-prod',
      command:
        'kubectl exec -n api api-0 -- cat /var/run/secrets/kubernetes.io/serviceaccount/token',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
    expect(r.observation).toContain("kubectl verb 'exec' is permanently denied");
  });

  it('denies a chat-path kubectl spelled with an absolute path', async () => {
    const r = await mkRunner('write').runCommand({
      connectorId: 'kube-prod',
      command: '/usr/bin/kubectl get secret db-creds -n api -o yaml',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
    expect(r.observation).toContain('secret reads are denied');
  });

  it('denies a background-agent command outside the read argv allowlist', async () => {
    const r = await mkRunner('read').runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl scale deployment web -n api --replicas=0',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
    expect(r.observation).toContain('read-allowlist');
  });

  it('denies a kubectl write hidden behind a pipe', async () => {
    const r = await mkRunner('read').runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl get cm -n api -o name | xargs -I{} kubectl delete {} -n api',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
  });

  it('denies a kubectl invocation hidden in a command substitution', async () => {
    const r = await mkRunner('write').runCommand({
      connectorId: 'kube-prod',
      command: 'echo $(kubectl get secret db-creds -n api -o yaml)',
      intent: 'read',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('secret reads are denied');
  });

  it('lets an in-allowlist write through to the confirmation card', async () => {
    // Proves the gate does not over-deny: the command clears the allowlist
    // and reaches the confirmation flow, where a human decides.
    const runner = mkRunner('write');
    let captured: OpsCommandConfirmation | undefined;
    const r = await runner.runCommand({
      connectorId: 'kube-prod',
      command: 'kubectl scale deployment web -n api --replicas=3',
      intent: 'write',
      identity,
      sessionId: 's1',
      onConfirmationRequired: (c) => {
        captured = c;
        resolveOpsCommandConfirmation(c.id, 'rejected');
      },
    });
    expect(captured).toBeDefined();
    expect(r.observation).toContain('rejected');
    expect(r.observation).not.toContain('allowlist');
  });

  it('denies a cluster shell targeting a namespace outside allowedNamespaces', async () => {
    const r = await mkRunner('write').runClusterShell({
      connectorId: 'kube-prod',
      script: 'helm upgrade --install foo ./chart',
      scope: 'namespace',
      namespace: 'kube-system',
      identity,
      sessionId: 's1',
    });
    expect(r.success).toBe(false);
    expect(r.observation).toContain('Blocked by the ops command allowlist');
    expect(r.observation).toContain("namespace 'kube-system'");
  });
});

describe('checkShellCommandAllowlist — shell tokenization edge cases', () => {
  // Direct unit tests for the gate the runner delegates to. The runner-level
  // tests above cover the wiring; these pin the tokenizer's own behaviour,
  // where both an under-block (a bypass) and an over-block (a false denial)
  // are bugs.
  const ns = ['api', 'web'];

  it('matches kubectl by basename, so an absolute path cannot skip the gate', () => {
    // Regression: matching the bare token `kubectl` let
    // `/usr/bin/kubectl get secret …` walk past the whole allowlist.
    for (const cmd of [
      '/usr/bin/kubectl get secret db-creds -n api -o yaml',
      './kubectl get secret db-creds -n api -o yaml',
    ]) {
      expect(checkShellCommandAllowlist(cmd, { mode: 'read' }, ns).allow).toBe(false);
      expect(checkShellCommandAllowlist(cmd, { mode: 'write' }, ns).allow).toBe(false);
    }
  });

  it('binds a path-spelled kubectl to the namespace allowlist too', () => {
    const d = checkShellCommandAllowlist(
      '/usr/local/bin/kubectl get pods -n kube-system',
      { mode: 'read' },
      ns,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("namespace 'kube-system'");
  });

  it('still catches a kubectl invocation handed to xargs', () => {
    const d = checkShellCommandAllowlist(
      'kubectl get cm -n api -o name | xargs -I{} kubectl delete {} -n api',
      { mode: 'read' },
      ns,
    );
    expect(d.allow).toBe(false);
  });

  it('does not deny a segment where kubectl is a literal argument', () => {
    // Regression: `checkKubectl([])` answers "empty kubectl argv", which the
    // gate reported as a denial — `ps aux | grep kubectl` was refused.
    expect(checkShellCommandAllowlist('ps aux | grep kubectl', { mode: 'read' }, ns))
      .toEqual({ allow: true });
    expect(checkShellCommandAllowlist('echo kubectl', { mode: 'read' }, ns))
      .toEqual({ allow: true });
  });

  it('exempts kubectl exec/cp on the chat path but not on the background path', () => {
    const exec = 'kubectl exec -n api api-0 -- cat /var/run/secrets/token';
    expect(checkShellCommandAllowlist(exec, { mode: 'write' }, ns)).toEqual({ allow: true });
    const denied = checkShellCommandAllowlist(exec, { mode: 'read' }, ns);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("kubectl verb 'exec' is permanently denied");
  });

  it('binds the chat-path exec/cp exemption to the namespace allowlist', () => {
    const d = checkShellCommandAllowlist(
      'kubectl cp kube-system/etcd-0:/etc/passwd ./p -n kube-system',
      { mode: 'write' },
      ns,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("namespace 'kube-system'");
  });

  it('allows an in-allowlist read', () => {
    expect(checkShellCommandAllowlist('kubectl get pods -n api', { mode: 'read' }, ns))
      .toEqual({ allow: true });
    expect(checkShellCommandAllowlist('curl http://prometheus:9090/-/healthy', { mode: 'read' }, ns))
      .toEqual({ allow: true });
  });
});

describe('checkShellCommandAllowlist — wrapper and operand bypasses', () => {
  // A review probe drove real commands through the gate and found three shapes
  // that walked straight past it. Each one is pinned below.
  const ns = ['api', 'web'];

  it('re-enters a shell wrapper instead of treating the body as one opaque token', () => {
    // `sh -c "<body>"` survives tokenization as a single token, so before this
    // the wrapper disabled the gate entirely for anything inside it.
    for (const cmd of [
      'sh -c "kubectl get secret db-creds -n kube-system -o yaml"',
      "bash -c 'kubectl delete deploy web -n kube-system'",
      '/bin/sh -c "kubectl get secret x -n api"',
    ]) {
      expect(checkShellCommandAllowlist(cmd, { mode: 'read' }, ns).allow).toBe(false);
    }
  });

  it('lets a wrapped command through when its body is genuinely allowed', () => {
    expect(checkShellCommandAllowlist('sh -c "kubectl get pods -n api"', { mode: 'read' }, ns))
      .toEqual({ allow: true });
  });

  it('reads the namespace out of a kubectl cp operand', () => {
    // `kubectl cp <ns>/<pod>:<path>` carries the namespace in the operand, not
    // in -n, so the allowlist saw no namespace and allowed the copy.
    const d = checkShellCommandAllowlist(
      'kubectl cp kube-system/etcd-0:/etc/kubernetes/pki/ca.key ./ca.key',
      { mode: 'write' },
      ns,
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('kube-system');

    expect(checkShellCommandAllowlist('kubectl cp api/mypod:/tmp/log ./log', { mode: 'write' }, ns))
      .toEqual({ allow: true });
  });

  it('denies a namespace-gated verb whose namespace cannot be determined', () => {
    // Failing open here was the shared root of both bypasses above.
    const d = checkShellCommandAllowlist('kubectl exec mypod -- ls', { mode: 'write' }, ns);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('must name a namespace');

    // A connector with no namespace restriction is unaffected.
    expect(checkShellCommandAllowlist('kubectl exec mypod -- ls', { mode: 'write' }, []))
      .toEqual({ allow: true });
  });
});
