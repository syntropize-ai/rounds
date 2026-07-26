import { describe, it, expect } from 'vitest';
import { isAgentReadSafeCommand } from './ops-command-runner.js';
import type {
  ConnectorPolicy,
  ListConnectorPoliciesOptions,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import {
  capabilityForShellCommand,
  resolveConnectorPolicy,
  templateDefaultPolicy,
} from './ops-policy.js';

function fakeRepo(policies: ConnectorPolicy[]): IConnectorRepository {
  return {
    list: async () => [],
    get: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    update: async () => null,
    delete: async () => false,
    count: async () => 0,
    findByCapability: async () => [],
    getSecret: async () => null,
    upsertSecret: async () => {
      throw new Error('not used');
    },
    deleteSecret: async () => false,
    listPolicies: async (opts: ListConnectorPoliciesOptions) =>
      policies.filter(
        (p) =>
          p.connectorId === opts.connectorId &&
          (opts.capability === undefined || p.capability === opts.capability),
      ),
    getPolicy: async () => null,
    upsertPolicy: async () => {
      throw new Error('not used');
    },
    deletePolicy: async () => false,
  };
}

function policy(
  subjectType: 'org' | 'team',
  subjectId: string,
  capability: string,
  human: ConnectorPolicy['humanPolicy'],
): ConnectorPolicy {
  return {
    connectorId: 'k1',
    subjectType,
    subjectId,
    capability,
    scope: null,
    humanPolicy: human,
  };
}

describe('capabilityForShellCommand', () => {
  it('maps kubectl read verbs to runtime.<verb>', () => {
    expect(capabilityForShellCommand('kubectl get pods')).toBe('runtime.get');
    expect(capabilityForShellCommand('kubectl list')).toBe('runtime.list');
    expect(capabilityForShellCommand('kubectl describe pod foo')).toBe(
      'runtime.describe',
    );
    expect(capabilityForShellCommand('kubectl logs foo')).toBe('runtime.logs');
  });

  it('maps write verbs', () => {
    expect(capabilityForShellCommand('kubectl delete pod foo')).toBe(
      'runtime.delete',
    );
    expect(capabilityForShellCommand('kubectl apply -f x.yaml')).toBe(
      'runtime.apply',
    );
    expect(capabilityForShellCommand('kubectl patch deploy foo -p ...')).toBe(
      'runtime.patch',
    );
    expect(capabilityForShellCommand('kubectl scale deploy foo --replicas=3')).toBe(
      'runtime.scale',
    );
  });

  it('picks the first kubectl verb from a piped command', () => {
    expect(
      capabilityForShellCommand('kubectl get pods -n default | grep nginx'),
    ).toBe('runtime.get');
  });

  it('collapses version/auth/config to runtime.get', () => {
    expect(capabilityForShellCommand('kubectl version --client')).toBe(
      'runtime.get',
    );
  });

  it('falls back to runtime.exec for non-kubectl commands', () => {
    expect(capabilityForShellCommand('jq . file.json')).toBe('runtime.exec');
    expect(capabilityForShellCommand('curl -s https://x.example.com')).toBe(
      'runtime.exec',
    );
    expect(capabilityForShellCommand('kubectl frobnicate')).toBe('runtime.exec');
  });
});

describe('resolveConnectorPolicy', () => {
  const base = {
    connectorId: 'k1',
    capability: 'runtime.get',
    orgId: 'org_a',
  };

  it('returns no-policy when no rows match', async () => {
    const decision = await resolveConnectorPolicy({
      connectorRepo: fakeRepo([]),
      ...base,
      userTeamIds: ['t1'],
    });
    expect(decision).toBe('no-policy');
  });

  it('falls back to the org row when no team row matches', async () => {
    const decision = await resolveConnectorPolicy({
      connectorRepo: fakeRepo([policy('org', 'org_a', 'runtime.get', 'ask')]),
      ...base,
      userTeamIds: ['t1'],
    });
    expect(decision).toBe('ask');
  });

  it('lets team-scope override org-scope', async () => {
    const rows = [
      policy('org', 'org_a', 'runtime.get', 'allow'),
      policy('team', 't1', 'runtime.get', 'block'),
    ];
    const decision = await resolveConnectorPolicy({
      connectorRepo: fakeRepo(rows),
      ...base,
      userTeamIds: ['t1'],
    });
    expect(decision).toBe('block');
  });

  it('deny-wins across multiple team memberships', async () => {
    const rows = [
      policy('team', 't1', 'runtime.get', 'allow'),
      policy('team', 't2', 'runtime.get', 'block'),
      policy('team', 't3', 'runtime.get', 'ask'),
    ];
    const decision = await resolveConnectorPolicy({
      connectorRepo: fakeRepo(rows),
      ...base,
      userTeamIds: ['t1', 't2', 't3'],
    });
    expect(decision).toBe('block');
  });

  it('ignores team rows whose subjectId is not in the caller team list', async () => {
    const rows = [
      policy('org', 'org_a', 'runtime.get', 'allow'),
      policy('team', 'other-team', 'runtime.get', 'block'),
    ];
    const decision = await resolveConnectorPolicy({
      connectorRepo: fakeRepo(rows),
      ...base,
      userTeamIds: ['t1'],
    });
    expect(decision).toBe('allow');
  });
});

describe('templateDefaultPolicy', () => {
  it('returns the seed default for known kubernetes capabilities', () => {
    expect(templateDefaultPolicy('kubernetes', 'runtime.get')).toBe('allow');
    expect(templateDefaultPolicy('kubernetes', 'runtime.apply')).toBe('ask');
    expect(templateDefaultPolicy('kubernetes', 'runtime.delete')).toBe('ask');
  });

  it('returns null for unknown capabilities', () => {
    expect(templateDefaultPolicy('kubernetes', 'runtime.unknown')).toBeNull();
  });

  it('returns null for non-kubernetes types', () => {
    expect(templateDefaultPolicy('prometheus', 'runtime.get')).toBeNull();
  });
});

/**
 * The read-only bypass skips the confirmation card. What it may skip is the
 * question.
 *
 * `classifyShellCommandRisk` assigns `medium` to any kubectl invocation whose
 * verb it does not recognise, and says why in a comment: "so an unfamiliar
 * kubectl subcommand still prompts". `isAgentReadSafeCommand` then returned
 * true for everything that was not critical or an unambiguous write — which
 * included that entire bucket. Two comments in one file, contradicting each
 * other, and the permissive one won.
 *
 * `readOnlyAgentBypass` is on for interactive chat and for background runs, so
 * this was the live path in both.
 */
describe('read-only bypass covers reads, not unrecognised verbs', () => {
  const bypassed = (c: string) => isAgentReadSafeCommand(c);

  it('still auto-approves genuine reads', () => {
    for (const c of ['kubectl get pods', 'kubectl describe pod x', 'kubectl logs -f pod/x', 'kubectl top nodes']) {
      expect(bypassed(c), c).toBe(true);
    }
  });

  it('still auto-approves exec and cp, which the interactive path is built on', () => {
    // These are `high`, not `medium`, and are deliberately absent from the
    // unambiguous-write list — inspecting a sidecar is the point.
    expect(bypassed('kubectl exec mypod -- ps aux')).toBe(true);
    expect(bypassed('kubectl cp ns/pod:/tmp/heap.out ./heap.out')).toBe(true);
  });

  it('stops silently running the verbs it does not recognise', () => {
    // None of these are obscure, and none of them are reads.
    expect(bypassed('kubectl proxy --address=0.0.0.0 --accept-hosts=.*'), 'unauthenticated API proxy').toBe(false);
    expect(bypassed('kubectl certificate approve my-csr'), 'issues cluster credentials').toBe(false);
    expect(bypassed('kubectl debug node/n1 -it --image=busybox'), 'root on a node').toBe(false);
    expect(bypassed('kubectl port-forward svc/db 5432:5432'), 'tunnel to the database').toBe(false);
    expect(bypassed('kubectl attach mypod -i'), 'interactive attach').toBe(false);
  });

  it('still refuses writes and destructive commands', () => {
    for (const c of ['kubectl apply -f x.yaml', 'kubectl delete pod x', 'kubectl drain node-1', 'rm -rf /data']) {
      expect(bypassed(c), c).toBe(false);
    }
  });
});
