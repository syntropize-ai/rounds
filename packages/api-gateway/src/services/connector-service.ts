import { randomUUID } from 'node:crypto';
import type {
  Connector,
  ConnectorAgentPolicy,
  ConnectorHumanPolicy,
  ConnectorPatch,
  ConnectorStatus,
  ConnectorTeamPolicy,
  ConnectorType,
  NewConnector,
  UpsertConnectorTeamPolicy,
} from '@agentic-obs/common';

export type { Connector, ConnectorPatch, ConnectorStatus, NewConnector };
export type ConnectorPolicy = ConnectorTeamPolicy;

export interface ConnectorListFilter {
  orgId: string;
  category?: string;
  capability?: string;
  status?: ConnectorStatus;
  masked?: boolean;
}

export interface ConnectorRepository {
  list(filter: ConnectorListFilter): Promise<Connector[]>;
  get(id: string, opts: { orgId: string }): Promise<Connector | null>;
  create(input: NewConnector): Promise<Connector>;
  update(id: string, patch: ConnectorPatch, orgId: string): Promise<Connector | null>;
  delete(id: string, orgId: string): Promise<boolean>;
  test?(orgId: string, id: string): Promise<ConnectorTestResult>;
  upsertSecret?(input: { connectorId: string; ciphertext: Uint8Array; keyVersion: number }): Promise<unknown>;
  listPolicies?(opts: { connectorId: string }): Promise<ConnectorPolicy[]>;
  upsertPolicy?(policy: UpsertConnectorTeamPolicy): Promise<ConnectorPolicy>;
  deletePolicy?(connectorId: string, teamId: string, capability: string): Promise<boolean>;
}

export interface ConnectorSecretStore {
  put(connectorId: string, orgId: string, plaintext: string): Promise<void>;
}

export interface ConnectorPolicyRepository {
  list(connectorId: string, orgId: string): Promise<ConnectorPolicy[]>;
  upsert(policy: ConnectorPolicy & { orgId: string }): Promise<ConnectorPolicy>;
  delete(connectorId: string, orgId: string, teamId: string, capability: string): Promise<boolean>;
  isAllowed(input: {
    actorUserId?: string;
    orgId: string;
    connectorId: string;
    capability: string;
    scope?: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface ConnectorTestResult {
  ok: boolean;
  latencyMs?: number;
  capabilities?: string[];
  error?: string;
}

export interface ConnectorServiceDeps {
  connectors: ConnectorRepository;
  secrets?: ConnectorSecretStore;
  policies?: ConnectorPolicyRepository;
  capabilitiesForType?: (type: string) => readonly string[];
  testConnector?: (connector: Connector) => Promise<ConnectorTestResult>;
}

export type ConnectorCreateInput = Omit<NewConnector, 'type'> & { type: string };

const DEFAULT_CAPABILITIES: Record<string, string[]> = {
  prometheus: ['metrics.discover', 'metrics.query', 'metrics.validate'],
  'victoria-metrics': ['metrics.discover', 'metrics.query', 'metrics.validate'],
  loki: ['logs.query', 'logs.stream'],
  elasticsearch: ['logs.query'],
  clickhouse: ['logs.query'],
  tempo: ['traces.query'],
  jaeger: ['traces.query'],
  otel: ['traces.query'],
  kubernetes: [
    'runtime.get',
    'runtime.list',
    'runtime.logs',
    'runtime.events',
    'runtime.restart',
    'runtime.scale',
    'runtime.rollout',
    'runtime.delete',
  ],
  github: ['vcs.repo.read', 'vcs.diff.read', 'vcs.pr.read', 'vcs.pr.comment', 'vcs.pr.create', 'change.event.read'],
};

export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDeps) {}

  list(filter: ConnectorListFilter): Promise<Connector[]> {
    return this.deps.connectors.list(filter);
  }

  get(orgId: string, id: string): Promise<Connector | null> {
    return this.deps.connectors.get(id, { orgId });
  }

  async create(input: ConnectorCreateInput): Promise<Connector> {
    return this.deps.connectors.create({
      ...input,
      id: input.id ?? randomUUID(),
      type: input.type as ConnectorType,
    });
  }

  update(orgId: string, id: string, patch: ConnectorPatch): Promise<Connector | null> {
    return this.deps.connectors.update(id, patch, orgId);
  }

  delete(orgId: string, id: string): Promise<boolean> {
    return this.deps.connectors.delete(id, orgId);
  }

  async test(orgId: string, id: string): Promise<ConnectorTestResult | null> {
    if (this.deps.connectors.test) return this.deps.connectors.test(orgId, id);
    const connector = await this.deps.connectors.get(id, { orgId });
    if (!connector) return null;
    if (!this.deps.testConnector) {
      return {
        ok: true,
        capabilities: this.capabilitiesForType(connector.type),
      };
    }
    return this.deps.testConnector(connector);
  }

  async putSecret(orgId: string, id: string, plaintext: string): Promise<boolean> {
    const connector = await this.deps.connectors.get(id, { orgId });
    if (!connector) return false;
    if (!this.deps.secrets && !this.deps.connectors.upsertSecret) {
      throw new Error('connector secret store is not wired');
    }
    if (this.deps.secrets) {
      await this.deps.secrets.put(id, orgId, plaintext);
    } else {
      await this.deps.connectors.upsertSecret!({
        connectorId: id,
        ciphertext: new TextEncoder().encode(plaintext),
        keyVersion: 1,
      });
    }
    return true;
  }

  async listPolicies(orgId: string, connectorId: string): Promise<ConnectorPolicy[] | null> {
    const connector = await this.deps.connectors.get(connectorId, { orgId });
    if (!connector) return null;
    if (!this.deps.policies && this.deps.connectors.listPolicies) {
      return this.deps.connectors.listPolicies({ connectorId });
    }
    if (!this.deps.policies) return [];
    return this.deps.policies.list(connectorId, orgId);
  }

  async upsertPolicy(
    orgId: string,
    policy: ConnectorPolicy,
  ): Promise<ConnectorPolicy | null> {
    const connector = await this.deps.connectors.get(policy.connectorId, { orgId });
    if (!connector) return null;
    if (!this.deps.policies && !this.deps.connectors.upsertPolicy) {
      throw new Error('connector policy repository is not wired');
    }
    if (this.deps.connectors.upsertPolicy && !this.deps.policies) {
      return this.deps.connectors.upsertPolicy({
        connectorId: policy.connectorId,
        teamId: policy.teamId,
        capability: policy.capability,
        scope: policy.scope,
        humanPolicy: policy.humanPolicy as ConnectorHumanPolicy,
        agentPolicy: policy.agentPolicy as ConnectorAgentPolicy,
      });
    }
    return this.deps.policies!.upsert({ ...policy, orgId });
  }

  async deletePolicy(
    orgId: string,
    connectorId: string,
    teamId: string,
    capability: string,
  ): Promise<boolean | null> {
    const connector = await this.deps.connectors.get(connectorId, { orgId });
    if (!connector) return null;
    if (this.deps.connectors.deletePolicy && !this.deps.policies) {
      return this.deps.connectors.deletePolicy(connectorId, teamId, capability);
    }
    if (!this.deps.policies) return false;
    return this.deps.policies.delete(connectorId, orgId, teamId, capability);
  }

  private capabilitiesForType(type: string): string[] {
    return [...(this.deps.capabilitiesForType?.(type) ?? DEFAULT_CAPABILITIES[type] ?? [])];
  }
}

export function isConnectorRepository(value: unknown): value is ConnectorRepository {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<Record<keyof ConnectorRepository, unknown>>;
  return (
    typeof maybe.list === 'function' &&
    typeof maybe.get === 'function' &&
    typeof maybe.create === 'function' &&
    typeof maybe.update === 'function' &&
    typeof maybe.delete === 'function'
  );
}
